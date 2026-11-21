import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  type CharterMode,
  type CharterPower,
  type Principal,
  type Session,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Plain = Awaited<ReturnType<typeof fixture>>;
type Caller = Pick<Plain, 'call' | 'store' | 'project' | 'control'>;

const MERGE_REASON = 'The README names the new module';

/** What came of a lead's use of a power: applied at once, waiting for the user, or refused. */
interface Outcome {
  applied: boolean;
  waiting: boolean;
  recorded: boolean;
  refused?: string;
  reason?: string;
}

const leadOf = (f: Caller, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000_000,
});

function setCharter(f: Caller, power: CharterPower, mode: CharterMode) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, charter: { [power]: mode } },
    row?.revision ?? null,
  );
}

async function attempt(run: () => unknown): Promise<Pick<Outcome, 'refused' | 'reason'>> {
  try {
    await run();
    return {};
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { refused: code, reason: message };
  }
}

const recorded = (f: Caller, power: CharterPower) =>
  f.store
    .kindEvents(f.project.id, ['charter.power_used'])
    .some((event) => (event.payload as { power: string }).power === power);

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
}

const scenarios: Record<'merge_out_of_scope', (mode: CharterMode) => Promise<Outcome>> = {
  async merge_out_of_scope(mode) {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    setCharter(f, 'merge_out_of_scope', mode);
    const current = (sessionId: string) => f.store.must<Session>('sessions', sessionId);
    const lead = await f.create('Plan the export feature');
    await awaitWorkspaceReady(f.control, lead.workspace_id!);
    await eventually(
      () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
      () => f.control.tick(),
    );
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: 'first',
            title: 'Task first',
            goal: 'Finish first',
            lane: 'core',
            depends_on: [],
            source: ['Plan the export feature'],
            scope: ['src/first'],
            acceptance: ['true'],
          },
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadOf(f, lead.id),
    );
    const session = await f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Build it',
      task_id: `${lead.id}:first`,
    });
    const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () =>
        f.turns(session.id).every((turn) => turn.state === 'completed') &&
        current(session.id).state === 'open',
      () => f.control.tick(),
    );
    commit(workspace.path, 'src/first/x.ts', 'export const x = 1;\n');
    commit(workspace.path, 'README.md', 'Names the first module\n');
    await f.call('session.merge', { session_id: session.id }, current(session.id).revision);
    await eventually(
      () => current(session.id).merge?.state === 'blocked',
      () => f.control.tick(),
      10000,
    );
    const refusal = await attempt(() =>
      f.call(
        'session.merge',
        {
          project_id: f.project.id,
          task_id: 'first',
          allow_out_of_scope: true,
          reason: MERGE_REASON,
        },
        null,
        leadOf(f, lead.id),
      ),
    );
    return {
      applied: f.store
        .kindEvents(f.project.id, ['session.merge_started'])
        .some(
          (event) =>
            event.aggregate_id === session.id &&
            (event.payload as { reason?: string }).reason === MERGE_REASON,
        ),
      waiting: f.control
        .needsYou(user, f.project.id)
        .items.some(
          (item) => item.kind === 'session.merge_blocked' && item.source.id === session.id,
        ),
      recorded: recorded(f, 'merge_out_of_scope'),
      ...refusal,
    };
  },
};

type Row = Outcome & { power: keyof typeof scenarios; mode: CharterMode };

it.each<Row>([
  { power: 'merge_out_of_scope', mode: 'on', applied: true, waiting: false, recorded: true },
  {
    power: 'merge_out_of_scope',
    mode: 'ask',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: 'The user merges the files outside the scope of task first',
  },
  {
    power: 'merge_out_of_scope',
    mode: 'off',
    applied: false,
    waiting: true,
    recorded: false,
    refused: 'permission_denied',
    reason: "The project's charter does not let a lead merge files outside a task's scope",
  },
])(
  "with $power set to $mode, the lead's use is applied: $applied, waits for the user: $waiting, refused: $refused",
  async ({ power, mode, reason, ...expected }) => {
    const { reason: said, ...outcome } = await scenarios[power](mode);
    expect(outcome).toEqual(expected);
    if (reason) expect(said).toContain(reason);
  },
);
