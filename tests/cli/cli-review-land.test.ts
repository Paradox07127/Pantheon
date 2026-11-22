import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { review } from '../../apps/cli/src/review.js';

const requests: { method: string; url: string; body: string }[] = [];
let replies: { status: number; body: unknown }[] = [];
let server: http.Server;
let dataDir: string;
let repo: string;
let linked: string;
let detached: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });

const cli = (cwd: string, args: string[], answers: { status?: number; body: unknown }[]) => {
  requests.length = 0;
  replies = answers.map((answer) => ({ status: answer.status ?? 200, body: answer.body }));
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(
      'node',
      [path.resolve('apps/cli/dist/index.js'), ...args, '--data-dir', dataDir],
      { cwd },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
    ),
  );
};
const sentInput = () => {
  const body = JSON.parse(requests[0]!.body) as {
    type: string;
    actor: string;
    input: Record<string, unknown>;
  };
  return body;
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body });
      const reply = replies.shift() ?? { status: 500, body: { error: 'no reply queued' } };
      res.statusCode = reply.status;
      res.setHeader('Content-Type', 'application/json').end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-cli-'));
  writeFileSync(path.join(dataDir, 'token'), 'user-token');
  writeFileSync(
    path.join(dataDir, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(dataDir, 'token'),
    }),
  );
  const parent = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-cli-repo-')));
  repo = path.join(parent, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'checkout', '-q', '-b', 'feature');
  linked = path.join(parent, 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'linked-branch', linked);
  detached = path.join(parent, 'detached');
  git(repo, 'worktree', 'add', '-q', '--detach', detached);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const finding = (patch: Record<string, unknown>) => ({
  id: 'f',
  review_id: 'review-1',
  runtime: 'codex',
  round: 1,
  location: 'src/a.ts:2',
  quote: 'for (;;)',
  evidence: 'the loop has no exit',
  impact: 'Hangs',
  status: 'open',
  blocking: false,
  ...patch,
});
const reviewOf = (patch: Record<string, unknown>) => ({
  id: 'review-1',
  revision: 1,
  project_id: 'project-1',
  round: 1,
  runtimes: ['codex'],
  state: 'completed',
  findings: [],
  verdicts: [{ runtime: 'codex', verdict: 'pass', summary: 'looks fine', at: 1 }],
  session_ids: [],
  ...patch,
});
const running = reviewOf({ state: 'running', verdicts: [] });
const started: { status?: number; body: unknown } = { body: { receipt: running } };

describe('pnpm cli review', () => {
  it('reviews the current branch against --base, polls until done and prints the findings', async () => {
    const done = reviewOf({
      findings: [
        finding({
          id: 'f-leak',
          location: 'src/a.ts:10',
          impact: 'Leaks',
          quote: 'open()',
          evidence: 'never closed',
        }),
        finding({}),
        finding({
          id: 'f-name',
          location: 'overall',
          unlocated: true,
          impact: 'Naming',
          quote: 'x',
          evidence: 'y',
        }),
        finding({ location: 'src/b.ts:1', status: 'rejected', impact: 'Not printed' }),
        finding({ location: 'src/c.ts:1', status: 'stale', impact: 'Not printed' }),
      ],
    });
    const result = await cli(
      repo,
      ['review', '--base', 'main'],
      [{ body: { receipt: running } }, { body: running }, { body: done }],
    );
    const body = sentInput();
    expect(body).toMatchObject({
      type: 'review.range',
      actor: 'local-user',
      input: { root: repo, base: 'main', head: 'feature' },
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /v1/commands',
      'GET /v1/review.read?review_id=review-1',
      'GET /v1/review.read?review_id=review-1',
    ]);
    expect(result.stderr).toContain('Review review-1 started: codex');
    expect(result.stdout).toBe(
      [
        'src/a.ts:2 [report] codex: Hangs',
        '  id: f',
        '  quote: for (;;)',
        '  evidence: the loop has no exit',
        'src/a.ts:10 [report] codex: Leaks',
        '  id: f-leak',
        '  quote: open()',
        '  evidence: never closed',
        'Without file:line:',
        'overall [report] codex: Naming',
        '  id: f-name',
        '  quote: x',
        '  evidence: y',
        'codex: pass — looks fine',
        '',
      ].join('\n'),
    );
    expect(result.code).toBe(0);
  });

  it.each([
    {
      name: 'an open blocking finding',
      args: ['--base', 'main'],
      answers: [started, { body: reviewOf({ findings: [finding({ blocking: true })] }) }],
      code: 1,
      stream: 'stdout',
      line: 'src/a.ts:2 [blocking] codex: Hangs',
    },
    {
      name: 'a fail verdict',
      args: ['--base', 'main'],
      answers: [
        started,
        {
          body: reviewOf({
            verdicts: [{ runtime: 'codex', verdict: 'fail', summary: 'broken', at: 1 }],
          }),
        },
      ],
      code: 1,
      stream: 'stdout',
      line: 'codex: fail — broken',
    },
    {
      name: 'an incomplete review',
      args: ['--base', 'main'],
      answers: [started, { body: reviewOf({ incomplete: 'codex timed out', verdicts: [] }) }],
      code: 2,
      stream: 'stdout',
      line: 'incomplete: codex timed out',
    },
    {
      name: 'a failed review',
      args: ['--base', 'main'],
      answers: [started, { body: reviewOf({ state: 'failed' }) }],
      code: 2,
      stream: 'stdout',
      line: 'codex: pass — looks fine',
    },
    {
      name: 'a reviewer without a verdict',
      args: ['--base', 'main'],
      answers: [started, { body: reviewOf({ runtimes: ['codex', 'claude'] }) }],
      code: 2,
      stream: 'stdout',
      line: 'claude: no verdict',
    },
    {
      name: 'a rejected command',
      args: ['--base', 'main'],
      answers: [{ status: 409, body: { code: 'invalid_ref', message: 'no such ref' } }],
      code: 2,
      stream: 'stderr',
      line: '"code": "invalid_ref"',
    },
    {
      name: 'a review it cannot read',
      args: ['--base', 'main'],
      answers: [started, { status: 404, body: { code: 'not_found', message: 'no review' } }],
      code: 2,
      stream: 'stderr',
      line: 'not_found',
    },
    {
      name: 'no base',
      args: ['feature'],
      answers: [],
      code: 64,
      stream: 'stderr',
      line: 'Usage: pantheon review',
    },
    {
      name: 'a base given twice',
      args: ['--base', 'main', 'main..feature'],
      answers: [],
      code: 64,
      stream: 'stderr',
      line: 'not both',
    },
  ])('exits $code on $name', async ({ args, answers, code, stream, line }) => {
    const result = await cli(repo, ['review', ...args], answers);
    expect(result[stream as 'stdout' | 'stderr']).toContain(line);
    expect(result.code).toBe(code);
  });

  it.each([
    { range: ['main..feature'], base: 'main', head: 'feature' },
    { range: ['main...feature'], base: 'main', head: 'feature' },
    { range: ['feature', '--base', 'main'], base: 'main', head: 'feature' },
  ])('sends base $base and head $head for $range', async ({ range, base, head }) => {
    await cli(repo, ['review', ...range], [{ body: { receipt: running } }, { body: reviewOf({}) }]);
    expect(sentInput().input).toMatchObject({ base, head });
  });

  it.each([
    { range: ['--base', 'main'] },
    { range: ['main..HEAD'] },
    { range: ['HEAD', '--base', 'main'] },
  ])(
    'reviews from a linked worktree against the main checkout with the worktree branch for $range',
    async ({ range }) => {
      await cli(
        linked,
        ['review', ...range],
        [{ body: { receipt: running } }, { body: reviewOf({}) }],
      );
      expect(sentInput().input).toEqual({ root: repo, base: 'main', head: 'linked-branch' });
    },
  );

  it.each([
    { range: 'main..linked-branch', head: () => 'linked-branch' },
    { range: 'main..shared-tag', head: () => 'shared-tag' },
    { range: 'main..ORIG_HEAD', head: () => git(linked, 'rev-parse', 'ORIG_HEAD').trim() },
  ])(
    'sends from a linked worktree the head of $range as the main checkout reads it',
    async ({ range, head }) => {
      git(repo, 'tag', '-f', 'shared-tag', 'main');
      git(linked, 'update-ref', 'ORIG_HEAD', 'HEAD');
      await cli(
        linked,
        ['review', range],
        [{ body: { receipt: running } }, { body: reviewOf({}) }],
      );
      expect(sentInput().input).toEqual({ root: repo, base: 'main', head: head() });
    },
  );

  it('sends the commit of a HEAD that names no branch, which the main checkout would read as its own', async () => {
    await cli(
      detached,
      ['review', 'main..HEAD~0'],
      [{ body: { receipt: running } }, { body: reviewOf({}) }],
    );
    expect(sentInput().input).toEqual({
      root: repo,
      base: 'main',
      head: git(detached, 'rev-parse', 'HEAD').trim(),
    });
  });

  it('sends each --fallback runtime in the order given', async () => {
    await cli(
      repo,
      ['review', '--base', 'main', '--fallback', 'grok', '--fallback', 'claude'],
      [{ body: { receipt: running } }, { body: reviewOf({}) }],
    );
    expect(sentInput().input).toMatchObject({ fallback: ['grok', 'claude'] });
  });

  it('prints each replacement and judges the review by the reviewer that took over', async () => {
    const result = await cli(
      repo,
      ['review', '--base', 'main'],
      [
        started,
        {
          body: reviewOf({
            runtimes: ['codex', 'grok'],
            replacements: [
              { runtime: 'codex', session_id: 'session-1', by: 'grok', reason: 'usage_limit' },
            ],
            verdicts: [{ runtime: 'grok', verdict: 'pass', summary: 'looks fine', at: 1 }],
          }),
        },
      ],
    );
    expect(result.stdout).toBe(
      ['codex: replaced by grok (usage_limit)', 'grok: pass — looks fine', ''].join('\n'),
    );
    expect(result.code).toBe(0);
  });

  it('resolves a finding at the current review revision and prints its outcome', async () => {
    const resolved = reviewOf({
      revision: 4,
      findings: [
        finding({
          resolution: { outcome: 'intentional', resolved_at: 1, resolved_by: 'local-user' },
        }),
      ],
    });
    const result = await cli(
      repo,
      ['review', 'resolve', 'review-1', 'f', 'intentional'],
      [
        { body: reviewOf({ revision: 3, findings: [finding({})] }) },
        { body: { receipt: resolved } },
      ],
    );
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /v1/review.read?review_id=review-1',
      'POST /v1/commands',
    ]);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      type: 'review.finding.resolve',
      actor: 'local-user',
      expected_revision: 3,
      input: { review_id: 'review-1', finding_id: 'f', outcome: 'intentional' },
    });
    expect(result.stdout).toBe('f: intentional\n');
    expect(result.code).toBe(0);
  });

  it('sends the note given with --note', async () => {
    requests.length = 0;
    replies = [
      { status: 200, body: reviewOf({ findings: [finding({})] }) },
      { status: 200, body: { receipt: reviewOf({}) } },
    ];
    const port = (server.address() as AddressInfo).port;
    const code = await review(
      () => ({ url: `http://127.0.0.1:${port}`, token: 'user-token' }),
      ['resolve', 'review-1', 'f', 'not_worth_it'],
      { note: 'Costs more than it saves' },
    );
    expect(JSON.parse(requests[1]!.body).input).toEqual({
      review_id: 'review-1',
      finding_id: 'f',
      outcome: 'not_worth_it',
      note: 'Costs more than it saves',
    });
    expect(code).toBe(0);
  });

  it.each([
    {
      name: 'an outcome it does not know',
      args: ['review-1', 'f', 'adopted'],
      answers: [],
      code: 64,
      line: 'Usage: pantheon review resolve',
    },
    {
      name: 'a missing finding id',
      args: ['review-1'],
      answers: [],
      code: 64,
      line: 'Usage: pantheon review resolve',
    },
    {
      name: 'a rejected resolution',
      args: ['review-1', 'f', 'wrong'],
      answers: [
        { body: reviewOf({ findings: [finding({})] }) },
        {
          status: 409,
          body: { code: 'invalid_state', message: 'Review finding cannot be resolved' },
        },
      ],
      code: 2,
      line: '"code": "invalid_state"',
    },
    {
      name: 'a review it cannot read',
      args: ['review-1', 'f', 'fixed'],
      answers: [{ status: 404, body: { code: 'not_found', message: 'no review' } }],
      code: 2,
      line: 'not_found',
    },
  ])('exits $code on resolving with $name', async ({ args, answers, code, line }) => {
    const result = await cli(repo, ['review', 'resolve', ...args], answers);
    expect(result.stderr).toContain(line);
    expect(result.code).toBe(code);
  });
});

const landingOf = (patch: Record<string, unknown>) => ({
  id: 'landing-1',
  revision: 1,
  project_id: 'project-1',
  root: '/repo',
  branch: 'feature',
  target_branch: 'main',
  workspace_id: 'workspace-1',
  state: 'running',
  ...patch,
});
const gate = (patch: Record<string, unknown>) => ({
  name: 'test',
  argv: ['pnpm', 'test'],
  exit_code: 0,
  duration_ms: 2500,
  timed_out: false,
  output: '',
  state: 'passed',
  ...patch,
});

describe('pnpm cli land', () => {
  it('lands the current branch with the given message', async () => {
    const result = await cli(
      repo,
      ['land', '--message', 'One commit'],
      [
        { body: { receipt: landingOf({ state: 'queued' }) } },
        { body: landingOf({ gate_results: [gate({})] }) },
        { body: landingOf({ state: 'landed', from_sha: '0123456789ab', to_sha: 'abcdef012345' }) },
      ],
    );
    expect(sentInput()).toMatchObject({
      type: 'project.land',
      actor: 'local-user',
      input: { root: repo, branch: 'feature', message: 'One commit' },
    });
    expect(requests.slice(1).map((request) => request.url)).toEqual([
      '/v1/project.landing.read?landing_id=landing-1',
      '/v1/project.landing.read?landing_id=landing-1',
    ]);
    expect(result.stderr).toContain('gate 1 test passed 2.5s');
    expect(result.code).toBe(0);
  });

  it.each([
    {
      name: 'landed',
      landing: { state: 'landed', from_sha: '0123456789ab', to_sha: 'abcdef012345' },
      stdout: 'landed feature onto main 01234567..abcdef01\n',
      code: 0,
    },
    {
      name: 'no changes',
      landing: { state: 'no_changes' },
      stdout: 'no changes: feature is already in main\n',
      code: 0,
    },
    {
      name: 'a failed gate',
      landing: {
        state: 'blocked',
        reason: 'gate failed',
        gate_results: [
          gate({ name: 'lint' }),
          gate({ state: 'failed', exit_code: 1, output: 'FAIL a.test.ts' }),
        ],
      },
      stdout: 'blocked: gate failed\ngate test failed:\nFAIL a.test.ts\n',
      code: 1,
    },
    {
      name: 'conflicts',
      landing: { state: 'blocked', reason: 'rebase conflict', conflicts: ['a.txt', 'b.txt'] },
      stdout: 'blocked: rebase conflict\nconflicts:\na.txt\nb.txt\n',
      code: 1,
    },
    {
      name: 'changed gate files',
      landing: { state: 'blocked', reason: 'gate_files_changed', conflicts: ['scripts/check.sh'] },
      stdout:
        "blocked: gate_files_changed\nconflicts:\nscripts/check.sh\nLand with the gate files changed: pantheon land 'feature' --allow-gate-change\n",
      code: 1,
    },
  ])('prints the result and exits $code when $name', async ({ landing, stdout, code }) => {
    const result = await cli(
      repo,
      ['land', 'feature'],
      [{ body: { receipt: landingOf({ state: 'queued' }) } }, { body: landingOf(landing) }],
    );
    expect(sentInput().input).toEqual({ root: repo, branch: 'feature' });
    expect(result.stdout).toBe(stdout);
    expect(result.code).toBe(code);
  });

  it('lets a landing change the gate files with --allow-gate-change', async () => {
    const result = await cli(
      repo,
      ['land', 'feature', '--message', "It's one", '--allow-gate-change'],
      [
        { body: { receipt: landingOf({ state: 'queued' }) } },
        { body: landingOf({ state: 'landed', from_sha: '0123456789ab', to_sha: 'abcdef012345' }) },
      ],
    );
    expect(sentInput().input).toEqual({
      root: repo,
      branch: 'feature',
      message: "It's one",
      allow_gate_change: true,
    });
    expect(result.code).toBe(0);
  });

  it('quotes the branch and message of the command that lands with the gate files changed', async () => {
    const result = await cli(
      repo,
      ['land', "it's;touch x", "--message=-It's one"],
      [
        { body: { receipt: landingOf({ state: 'queued' }) } },
        { body: landingOf({ state: 'blocked', reason: 'gate_files_changed' }) },
      ],
    );
    expect(result.stdout).toContain(
      `pantheon land 'it'\\''s;touch x' --message='-It'\\''s one' --allow-gate-change\n`,
    );
    expect(result.code).toBe(1);
  });

  it('prints the command that finds gate commands when the root has none', async () => {
    const result = await cli(
      repo,
      ['land'],
      [
        {
          status: 400,
          body: {
            error: 'no_gate_commands',
            message: `${repo} has no gate commands; a branch lands only through the gate of its root`,
            details: { project_id: 'project-1' },
          },
        },
      ],
    );
    expect(result.code).toBe(1);
    const line = /Find gate commands: pantheon command --json '(.*)'\n/.exec(result.stderr);
    expect(line, result.stderr).not.toBeNull();
    const envelope = JSON.parse(line![1]!) as { type: string; actor: string; input: unknown };
    expect(envelope).toMatchObject({ type: 'project.baseline.start', actor: 'local-user' });
    expect(envelope.input).toEqual({ project_id: 'project-1' });
  });

  it('prints the command that finds gate commands when a landing is blocked for want of them', async () => {
    const result = await cli(
      repo,
      ['land', 'feature'],
      [
        { body: { receipt: landingOf({ state: 'queued' }) } },
        { body: landingOf({ state: 'blocked', reason: 'no_gate_commands' }) },
      ],
    );
    expect(result.code).toBe(1);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('blocked: no_gate_commands');
    const line = /^Find gate commands: pantheon command --json '(.*)'$/.exec(lines[1]!);
    expect(line, result.stdout).not.toBeNull();
    const envelope = JSON.parse(line![1]!) as { type: string; actor: string; input: unknown };
    expect(envelope).toMatchObject({ type: 'project.baseline.start', actor: 'local-user' });
    expect(envelope.input).toEqual({ project_id: 'project-1' });
  });

  it('refuses a detached HEAD without a branch with exit 64', async () => {
    const result = await cli(detached, ['land'], []);
    expect(result.stderr).toContain('detached');
    expect(result.code).toBe(64);
    expect(requests).toEqual([]);
  });
});
