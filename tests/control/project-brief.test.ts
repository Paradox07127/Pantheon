import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  BoardPlan,
  LeadQuestion,
  Principal,
  Session,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);

async function planned(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  const owner: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    session_id: lead.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60_000,
  };
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export files',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: ['format', 'button'].map((id) => ({
        id,
        title: id,
        goal: 'Export files',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export feature'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    owner,
  );
  const worker = await f.create();
  await settle(f, worker);
  return { lead, owner, worker };
}

const ask = (f: Fixture, owner: Principal) =>
  f.call<LeadQuestion>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: 'Which export format?',
      options: ['CSV', 'JSON'],
      recommended: 'CSV',
      assumption: 'Build the download button while the format is undecided.',
      blocks: ['format'],
    },
    null,
    owner,
  );

const merged = (f: Fixture, sessionId: string) =>
  f.store.event('session.merged', current(f, sessionId), f.project.id, {
    branch: 'pantheon/export',
    to_sha: 'a'.repeat(40),
  });

/** Waits until the clock has moved past at, so the next event falls after it. */
const after = (f: Fixture, at: number) => eventually(() => f.store.now() > at);

it('lists a merge and a new lead question after the cursor with their refs, and neither once seen', async () => {
  const f = await workbenchFixture();
  const { lead, owner, worker } = await planned(f);
  f.store.insert<Approval>('approvals', {
    id: 'approval-bash',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: lead.id,
    request_id: 'request-bash',
    tool: 'Bash',
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now() - 60_000,
  });
  const seen = f.call<{ project_id: string; at: number }>('project.seen', {
    project_id: f.project.id,
  });
  await after(f, seen.at);
  merged(f, worker.id);
  const question = ask(f, owner);
  const asked = f.store
    .kindEvents(f.project.id, ['lead.question_asked'])
    .find((event) => (event.payload as LeadQuestion).id === question.id)!;

  const brief = f.control.projectBrief(user, f.project.id);
  const needs = f.control.needsYou(user, f.project.id).items;
  expect(brief.since).toBe(seen.at);
  expect(needs.map((item) => item.reason)).toEqual(['lead_question', 'permission_requested']);
  expect(brief.items).toEqual([
    {
      kind: 'decisions',
      ref: { kind: 'event', id: asked.event_id },
      count: needs.length,
      new: 1,
      top: needs[0],
    },
    expect.objectContaining({ kind: 'merge', ref: { kind: 'merge', id: worker.id } }),
  ]);

  f.call('project.seen', { project_id: f.project.id });
  expect(f.control.projectBrief(user, f.project.id).items).toEqual([]);
});

it('counts what the lead decided for the user after the cursor by type, and drops it once seen', async () => {
  const f = await workbenchFixture();
  const { lead, owner } = await planned(f);
  const seen = f.call<{ project_id: string; at: number }>('project.seen', {
    project_id: f.project.id,
  });
  expect(f.control.projectBrief(user, f.project.id).items).toEqual([]);
  await after(f, seen.at);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build the format',
    task_id: `${lead.id}:format`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  const turn = f.turns(worker.id)[0]!;
  await eventually(
    () => f.control.handles.has(turn.id) && current(f, worker.id).state === 'running',
    () => f.control.tick(),
  );
  const worktree = f.store.must<Workspace>('workspaces', worker.workspace_id!).path;
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const prompt = async (sequence: number, tool: string, detail: Record<string, unknown>) => {
    agentEvent(ctx, worker.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool,
      detail,
    } as AgentEvent);
    await f.control.tick();
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  await prompt(101, 'Edit', {
    input: { file_path: `${worktree}/src/format.ts`, old_string: 'a', new_string: 'b' },
  });
  const format = 'Which format should the export use?';
  const asked = await prompt(102, 'AskUserQuestion', {
    questions: [
      {
        question: format,
        header: 'Format',
        options: [
          { label: 'CSV', description: 'Plain rows' },
          { label: 'JSON', description: 'Nested records' },
        ],
        multiSelect: false,
      },
    ],
  });
  const card = f.store
    .must<BoardPlan>('board_plans', lead.id)
    .questions!.find((entry) => entry.source?.approval_id === asked.id)!;
  f.call(
    'lead.worker_question.answer',
    {
      project_id: f.project.id,
      question_id: card.id,
      answers: { [format]: 'CSV' },
      citations: [{ kind: 'user_words', ref: 'Plan the export feature' }],
    },
    null,
    owner,
  );

  expect(f.control.projectBrief(user, f.project.id).items).toContainEqual({
    kind: 'decided',
    ref: { kind: 'decided', id: f.project.id },
    count: 2,
    types: { permission: 1, answer: 1, plan_change: 0 },
  });
  f.call('project.seen', { project_id: f.project.id });
  expect(
    f.control.projectBrief(user, f.project.id).items.filter((item) => item.kind === 'decided'),
  ).toEqual([]);
});

it('leaves out what happened before since', async () => {
  const f = await workbenchFixture();
  const { owner, worker } = await planned(f);
  const question = ask(f, owner);
  await after(f, question.at);
  const since = f.store.now();
  await after(f, since);
  merged(f, worker.id);

  const brief = f.control.projectBrief(user, f.project.id, since);
  expect(brief.since).toBe(since);
  expect(brief.items).toEqual([
    expect.objectContaining({ kind: 'merge', ref: { kind: 'merge', id: worker.id } }),
  ]);
});

it('refuses a principal without access to the project', async () => {
  const f = await workbenchFixture();
  const stranger: Principal = { id: 'planner', role: 'planner', project_id: 'other-project' };
  expect(() => f.control.projectBrief(stranger, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() => f.call('project.seen', { project_id: f.project.id }, null, stranger)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});
