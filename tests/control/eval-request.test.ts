import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  DomainError,
  hash,
  type Improvement,
  type Principal,
  type Retrospective,
  type Session,
} from '@pantheon/domain';
import { eventually, fixture } from '../helpers.js';

type Run = Record<string, unknown>;
// The tests project only typechecks the scripts it lists, so this module is imported by URL.
const {
  render,
  summarize,
}: {
  render(summary: unknown): string;
  summarize(runs: Run[], rule: unknown): unknown;
} = await import(new URL('../eval/lib/report.mjs', import.meta.url).href);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const frozenTasks = fs.readdirSync(path.join(repoRoot, 'tests/eval/tasks')).length;
const retrospectiveIds = ['retrospective-1', 'retrospective-2'];
const sections = (reply: string) => ({
  before_you_plan: 'Plan right away.',
  routing: '- Keep every task on t1.',
  replies: reply,
});

/** A project with two stored playbook versions, version 2 current, and a lead with two retrospectives. */
async function opened(evalRunner?: (cwd: string, args: string[]) => Promise<number>) {
  const f = await fixture({ controlOptions: { evalRunner } });
  fixtures.push(f);
  f.store.insert<Session>('sessions', {
    id: 'lead',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 1,
    workspace_id: 'lead-workspace',
  });
  for (const [index, retrospectiveId] of retrospectiveIds.entries())
    f.store.insert<Retrospective>('retrospectives', {
      id: retrospectiveId,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${index}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: index + 1,
    });
  for (const [base_version, reply] of [
    [0, '- Reply with the task ids.'],
    [1, '- Reply in one line.'],
  ] as const)
    f.call('playbook.set', { project_id: f.project.id, base_version, sections: sections(reply) });
  return f;
}

const lead = (f: Fixture): Principal => ({
  id: 'session:lead',
  role: 'lead',
  project_id: f.project.id,
  session_id: 'lead',
  expires_at: f.store.now() + 60000,
});
const proposePlaybook = (f: Fixture) =>
  f.call<Improvement>(
    'improvement.propose',
    {
      project_id: f.project.id,
      retrospective_ids: retrospectiveIds,
      change: { type: 'playbook', to: 1 },
    },
    null,
    lead(f),
  );
const runEval = (f: Fixture, improvement: Improvement) =>
  f.call<Improvement>('eval.request.run', {
    project_id: f.project.id,
    improvement_id: improvement.id,
  });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};
/** The values of a repeated option of an eval command line. */
const values = (args: string[], name: string) =>
  args.filter((_, index) => args[index - 1] === name);

it('records the eval a playbook proposal without a receipt needs: both versions, the run count and the command', async () => {
  const f = await opened();
  const improvement = proposePlaybook(f);
  expect(improvement.status).toBe('candidate');
  expect(improvement.eval_request).toMatchObject({ conditions: [2, 1], runs: frozenTasks * 2 });
  expect(improvement.eval_request?.command).toMatch(
    /^node scripts\/eval\.mjs run --runtime claude --lead real --condition '?playbook=file:[^ ]+-2\.json'? --condition '?playbook=file:[^ ]+-1\.json'? --repetitions 1 --out /,
  );
});

it('refuses to run the eval of a playbook change while the project eval runner is off', async () => {
  const started: string[][] = [];
  const f = await opened(async (_, args) => {
    started.push(args);
    return 0;
  });
  const improvement = proposePlaybook(f);
  expect(refusal(() => runEval(f, improvement)).code).toBe('invalid_state');
  expect(started).toEqual([]);
});

it('exports a stored playbook version under the data folder as an eval condition reads it', async () => {
  const f = await opened();
  const exported = f.call<{ path: string }>('playbook.export', {
    project_id: f.project.id,
    version: 1,
  });
  expect(exported.path.startsWith(f.root)).toBe(true);
  expect(JSON.parse(fs.readFileSync(exported.path, 'utf8'))).toEqual({
    version: 1,
    sections: sections('- Reply with the task ids.'),
  });
});

it('runs the requested eval with the runner on, attaches its receipt, and lets the user confirm the change', async () => {
  const runs: { cwd: string; args: string[] }[] = [];
  const f = await opened(async (cwd, args) => {
    runs.push({ cwd, args });
    // What scripts/eval.mjs writes: under the first condition only the proposed version passes.
    const [first, second] = values(args, '--condition');
    const out = values(args, '--out')[0]!;
    const sha = (condition: string) =>
      hash(JSON.parse(fs.readFileSync(condition.slice('playbook=file:'.length), 'utf8')).sections);
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((task) =>
      [first!, second!].map((condition) => ({
        task,
        condition,
        repetition: 0,
        outcome: condition === second ? 'merged' : 'failed',
        hidden_passed: condition === second ? true : null,
        input_tokens: 1000,
        playbook_sha256: sha(condition),
      })),
    );
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'runs.jsonl'),
      rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
    );
    fs.writeFileSync(
      path.join(out, 'report.md'),
      render(
        summarize(rows, {
          confidence: 0.95,
          alpha: 0.05,
          bootstrap: { unit: 'task', resamples: 10000, seed: 1 },
        }),
      ),
    );
    return 0;
  });
  const improvement = proposePlaybook(f);
  f.call('workflow.policy.set', { project_id: f.project.id, eval_runner: 'on' }, null);
  expect(runEval(f, improvement).id).toBe(improvement.id);
  const current = () => f.store.must<Improvement>('improvements', improvement.id);
  await eventually(() => (current().evidence ?? []).some((entry) => entry.kind === 'eval_receipt'));
  expect(runs).toHaveLength(1);
  expect(['node', ...runs[0]!.args].join(' ')).toBe(
    improvement.eval_request!.command.replaceAll("'", ''),
  );
  const out = values(runs[0]!.args, '--out')[0]!;
  expect(out.startsWith(f.root)).toBe(true);
  const runsFile = path.join(out, 'runs.jsonl');
  expect(current().evidence).toContainEqual({
    kind: 'eval_receipt',
    path: runsFile,
    sha256: createHash('sha256').update(fs.readFileSync(runsFile)).digest('hex'),
    verdict: `${values(runs[0]!.args, '--condition')[1]}_passes_more`,
  });
  const confirmed = await f.call<Improvement | Promise<Improvement>>('improvement.decide', {
    project_id: f.project.id,
    improvement_id: improvement.id,
    decision: 'confirm',
  });
  expect(confirmed).toMatchObject({ status: 'active', change: { from: 2, to: 1 } });
});
