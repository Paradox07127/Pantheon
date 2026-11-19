// Local tool, not a registered scenario: opens the built app on its own data directory, seeds
// fixture data and takes one screenshot of every page and tab.
// Usage: node tests/acceptance/scenarios/look-pages.mjs <workspace> <source repo> [dark|light]
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import { connect, openClient } from '../lib/cdp.mjs';
import { startNativeDaemon } from '../lib/daemon-look.mjs';
import { launchDesktopApp, projectShown } from '../lib/desktop-app.mjs';

const [workspaceArg, sourceArg, theme = 'dark'] = process.argv.slice(2);
if (!workspaceArg || !sourceArg || !['dark', 'light'].includes(theme)) {
  console.error('Usage: look-pages.mjs <workspace> <source repo> [dark|light]');
  process.exit(2);
}
const workspace = path.resolve(workspaceArg);
const source = path.resolve(sourceArg);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const webSrc = path.join(repoRoot, 'apps/web/src');
const started = Date.now();
const deadline = started + 20 * 60_000;
const STEP_MS = 15_000;
const repo = path.join(workspace, 'repo');
const notesRepo = path.join(workspace, 'notes-repo');
const screensDir = path.join(workspace, 'evidence', 'screens');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const script = (...steps) => `fixture-script\n${JSON.stringify(steps)}`;
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

// FEEL_PROBE=1: no screenshots; each visited page records its long frames, layout shifts and
// how long the DOM kept changing after the last input (to <workspace>/evidence/feel.json).
const probe = process.env.FEEL_PROBE === '1';
const feel = [];
const PROBE_INSTALL = `(() => {
  const p = (window.__feel = { loaf: [], shifts: [], gaps: [], commits: [], input: 0, dirty: false });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) p.loaf.push([e.startTime, e.duration, e.blockingDuration]); }).observe({ type: 'long-animation-frame' });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) p.shifts.push([e.startTime, e.value, e.sources.slice(0, 3).map((s) => { const n = s.node?.nodeType === 1 ? s.node : s.node?.parentElement; return (n ? n.tagName.toLowerCase() + '.' + String(n.className?.baseVal ?? n.className).split(' ').slice(0, 2).join('.') : '?') + ' y' + Math.round(s.previousRect.y) + '>' + Math.round(s.currentRect.y) + ' h' + Math.round(s.previousRect.height) + '>' + Math.round(s.currentRect.height); })]); }).observe({ type: 'layout-shift' });
  new MutationObserver(() => { p.dirty = true; }).observe(document.body, { subtree: true, childList: true });
  for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, () => { p.input = performance.now(); }, true);
  let last = performance.now();
  const tick = (now) => {
    p.gaps.push([now, now - last]); last = now;
    if (p.dirty) { p.commits.push(now); p.dirty = false; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  p.take = () => {
    const from = p.input;
    const gaps = p.gaps.filter(([t]) => t >= from).map(([, d]) => d).sort((a, b) => a - b);
    const frame = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const loaf = p.loaf.filter(([t, d]) => t + d >= from);
    const commits = p.commits.filter((t) => t >= from);
    const shifts = p.shifts.filter(([t]) => t >= from);
    const out = {
      frame_ms: +frame.toFixed(1),
      late_frames: gaps.filter((d) => d > frame * 1.5).length,
      worst_frame_ms: Math.round(gaps.at(-1) ?? 0),
      long_frames: loaf.length,
      longest_ms: Math.round(Math.max(0, ...loaf.map(([, d]) => d))),
      blocked_ms: Math.round(loaf.reduce((n, [, , b]) => n + b, 0)),
      commit_frames: commits.length,
      settle_ms: commits.length ? Math.round(commits.at(-1) - from) : 0,
      shift: +shifts.reduce((n, [, v]) => n + v, 0).toFixed(4),
      shift_count: shifts.length,
      moved: shifts.sort((x, y) => y[1] - x[1]).slice(0, 2).map(([t, v, what]) => [Math.round(t - from), +v.toFixed(3), what]),
      commit_at: commits.slice(0, 8).map((t) => Math.round(t - from)),
    };
    p.loaf = []; p.shifts = []; p.gaps = []; p.commits = [];
    return out;
  };
  return true;
})()`;

// The app runs in Simplified Chinese; controls are found by their translated names.
const zh = {};
const localeDir = path.join(webSrc, 'i18n/locales/zh-CN');
for (const file of await readdir(localeDir))
  Object.assign(zh, JSON.parse(await readFile(path.join(localeDir, file), 'utf8')));
const tr = (id) => zh[id] ?? id;
/** The `[key, translated label]` pairs of a list of `{ <field>: 'key', get label() { return t({ id }) } }`. */
const labelled = async (file, field) =>
  [
    ...(await readFile(path.join(webSrc, file), 'utf8')).matchAll(
      new RegExp(`${field}: '(\\w+)',\\s*get label\\(\\) \\{\\s*return t\\(\\{ id: '([^']+)'`, 'g'),
    ),
  ].map((m) => [m[1], tr(m[2])]);

/** Answers an introduction turn with a fixed submission; every other turn runs as the fixture runs it. */
class IntroFixtureAdapter extends FixtureAdapter {
  // Each turn reports the context usage a Claude session reports, so the overview has its numbers.
  async start(spec, sink) {
    return super.start(spec, (event) =>
      sink(
        event.kind === 'usage.updated'
          ? {
              ...event,
              input_tokens: 99600,
              output_tokens: 1200,
              context_tokens: 99600,
              context_window: 500000,
              context_breakdown: {
                categories: [
                  { id: 'messages', tokens: 30400, kind: 'used' },
                  { id: 'system_tools', tokens: 19300, kind: 'used' },
                  { id: 'mcp_tools', tokens: 17500, kind: 'used' },
                  { id: 'memory_files', tokens: 10800, kind: 'used' },
                  { id: 'system_prompt', tokens: 10800, kind: 'used' },
                  { id: 'skills', tokens: 7400, kind: 'used' },
                  { id: 'custom_agents', tokens: 142, kind: 'used' },
                  { id: 'autocompact_buffer', tokens: 33000, kind: 'buffer' },
                  { id: 'free_space', tokens: 367400, kind: 'free' },
                  { id: 'mcp_tools_deferred', tokens: 102600, kind: 'deferred' },
                ],
                memory_files: [
                  { path: 'CLAUDE.md', tokens: 6000 },
                  { path: 'MEMORY.md', tokens: 4800 },
                ],
                mcp_tools: [{ name: 'explore', server: 'codegraph', tokens: 17500, loaded: true }],
                agents: [{ type: 'worker', source: 'projectSettings', tokens: 142 }],
              },
            }
          : event,
      ),
    );
  }
  async send(handle, turn) {
    if (!turn.input.startsWith('fixture-script') && turn.input.includes('project_intro_submit'))
      return super.send(handle, { ...turn, input: script(...INTRO_STEPS) });
    return super.send(handle, turn);
  }
}
const INTRO_STEPS = [
  { say: 'I read the repository layout and the entry points.' },
  {
    tool: {
      name: 'project_intro_submit',
      arguments: {
        summary:
          'A local workbench that runs coding agents in managed worktrees and lands their changes behind gates.',
        sources: ['file:README.md'],
        features: [
          {
            title: 'Sessions in worktrees',
            text: 'Each session works in its own worktree and merges back after its gates pass.',
            sources: ['file:packages/control/src/index.ts'],
          },
          {
            title: 'Lead plans',
            text: 'A lead session writes a board of tasks, milestones and dependencies.',
            sources: ['file:packages/protocol/src/index.ts'],
          },
          {
            title: 'Project memory',
            text: 'Decisions, reports and notes are kept per project and linked to each other.',
            sources: ['file:packages/protocol/src/memory.ts'],
          },
        ],
        modules: [
          { path: 'apps/daemon', role: 'Local daemon and its HTTP API.' },
          { path: 'apps/desktop', role: 'Electron shell around the web app.' },
          { path: 'apps/web', role: 'The workbench interface.' },
          { path: 'packages/control', role: 'Sessions, plans, gates and merges.' },
          { path: 'packages/adapters', role: 'Runtime adapters for the coding agents.' },
        ],
        architecture: {
          nodes: [
            { id: 'web', label: 'Web app' },
            { id: 'desktop', label: 'Desktop shell' },
            { id: 'daemon', label: 'Daemon' },
            { id: 'control', label: 'Control' },
            { id: 'adapters', label: 'Adapters' },
          ],
          edges: [
            { from: 'desktop', to: 'web' },
            { from: 'web', to: 'daemon' },
            { from: 'daemon', to: 'control' },
            { from: 'control', to: 'adapters' },
          ],
        },
        body: '## Getting started\nRun `pnpm install` and `pnpm build`, then start the desktop app.',
      },
    },
  },
];

const task = (id, title, milestone, depends_on, file, extra = {}) => ({
  id,
  title,
  goal: title,
  lane: 'main',
  milestone,
  depends_on,
  source: [title],
  scope: [file],
  acceptance: [`test -f ${file}`],
  ...extra,
});
const plan = {
  base_version: 0,
  headline: 'Harden the webhook endpoint and ship the audit log',
  lanes: [{ id: 'main', title: 'Main' }],
  tasks: [
    task('raw-body', 'Read the raw request body', 'signatures', [], 'docs/raw-body.md'),
    task(
      'constant-time',
      'Compare signatures in constant time',
      'signatures',
      [],
      'docs/constant-time.md',
    ),
    task('stale-timestamps', 'Reject stale timestamps', 'signatures', [], 'docs/stale.md'),
    task('secrets-table', 'Migrate the secrets table', 'signatures', [], 'docs/secrets.md'),
    task(
      'replay-tests',
      'Add replay tests',
      'signatures',
      ['constant-time', 'stale-timestamps'],
      'docs/replay.md',
    ),
    task('audit-schema', 'Design the audit log schema', 'audit', [], 'docs/audit-schema.md'),
    task(
      'audit-writer',
      'Write audit entries on every delivery',
      'audit',
      ['audit-schema'],
      'docs/audit-writer.md',
    ),
    task(
      'audit-export',
      'Export the audit log as CSV',
      'audit',
      ['audit-writer'],
      'docs/audit-export.md',
    ),
    task('audit-docs', 'Document the audit log', 'audit', ['audit-export'], 'docs/audit-docs.md'),
  ],
  milestones: [
    {
      id: 'signatures',
      title: 'Signed webhooks',
      criteria: ['Every webhook is verified on its raw body in constant time'],
      tasks: ['raw-body', 'constant-time', 'stale-timestamps', 'secrets-table', 'replay-tests'],
    },
    {
      id: 'audit',
      title: 'Audit log',
      criteria: ['Every delivery leaves an audit entry that can be exported'],
      tasks: ['audit-schema', 'audit-writer', 'audit-export', 'audit-docs'],
    },
  ],
  risks: [],
  assumptions: [],
};

const trace = (tool, input, extra = {}) => ({ trace: { tool, input, ...extra } });
const todos = [
  ['Read the raw request body', 'completed'],
  ['Compare signatures in constant time', 'completed'],
  ['Reject stale timestamps', 'in_progress'],
  ['Migrate the secrets table', 'pending'],
  ['Add replay tests', 'pending'],
].map(([content, status]) => ({ content, status, activeForm: content }));
const SHOWCASE = script(
  {
    say: 'The handler compares the signature with `==` on the parsed body. I will read the raw body, compare in constant time and reject stale timestamps.',
  },
  trace('TodoWrite', { todos }),
  trace('Read', { file_path: 'apps/daemon/src/index.ts' }),
  trace('Grep', { pattern: 'verifySignature', path: 'packages' }),
  trace('Task', {
    subagent_type: 'Explore',
    description: 'Find every webhook entry point',
    prompt: 'List the handlers.',
  }),
  trace(
    'Task',
    {
      subagent_type: 'worker',
      description: 'Migrate the secrets table',
      prompt: 'Write the migration.',
    },
    { open: true },
  ),
  {
    tool: {
      name: 'draw',
      arguments: {
        title: 'Signature check',
        kind: 'mermaid',
        spec: {
          source:
            'graph LR; request[Request] --> raw[Raw body]; raw --> hmac[HMAC]; hmac --> compare{Constant-time compare}; compare -->|match| accept[Accept]; compare -->|mismatch| reject[Reject]',
        },
      },
    },
  },
  {
    tool: {
      name: 'draw',
      arguments: {
        title: 'Rejected deliveries per day',
        kind: 'vega-lite',
        spec: {
          $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
          data: {
            values: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day, i) => ({
              day,
              rejected: [12, 9, 15, 4, 2][i],
            })),
          },
          mark: 'bar',
          encoding: {
            x: { field: 'day', type: 'ordinal', sort: null },
            y: { field: 'rejected', type: 'quantitative' },
          },
        },
      },
    },
  },
  {
    write: {
      path: 'docs/webhook-notes.md',
      text: '# Webhook signature\n\nRead the raw body.\nCompare in constant time.\nReject timestamps older than five minutes.\n',
    },
  },
  trace('Bash', { command: 'pnpm exec vitest run tests/daemon' }),
  { commit: 'Verify webhook signatures on the raw body' },
  {
    say: 'Signature check is in. The migration needs the production secrets table; I need your approval to run it.',
  },
  { ask: { tool: 'Bash', input: { command: 'pnpm migrate --table webhook_secrets' } } },
  { say: 'Done.' },
);
const wrote = (file, text, message) => [{ write: { path: file, text } }, { commit: message }];

const MEMORIES = [
  [
    'webhook-raw-body',
    'decision',
    'Verify signatures on the raw body',
    ['webhooks', 'security'],
    'Signatures are computed on the exact bytes received; parsing first changes whitespace and key order.',
  ],
  [
    'webhook-constant-time',
    'decision',
    'Compare signatures in constant time',
    ['webhooks', 'security'],
    'Use timingSafeEqual on equal-length buffers; an early exit leaks the matching prefix.',
  ],
  [
    'webhook-clock-skew',
    'note',
    'Allow five minutes of clock skew',
    ['webhooks'],
    'Deliveries older than five minutes are rejected as replays.',
  ],
  [
    'audit-retention',
    'decision',
    'Keep audit entries for 90 days',
    ['audit', 'storage'],
    'The audit table is pruned nightly after 90 days.',
  ],
  [
    'audit-export-report',
    'report',
    'Audit export benchmark',
    ['audit', 'performance'],
    'Exporting one million entries as CSV takes 14 seconds and 80 MB of memory.',
  ],
  [
    'gate-flakes',
    'report',
    'Flaky gate runs last week',
    ['gates', 'ci'],
    'Two of forty gate runs failed on a timeout in the daemon tests; both passed on retry.',
  ],
  [
    'release-checklist',
    'note',
    'Release checklist',
    ['release'],
    'Run the gates, update the changelog, tag the release and announce it.',
  ],
];
// Each later entry depends on the entries named here.
// Decisions take no dependencies.
const MEMORY_DEPENDS = {
  'webhook-clock-skew': ['webhook-raw-body', 'webhook-constant-time'],
  'gate-flakes': ['webhook-constant-time'],
  'audit-export-report': ['audit-retention'],
  'release-checklist': ['gate-flakes', 'audit-retention'],
};

const missing = [];
let fixture;
let app;
let page;
let shots = 0;
const skipped = [];
try {
  for (const dir of [
    'repo',
    'notes-repo',
    'state',
    'workspaces',
    'backups',
    'home',
    'no-hooks',
    'evidence',
  ])
    await rm(path.join(workspace, dir), { recursive: true, force: true });
  for (const dir of ['no-hooks', 'workspaces', 'backups', 'home', 'notes-repo'])
    await mkdir(path.join(workspace, dir), { recursive: true });
  await mkdir(screensDir, { recursive: true });
  git(workspace, 'clone', '-q', '--local', source, repo);
  git(notesRepo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(notesRepo, 'README.md'), '# Notes export\n\nExports notes as text.\n');
  for (const r of [repo, notesRepo]) {
    git(r, 'config', 'user.name', 'Look');
    git(r, 'config', 'user.email', 'look@example.invalid');
    git(r, 'config', 'commit.gpgsign', 'false');
    git(r, 'config', 'core.hooksPath', path.join(workspace, 'no-hooks'));
  }
  git(notesRepo, 'add', '-A');
  git(notesRepo, 'commit', '-q', '-m', 'Initial commit');

  fixture = await startNativeDaemon(workspace, [new IntroFixtureAdapter()], {
    intervalMs: 200,
    home: path.join(workspace, 'home'),
  });
  const { daemon } = fixture;
  const get = async (method, params = {}) => {
    const response = await fetch(`${daemon.url}/v1/${method}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method}: ${JSON.stringify(data)}`);
    return data;
  };
  const call = async (type, input, revision = null) => {
    const response = await fetch(`${daemon.url}/v1/commands`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command(USER_PRINCIPAL_ID, type, input, revision)),
    });
    const data = await response.json();
    if (response.status !== 200 || data.receipt?.error)
      throw new Error(`${type}: ${JSON.stringify(data).slice(0, 600)}`);
    return data.receipt;
  };
  /** Runs a seeding step; a failure is noted for the report and the run goes on. */
  const seed = async (what, action) => {
    try {
      return await action();
    } catch (error) {
      missing.push(`${what}: ${error.message.slice(0, 300)}`);
      log('SEED FAILED', what, error.message.slice(0, 300));
    }
  };
  const until = async (what, check, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Timed out: ${what}`);
      await delay(200);
    }
  };

  const project = await call('project.open', { name: 'Pantheon', roots: [repo] });
  const notesProject = await call('project.open', { name: 'Notes export', roots: [notesRepo] });
  const sessions = async (projectId = project.id) => get('session.list', { project_id: projectId });
  const turnsOf = async (sessionId, projectId = project.id) =>
    (await get('board', { project_id: projectId })).session_turns.filter(
      (t) => t.session_id === sessionId,
    );
  const settled = (sessionId, what, projectId) =>
    until(what, async () => {
      const turns = await turnsOf(sessionId, projectId);
      return turns.length > 0 && turns.every((t) => !['queued', 'running'].includes(t.state));
    });
  const waiting = (sessionId, what) =>
    until(what, async () => (await sessions()).find((s) => s.id === sessionId)?.waiting > 0);
  const row = async (sessionId, projectId = project.id) =>
    (await get('board', { project_id: projectId })).sessions.find((s) => s.id === sessionId);
  const rename = async (sessionId, title, projectId) =>
    call(
      'session.rename',
      { session_id: sessionId, title },
      (await row(sessionId, projectId)).revision,
    );
  const create = async (title, input, extra = {}, projectId = project.id) => {
    const created = await call('session.create', {
      project_id: projectId,
      runtime: 'fixture',
      input,
      ...extra,
    });
    await until(`${title} to be listed`, async () =>
      (await sessions(projectId)).some((s) => s.id === created.id),
    );
    await rename(created.id, title, projectId);
    return created.id;
  };

  // The cloned repository's own gates need a full build; a quick one stands in.
  await seed('quick gates', async () => {
    const shown = (await get('board', { project_id: project.id })).projects.find(
      (p) => p.id === project.id,
    );
    await call(
      'project.gate.set',
      {
        project_id: project.id,
        root: repo,
        commands: [{ name: 'readme', argv: ['test', '-f', 'README.md'] }],
      },
      shown.revision,
    );
  });
  const ids = {};
  await seed('the lead plan', async () => {
    ids.lead = await create(
      'Webhook hardening plan',
      script(
        { say: 'Plan written: two milestones, nine tasks.' },
        { tool: { name: 'update_board', arguments: plan } },
      ),
    );
    await settled(ids.lead, 'the lead to write the plan');
  });
  const taskSession = async (taskId, title, input) =>
    create(title, input, { task_id: `${ids.lead}:${taskId}` });
  await seed('a merged task', async () => {
    ids.merged = await taskSession(
      'raw-body',
      'Read the raw request body',
      script(...wrote('docs/raw-body.md', '# Raw body\n', 'Read the raw request body'), {
        say: 'The handler reads the raw body now.',
      }),
    );
    await settled(ids.merged, 'the merged task turn');
    await call('session.merge', { session_id: ids.merged }, (await row(ids.merged)).revision);
    let last;
    await until('the merge', async () => {
      last = await row(ids.merged);
      if (last?.merge?.state === 'blocked')
        throw new Error(`merge blocked: ${JSON.stringify(last.merge)}`);
      return last?.outcome === 'merged';
    }).catch((error) => {
      throw new Error(
        `${error.message}: ${JSON.stringify({ merge: last?.merge, outcome: last?.outcome, state: last?.state })}`,
      );
    });
  });
  await seed('a task waiting for review with a diff', async () => {
    ids.review = await taskSession(
      'constant-time',
      'Compare signatures in constant time',
      script(
        ...wrote(
          'docs/constant-time.md',
          '# Constant time\n\nUse timingSafeEqual.\n',
          'Compare in constant time',
        ),
        {
          say: 'Ready for review: the comparison uses timingSafeEqual.',
        },
      ),
    );
    await settled(ids.review, 'the review task turn');
  });
  await seed('a task whose gate fails', async () => {
    ids.gate = await taskSession(
      'stale-timestamps',
      'Reject stale timestamps',
      script(...wrote('docs/stale-notes.md', '# Stale\n', 'Write the stale timestamp notes'), {
        say: 'Done; the acceptance check looks for a file I did not write.',
      }),
    );
    await settled(ids.gate, 'the gate task turn');
    await call('session.merge', { session_id: ids.gate }, (await row(ids.gate)).revision);
    await until(
      'the merge to be blocked',
      async () => (await row(ids.gate))?.merge?.state === 'blocked',
    );
  });
  await seed('a task stuck on an approval', async () => {
    ids.blocked = await taskSession(
      'secrets-table',
      'Migrate the secrets table',
      script(
        { say: 'The migration touches production data.' },
        { ask: { tool: 'Bash', input: { command: 'pnpm migrate --table webhook_secrets' } } },
      ),
    );
    await waiting(ids.blocked, 'the blocked task to wait on approval');
  });
  await seed('a running task with a queued message', async () => {
    ids.running = await taskSession(
      'audit-schema',
      'Design the audit log schema',
      script(
        { say: 'Drafting the audit table.' },
        trace('Read', { file_path: 'packages/store/src/index.ts' }),
        trace(
          'Task',
          {
            subagent_type: 'Explore',
            description: 'Find the store migrations',
            prompt: 'List them.',
          },
          { open: true },
        ),
        { hang: true },
      ),
    );
    await until('the running turn', async () =>
      (await turnsOf(ids.running)).some((t) => t.state === 'running'),
    );
  });
  await seed('the showcase session', async () => {
    ids.showcase = await create('Fix webhook signature verification', SHOWCASE);
    await waiting(ids.showcase, 'the showcase session to wait on approval');
  });
  await seed('an idle session', async () => {
    ids.idle = await create(
      'Explain the gate runner',
      script(
        {
          try: {
            tool: 'Bash',
            input: { command: 'pnpm exec vitest run tests/gates' },
            error: 'exit code 1: 2 tests failed',
          },
        },
        trace('Bash', { command: 'pnpm exec vitest run tests/gates' }),
        { say: 'Gates run each root’s commands in the session worktree and record every result.' },
      ),
    );
    await settled(ids.idle, 'the idle session');
  });
  await seed('a lead question', async () => {
    const turn = script({
      tool: {
        name: 'ask_user',
        arguments: {
          project_id: project.id,
          question: 'Should the audit export include the request bodies?',
          options: ['Include bodies', 'Headers only'],
          recommended: 'Headers only',
          assumption: 'Bodies can hold customer data.',
          blocks: ['audit-export'],
        },
      },
    });
    await call(
      'session.send',
      { session_id: ids.lead, input: turn },
      (await row(ids.lead)).revision,
    );
    await settled(ids.lead, 'the lead question turn');
  });
  await seed('a session in the second project', async () => {
    const id = await create(
      'Add the export command',
      script(...wrote('export.txt', 'export\n', 'Add export.txt'), {
        say: 'Added the export command.',
      }),
      {},
      notesProject.id,
    );
    await settled(id, 'the second project session', notesProject.id);
  });
  await seed('project memory', async () => {
    const memoryIds = {};
    for (const [key, kind, title, tags, text] of MEMORIES) {
      const draft = await call('memory.propose', {
        project_id: project.id,
        key,
        kind,
        title,
        summary: text.slice(0, 120),
        tags,
        text,
        dependencies: (MEMORY_DEPENDS[key] ?? []).map((dep) => memoryIds[dep]),
      });
      await call('memory.commit', { memory_id: draft.id }, draft.revision);
      memoryIds[key] = draft.id;
    }
  });
  await seed('the project introduction', async () => {
    const { session_id } = await call('project.intro.start', { project_id: project.id });
    await settled(session_id, 'the introduction session');
    const read = await get('project.intro.read', { project_id: project.id });
    if (!read.intro)
      throw new Error(
        `no introduction; turns ${JSON.stringify((await turnsOf(session_id)).map((t) => [t.state, t.error ?? t.failure ?? '', t.input?.slice(0, 80)]))}`,
      );
  });
  log(
    'seeded',
    JSON.stringify(ids),
    missing.length ? `${missing.length} seeding steps failed` : '',
  );

  app = await launchDesktopApp({
    repoRoot,
    dataDir: path.join(workspace, 'state'),
    deadline,
    size: { width: 1440, height: 900 },
  });
  page = await connect(app.port, deadline, { evidenceDir: path.join(workspace, 'evidence') });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });
  const step = () => Date.now() + STEP_MS;
  const wait = (expression, what) => page.waitFor(expression, what, step());
  const click = (locator) => page.click(locator, step());
  const NAV = { name: tr('components.sidebar.navigation'), exact: true };
  const button = (name, extra = {}) => ({ role: 'button', name, exact: true, ...extra });
  const hasText = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
  await page.waitFor(
    `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
    `the ${theme} theme`,
  );

  const shot = async (name) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1436, y: 896 });
    await delay(400);
    await page.evaluate(`Promise.race([
      Promise.all(document.getAnimations()
        .filter((a) => a.playState !== 'finished' && Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map((a) => a.finished.catch(() => {}))),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]).then(() => true)`);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(screensDir, `${name}-${theme}.png`), Buffer.from(data, 'base64'));
    shots += 1;
    log('shot', name);
  };
  /** Opens a page and screenshots it; a page that cannot be reached is skipped. */
  const visit = async (name, open, close) => {
    // FEEL_ONLY=1 keeps only the streaming and boot measurements.
    if (process.env.FEEL_ONLY === '1') return;
    try {
      await open();
      if (probe) {
        await delay(1500);
        feel.push({ name, ...(await page.evaluate(`window.__feel.take()`)) });
        log('feel', name, JSON.stringify(feel.at(-1)));
      } else await shot(name);
    } catch (error) {
      const reason = error.message.split('\n')[0].slice(0, 200);
      skipped.push(`${name} ${reason}`);
      log('SKIP', name, reason);
    }
    try {
      await (close ? close() : Promise.resolve());
    } catch {
      await page.press('Escape').catch(() => {});
    }
  };
  const escape = async () => {
    await page.press('Escape');
    await delay(300);
  };
  const clickText = (text, selector = 'button, [role="button"], a, li, article') =>
    wait(
      `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].reverse().find((e) => e.offsetParent !== null && e.textContent.includes(${JSON.stringify(text)})); el?.click(); return !!el; })()`,
      `an element with ${text}`,
    );
  const openSession = async (title) => {
    await page.evaluate(
      `document.querySelectorAll('nav[aria-label="会话"] section > button[aria-expanded="false"]').forEach((b) => b.click())`,
    );
    await click({ role: 'button', name: `${title}，`, within: NAV });
  };
  const nav = (name) => click(button(name, { within: NAV }));

  await wait(`document.body.innerText.includes('Pantheon')`, 'the projects page');
  if (probe) await page.evaluate(PROBE_INSTALL);
  await visit('projects', () => wait(hasText('Notes export'), 'both projects listed'));
  await page.waitFor(projectShown('Pantheon'), 'the project to open');

  const showcaseTitle = 'Fix webhook signature verification';
  await visit('sessions', async () => {
    await openSession(showcaseTitle);
    await wait(hasText('constant time'), 'the showcase thread');
    // Queued messages live in the window, so one is typed while the turn waits on approval.
    await wait(
      `(() => { const box = document.querySelector('main textarea, textarea'); box?.focus(); return document.activeElement === box && !!box; })()`,
      'the composer',
    );
    await page.send('Input.insertText', { text: 'Also add an index on the delivery id.' });
    await page.press('Enter');
    await delay(500);
    await delay(1500);
  });
  await visit(
    'sessions-panels',
    async () => {
      await page.evaluate(`document.querySelector('.sh-tools button')?.click()`);
      await wait(`!!document.querySelector('.sh-tools button[aria-pressed="true"]')`, 'a panel');
      await delay(800);
    },
    async () =>
      page.evaluate(`document.querySelector('.sh-tools button[aria-pressed="true"]')?.click()`),
  );
  // Overview, hover card and timeline only, then stop.
  await delay(4000);
  await visit('timeline', async () => {
    await openSession('Explain the gate runner');
    await delay(1500);
  });
  await visit('timeline-showcase', async () => {
    await openSession(showcaseTitle);
    await delay(1500);
  });
  await visit('overview', async () => {
    const ok = await page.evaluate(
      `(() => { const b = [...document.querySelectorAll('header button')].find((e) => e.getAttribute('aria-label') === '概览'); if (!b) return false; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return b.getAttribute('aria-pressed') ?? 'none'; })()`,
    );
    if (!ok) throw new Error('no overview toggle');
    await delay(1500);
  });
  try {
    const box = await page.evaluate(
      `(() => { const r = [...document.querySelectorAll('nav[aria-label="会话"] [role="button"], nav[aria-label="会话"] button')].find((e) => e.textContent.includes(${JSON.stringify(showcaseTitle)}))?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
    );
    if (!box) throw new Error('no session row');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await delay(1500);
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(screensDir, `hover-${theme}.png`), Buffer.from(data, 'base64'));
    shots += 1;
    log('shot', 'hover');
  } catch (error) {
    skipped.push(`hover ${error.message.split('\n')[0]}`);
  }
  throw Object.assign(new Error('look done'), { done: true });
  await visit(
    'newsession',
    async () => {
      await nav(tr('components.sidebar.newSession'));
      await wait(`!!document.querySelector('section.cr-dlg')`, 'the new session dialog');
    },
    escape,
  );

  for (const [key, label] of await labelled('screens/board/BoardScreen.tsx', 'key')) {
    const name = key === 'memory' ? 'board-memory' : `board-${key}`;
    await visit(name, async () => {
      await nav('项目看板');
      await click({ role: 'radio', name: label, exact: true });
      await wait(
        `[...document.querySelectorAll('[role="radio"][aria-checked="true"]')].some((r) => r.textContent.includes(${JSON.stringify(label)}))`,
        `the ${label} view`,
      );
      if (key === 'memory') {
        await wait(`!!document.querySelector('.memory-row')`, 'the memory entries');
        await page.evaluate(
          `document.querySelector('.memory-workspace').parentElement.scrollIntoView({ block: 'start' })`,
        );
      }
      await delay(1200);
    });
    if (key === 'memory')
      await visit('board-memory-graph', async () => {
        await clickText('Verify signatures on the raw body', '.memory-row');
        await click(button(tr('board.memory.graph')));
        await wait(`!!document.querySelector('.memory-detail svg')`, 'the relationship graph');
        // Tag nodes link the entries that share a tag.
        await page.evaluate(
          `document.querySelector('.memory-detail input[type="checkbox"]')?.click()`,
        );
        await delay(800);
        await page.evaluate(
          `document.querySelector('.memory-workspace').scrollIntoView({ block: 'start' })`,
        );
        await delay(1200);
      });
  }
  await visit(
    'board-task',
    async () => {
      await nav('项目看板');
      await click({ role: 'radio', name: tr('board.view.canvas'), exact: true });
      await clickText('Migrate the secrets table', '.bd-cv *, main *');
      await delay(1200);
    },
    escape,
  );

  for (const [key, label] of await labelled('screens/insights/InsightsScreen.tsx', 'key'))
    await visit(`insights-${key}`, async () => {
      await nav('工程看板');
      await click({ role: 'tab', name: label, exact: true });
      await wait(
        `[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((t) => t.textContent.includes(${JSON.stringify(label)}))`,
        `the ${label} tab`,
      );
      await delay(1500);
    });
  await visit('memory-retro', async () => {
    await nav('记忆');
    await click({ role: 'tab', name: tr('memory.tab.learned'), exact: true });
    await delay(1500);
  });

  for (const [key, label] of await labelled('screens/trace/TraceScreen.tsx', 'tab')) {
    await visit(`trace-${key}`, async () => {
      await nav('轨迹');
      await click({ role: 'tab', name: label, exact: true });
      await wait(
        `[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((t) => t.textContent.includes(${JSON.stringify(label)}))`,
        `the ${label} tab`,
      );
      await delay(1500);
    });
    if (key === 'runtime') {
      await visit('trace-time', async () => {
        await wait(
          `(() => { const b = document.querySelector('.trc-time button[aria-expanded="false"]'); b?.click(); return !!b; })()`,
          'a time breakdown row to expand',
        );
        await delay(800);
      });
      // Opening a finding moves to its evidence on the timeline.
      await visit('trace-diagnostics', async () => {
        await wait(
          `(() => { const s = document.querySelector('.trc-runtime-row'); s?.click(); return !!s; })()`,
          'a runtime finding to open',
        );
        await delay(1200);
      });
    }
  }

  await visit('memory', async () => {
    await nav('记忆');
    await delay(1500);
  });

  const SETTINGS = { role: 'dialog', name: '设置', exact: true };
  for (const [key, label] of await labelled('screens/settings/view.ts', 'key'))
    await visit(
      `settings-${key}`,
      async () => {
        if (!(await page.find(SETTINGS).catch(() => false))) await nav('设置');
        await click(button(label, { within: { name: '设置分区', exact: true } }));
        await delay(1200);
      },
      async () => {},
    );
  if (await page.find(SETTINGS).catch(() => false))
    await click(button('关闭设置', { within: SETTINGS })).catch(() => escape());

  await visit(
    'palette',
    async () => {
      await page.press('k', ['Meta']);
      await wait(
        `!!document.querySelector('[role="dialog"] input, [role="combobox"]')`,
        'the palette',
      );
    },
    escape,
  );

  if (probe) {
    // A reply that arrives in 400 pieces over about 8 s, with headings and code blocks; while it
    // streams, four small wheel steps up test whether the thread lets go of its bottom.
    const piece = (i) =>
      i % 12 === 0
        ? `\n\n## Step ${i / 12 + 1}\n\n\`\`\`ts\nexport function step${i}(input: string) {\n  return input.trim().split(',').map(Number);\n}\n\`\`\`\n\n`
        : `The handler checks the signature of delivery ${i} in constant time and records the result. `;
    const streamTitle = 'Stream a long reply';
    const streamId = await create(streamTitle, script({ say: 'Starting.' }));
    await settled(streamId, 'the stream session');
    // 80 earlier turns, each with a tool call, so the thread is as long as a working session's.
    for (let i = 0; i < 80; i += 1) {
      await call(
        'session.send',
        {
          session_id: streamId,
          input: script(trace('Read', { file_path: `src/handlers/delivery-${i}.ts` }), {
            say: `Checked the handler of delivery ${i}; it verifies the signature before it parses the body.`,
          }),
        },
        (await row(streamId)).revision,
      );
      await settled(streamId, `earlier turn ${i}`);
    }
    await openSession(streamTitle);
    await delay(1000);
    await page.evaluate(`(window.__feel.input = performance.now(), window.__feel.take(), true)`);
    await call(
      'session.send',
      {
        session_id: streamId,
        input: script(
          ...Array.from({ length: 400 }, (_, i) => [{ say: piece(i) }, { wait: 20 }]).flat(),
        ),
      },
      (await row(streamId)).revision,
    );
    await delay(3000);
    for (let i = 0; i < 4; i += 1) {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 700,
        y: 400,
        deltaX: 0,
        deltaY: -15,
      });
      await delay(120);
    }
    const fromBottom = await page.evaluate(
      `(() => { const el = document.querySelector('.ss-scroll'); return el ? Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) : -1; })()`,
    );
    await settled(streamId, 'the streamed turn');
    await delay(500);
    feel.push({
      name: 'stream',
      ...(await page.evaluate(`window.__feel.take()`)),
      px_from_bottom_after_wheel_up: fromBottom,
    });
    log('feel', 'stream', JSON.stringify(feel.at(-1)));

    // A session window of its own: how long from the request until the system shows it.
    try {
      const onScreen = () =>
        Number(
          execFileSync(
            'osascript',
            [
              '-l',
              'JavaScript',
              '-e',
              `ObjC.import('CoreGraphics'); ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).filter((w) => w.kCGWindowOwnerPID === ${app.pid} && w.kCGWindowLayer === 0).length`,
            ],
            { encoding: 'utf8' },
          ).trim(),
        );
      const before = onScreen();
      const asked = Date.now();
      await page.evaluate(
        `window.pantheon.openWindow(${JSON.stringify({ kind: 'session', project_id: project.id, session_id: streamId })}).then(() => true)`,
      );
      let shownMs = null;
      while (Date.now() - asked < 8000) {
        if (onScreen() > before) {
          shownMs = Date.now() - asked;
          break;
        }
        await delay(40);
      }
      const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
      // Times in the window's own page, from its navigation start: when its scripts ran and when it first painted content.
      let inPage = null;
      const target = list.find((e) => e.type === 'page' && e.url.includes('kind=session'));
      if (target) {
        const client = await openClient(target.webSocketDebuggerUrl, Date.now() + 5000);
        const { result } = await client.send(
          'Runtime.evaluate',
          {
            expression: `JSON.stringify({ since_nav_ms: Math.round(performance.now()), dom_content_loaded_ms: Math.round(performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? -1), paints: performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]), busy: Boolean(document.querySelector('.sw[aria-busy]')) })`,
            returnByValue: true,
          },
          Date.now() + 5000,
        );
        inPage = { read_at_ms: Date.now() - asked, ...JSON.parse(result.value) };
        client.close?.();
      }
      feel.push({
        name: 'session-window',
        windows_before: before,
        shown_ms: shownMs,
        in_page: inPage,
        pages: list.filter((e) => e.type === 'page').map((e) => e.url.split('?')[1] ?? ''),
      });
      log('feel', 'session-window', JSON.stringify(feel.at(-1)));
      // The boot step connects to the first page; only the main window may be left.
      for (const entry of list)
        if (entry.type === 'page' && entry.url.includes('kind=session'))
          await fetch(`http://127.0.0.1:${app.port}/json/close/${entry.id}`);
      await delay(500);
    } catch (error) {
      log('SKIP', 'session-window', error.message.split('\n')[0]);
    }

    // A reload walks the same boot path as a new window: what the first frame shows, when the
    // first content lands and how much the page moves until it settles.
    try {
      const bootScript = `(() => {
          const b = (window.__boot = { shift: 0 });
          const t0 = performance.now();
          requestAnimationFrame(() => {
            b.first_frame_ms = Math.round(performance.now() - t0);
            b.dark_at_first_frame = document.documentElement.classList.contains('dark');
            b.bg_at_first_frame = getComputedStyle(document.body ?? document.documentElement).backgroundColor;
            b.font_at_first_frame = document.fonts.check('13px "Geist Variable"');
          });
          new MutationObserver((_, o) => {
            if (!document.getElementById('root')?.firstChild) return;
            b.first_content_ms = Math.round(performance.now() - t0);
            b.font_at_first_content = document.fonts.check('13px "Geist Variable"');
            o.disconnect();
          }).observe(document, { subtree: true, childList: true });
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) {
              b.shift = +(b.shift + e.value).toFixed(4);
              (b.moved ??= []).push([Math.round(e.startTime - t0), +e.value.toFixed(3), e.sources.slice(0, 3).map((s) => { const n = s.node?.nodeType === 1 ? s.node : s.node?.parentElement; return (n ? n.tagName.toLowerCase() + '.' + String(n.className?.baseVal ?? n.className).split(' ').slice(0, 2).join('.') : '?') + ' x' + Math.round(s.previousRect.x) + '>' + Math.round(s.currentRect.x) + ' y' + Math.round(s.previousRect.y) + '>' + Math.round(s.currentRect.y) + ' h' + Math.round(s.previousRect.height) + '>' + Math.round(s.currentRect.height); })]);
            }
          }).observe({ type: 'layout-shift', buffered: true });
          // BOOT_TRACE=1: what the notice cards and the board's needs strip show over time.
          if (${process.env.BOOT_TRACE === '1'}) {
            let last = '';
            setInterval(() => {
              const now = JSON.stringify({
                focus: document.hasFocus(),
                visible: document.visibilityState,
                cards: [...document.querySelectorAll('.toast-vp .toast')].map((n) => n.textContent.slice(0, 40)),
                needs: [...document.querySelectorAll('.bd-need li, .bd-need [role=listitem], .bd-need .rq')].length,
                strip: (document.querySelector('.bd-need')?.textContent ?? '').slice(0, 160),
                view: !!document.querySelector('.bd-cv'),
                busy: !!document.querySelector('.bd-cv[aria-busy]'),
                rows: document.querySelectorAll('.sb-row').length,
              });
              if (now === last) return;
              last = now;
              (b.trace ??= []).push([Math.round(performance.now() - t0), JSON.parse(now)]);
            }, 30);
            (async () => {
              const q = async (n, p) => {
                const at = performance.now();
                const r = await window.pantheon.query(n, p);
                (b.reads ??= []).push([n, Math.round(at - t0), Math.round(performance.now() - at), r.ok]);
                return r;
              };
              const r = await q('board', {});
              const v = r.value ?? {};
              b.board_keys = Object.keys(v);
              const id = (v.board ?? v).projects?.[0]?.id;
              if (id) await Promise.all([q('board.view', { project_id: id, days: '7' }), q('board', { project_id: id }), q('session.list', { project_id: id })]);
            })().catch((e) => (b.reads_error = String(e)));
          }
        })()`;
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript });
      for (let round = 0; round < Number(process.env.BOOT_REPEAT ?? 1); round++) {
        // The connection gives up on a navigation, so the reloaded page is read over a new one.
        const before =
          round === 0
            ? page
            : await connect(app.port, deadline, { evidenceDir: path.join(workspace, 'evidence') });
        if (round > 0)
          await before.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript });
        before.send('Page.reload').catch(() => {});
        await delay(6000);
        if (round > 0) before.close();
        const reloaded = await connect(app.port, deadline, {
          evidenceDir: path.join(workspace, 'evidence'),
        });
        feel.push({ name: 'boot', ...(await reloaded.evaluate(`window.__boot`)) });
        reloaded.close();
        log('feel', 'boot', JSON.stringify(feel.at(-1)));
      }
    } catch (error) {
      log('SKIP', 'boot', error.message.split('\n')[0]);
    }

    // NATIVE_CHECK=1: a right-click on a session row opens only the page's menu; on a text field it opens the system's.
    if (process.env.NATIVE_CHECK === '1') {
      try {
        const layers = () =>
          JSON.parse(
            execFileSync(
              'osascript',
              [
                '-l',
                'JavaScript',
                '-e',
                `ObjC.import('CoreGraphics'); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).filter((w) => w.kCGWindowOwnerPID === ${app.pid}).map((w) => w.kCGWindowLayer))`,
              ],
              { encoding: 'utf8' },
            ).trim(),
          );
        const view = await connect(app.port, Date.now() + 20000, {
          evidenceDir: path.join(workspace, 'evidence'),
        });
        const centre = (selector) =>
          view.evaluate(
            `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`,
          );
        const rightClick = async (at) => {
          const mouse = { ...at, button: 'right', clickCount: 1 };
          // A system menu holds the app's main thread, so the answer may not come.
          await Promise.race([
            (async () => {
              await view.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at });
              await view.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
              await view.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse });
            })().catch(() => {}),
            delay(1500),
          ]);
          await delay(600);
        };
        const row = await centre('.sb-row');
        const out = { name: 'right-click', layers_before: layers() };
        await rightClick(row);
        out.row_layers = layers();
        out.row_page_menu = await Promise.race([
          view.evaluate(`document.querySelectorAll('[role=menu]').length`),
          delay(1500).then(() => 'no answer'),
        ]);
        await view.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await view.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Escape',
          code: 'Escape',
          windowsVirtualKeyCode: 27,
        });
        await delay(300);
        await view.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...row,
          button: 'left',
          clickCount: 1,
        });
        await view.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...row,
          button: 'left',
          clickCount: 1,
        });
        await delay(1500);
        const field = await centre('textarea');
        out.field = field;
        out.field_spellcheck = await view.evaluate(
          `document.querySelector('textarea')?.spellcheck ?? null`,
        );
        out.other_inputs_spellcheck = await view.evaluate(
          `[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio])')].map((el) => el.spellcheck)`,
        );
        if (field) {
          await rightClick(field);
          out.field_layers = layers();
        }
        feel.push(out);
        log('feel', 'right-click', JSON.stringify(out));
      } catch (error) {
        log('SKIP', 'right-click', error.message.split('\n')[0]);
      }
    }
  }
} catch (error) {
  if (!error.done) {
    log('FAILED', error.stack);
    process.exitCode = 1;
  }
} finally {
  if (page) page.close();
  if (app) await app.stop().catch((error) => log('stop', error.message));
  await fixture?.close().catch(() => {});
  if (probe)
    await writeFile(path.join(workspace, 'evidence', 'feel.json'), JSON.stringify(feel, null, 1));
  for (const line of skipped) console.log(`SKIP ${line}`);
  for (const line of missing) console.log(`MISSING DATA ${line}`);
  console.log(
    `Screenshots: ${shots}, skipped: ${skipped.length}, in ${Math.round((Date.now() - started) / 1000)} s`,
  );
  process.exit(process.exitCode ?? 0);
}
