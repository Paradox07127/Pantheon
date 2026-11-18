import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  id,
  type Approval,
  type BoardPlan,
  type Milestone,
  type Principal,
  type Session,
  type SessionTurn,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { CommandType, PersonalAnswerKind } from '@pantheon/protocol';
import { eventually, fixture, insertSession, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

const personal: Principal = { id: 'personal:k1', role: 'personal' };
const REQUEST = 'Ship the export API this week.';

/** A project with a lead whose plan has task api under milestone release, and a user config folder. */
async function setup(answers: PersonalAnswerKind[]) {
  const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-personal-actions-'));
  const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir } });
  cleanups.push(async () => {
    await f.close();
    rmSync(userConfigDir, { recursive: true, force: true });
  });
  f.call('app.settings.set', { personal_answers: answers });
  setPolicy(f, { plan_changes: 'confirm' });
  insertSession(f, { id: 'lead', turn_count: 1 });
  f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'api',
          title: 'API',
          goal: 'Serve exports',
          lane: 'core',
          depends_on: [],
          source: ['Ship the export API'],
          scope: [],
          acceptance: [],
          done_when: 'report',
          milestone: 'release',
        },
      ],
      milestones: [
        { id: 'release', title: 'Release', criteria: ['Exports download'], tasks: ['api'] },
      ],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, 'lead'),
  );
  return f;
}

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}

const plan = (f: Fixture) => f.store.must<BoardPlan>('board_plans', 'lead');

/** Waits until the session takes input again with no turn left to run. */
const idle = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      f.store.must<Session>('sessions', sessionId).state === 'open' &&
      f.store
        .list<SessionTurn>('session_turns')
        .filter((turn) => turn.session_id === sessionId)
        .every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

function askQuestion(f: Fixture) {
  return f.call<{ id: string }>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: 'Which file format comes first?',
      options: ['CSV', 'JSON'],
      recommended: 'CSV',
      assumption: 'CSV comes first',
      blocks: ['api'],
    },
    null,
    leadOf(f, 'lead'),
  ).id;
}

/** A task session's question relayed to the lead's board, with its pending approval. */
function relayQuestion(f: Fixture) {
  insertSession(f, { id: 'asker', turn_count: 1 });
  f.store.insert<Approval>('approvals', {
    id: 'ask',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: 'asker',
    request_id: 'request',
    tool: 'AskUserQuestion',
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  });
  const current = plan(f);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...current,
      questions: [
        ...(current.questions ?? []),
        {
          id: 'relayed',
          at: f.store.now(),
          question: 'Which format?',
          options: ['CSV', 'JSON'],
          recommended: '',
          assumption: '',
          blocks: ['api'],
          source: { session_id: 'asker', approval_id: 'ask' },
        },
      ],
    },
    current.revision,
  );
  return 'relayed';
}

function propose(f: Fixture) {
  return f.call<{ proposal_id: string }>(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: plan(f).plan_version,
      reason: 'The export needs a narrower contract',
      ops: [{ type: 'set_task', task_id: 'api', patch: { title: 'Export API' } }],
    },
    null,
    leadOf(f, 'lead'),
  ).proposal_id;
}

/** Spends the project's whole budget with one ended turn. */
function overBudget(f: Fixture) {
  setPolicy(f, { project_budget: { input_tokens: 100 } });
  const now = Date.now.bind(Date);
  vi.spyOn(f.store, 'now').mockImplementation(() => now() + 1000);
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: 'lead',
    input: 'work',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  } as SessionTurn);
  f.store.event('turn.completed', turn, f.project.id, {});
}

/** The milestone, once its one task is accepted. */
function readyMilestone(f: Fixture) {
  const current = plan(f);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...current,
      accepted: { api: { at: f.store.now(), evidence: 'The report answers it', generation: 1 } },
    },
    current.revision,
  );
  return f.store.list<Milestone>('milestones').find((row) => row.key === 'release')!;
}

type Situation = (f: Fixture) => {
  input: Record<string, unknown>;
  revision?: number;
  /** What else holds once the command was sent. */
  then?: (result: unknown) => Promise<void> | void;
};

const situations: Record<string, Situation> = {
  'a request to the assistant': (f) => ({
    input: { project_id: f.project.id, input: 'What does the export hold?' },
    then: async (result) => {
      const { session_id, turn_id } = result as { session_id: string; turn_id: string };
      const turn = () => f.store.must<SessionTurn>('session_turns', turn_id);
      expect(turn()).toMatchObject({ via: { kind: 'personal', key_id: 'k1' } });
      expect(turn().origin).toBeUndefined();
      await idle(f, session_id);
      expect(turn()).toMatchObject({ state: 'completed', routing: { kind: 'answered' } });
    },
  }),
  'a request to a session': (f) => {
    const direct = insertSession(f);
    return {
      input: {
        project_id: f.project.id,
        input: 'Rename it',
        target: { kind: 'session', session_id: direct.id },
      },
      then: () =>
        expect(
          f.store.list<SessionTurn>('session_turns').filter((t) => t.session_id === direct.id),
        ).toEqual([]),
    };
  },
  "the lead's question": (f) => ({
    input: {
      project_id: f.project.id,
      lead_session_id: 'lead',
      question_id: askQuestion(f),
      answer: 'CSV',
    },
  }),
  "a task session's relayed question": (f) => ({
    input: {
      project_id: f.project.id,
      lead_session_id: 'lead',
      question_id: relayQuestion(f),
      answer: 'CSV',
    },
    then: () => {
      expect(f.store.must<Approval>('approvals', 'ask').state).toBe('pending');
      expect(plan(f).questions?.find((q) => q.id === 'relayed')?.answer).toBeUndefined();
    },
  }),
  'a plan proposal': (f) => ({
    input: {
      project_id: f.project.id,
      lead_session_id: 'lead',
      proposal_id: propose(f),
      decision: 'accept',
    },
  }),
  'a plan proposal accepted with edits': (f) => {
    const proposalId = propose(f);
    return {
      input: {
        project_id: f.project.id,
        lead_session_id: 'lead',
        proposal_id: proposalId,
        decision: 'accept',
        ops: [{ type: 'set_task', task_id: 'api', patch: { title: 'Edited API' } }],
      },
      then: () => {
        expect(plan(f).tasks.find((task) => task.id === 'api')?.title).toBe('API');
        expect(
          plan(f).pending_proposals?.find((entry) => entry.proposal_id === proposalId)?.status,
        ).toBe('pending');
      },
    };
  },
  'a plan proposal over budget': (f) => {
    const proposalId = propose(f);
    overBudget(f);
    return {
      input: {
        project_id: f.project.id,
        lead_session_id: 'lead',
        proposal_id: proposalId,
        decision: 'accept',
      },
    };
  },
  'a milestone ready for acceptance': (f) => {
    const milestone = readyMilestone(f);
    return {
      input: { milestone_id: milestone.id, evidence_refs: ['task:api'] },
      revision: milestone.revision,
    };
  },
  'any input': () => ({ input: {} }),
};

const outcome = (run: () => unknown): { result?: unknown; code: string } => {
  try {
    return { result: run(), code: 'accepted' };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? (error as Error).name };
  }
};

const ALL: PersonalAnswerKind[] = ['question', 'plan_change', 'milestone_accept'];

it.each<[CommandType, PersonalAnswerKind[], keyof typeof situations, string]>([
  ['request.send', [], 'a request to the assistant', 'accepted'],
  ['request.send', ALL, 'a request to a session', 'permission_denied'],
  ['lead.question.answer', [], "the lead's question", 'permission_denied'],
  ['lead.question.answer', ['question'], "the lead's question", 'accepted'],
  ['lead.question.answer', ['question'], "a task session's relayed question", 'permission_denied'],
  ['board.plan.proposal.resolve', [], 'a plan proposal', 'permission_denied'],
  ['board.plan.proposal.resolve', ['plan_change'], 'a plan proposal', 'accepted'],
  [
    'board.plan.proposal.resolve',
    ['plan_change'],
    'a plan proposal accepted with edits',
    'permission_denied',
  ],
  [
    'board.plan.proposal.resolve',
    ['plan_change'],
    'a plan proposal over budget',
    'permission_denied',
  ],
  [
    'milestone.accept',
    ['question', 'plan_change'],
    'a milestone ready for acceptance',
    'permission_denied',
  ],
  ['milestone.accept', ['milestone_accept'], 'a milestone ready for acceptance', 'accepted'],
  ['approval.respond', ALL, 'any input', 'permission_denied'],
  ['agent.proposal.resolve', ALL, 'any input', 'permission_denied'],
  ['external.approve', ALL, 'any input', 'permission_denied'],
  ['improvement.decide', ALL, 'any input', 'permission_denied'],
])(
  'a personal principal sending %s with %j allowed, for %s, is %s',
  async (type, answers, situation, expected) => {
    const f = await setup(answers);
    const { input, revision, then } = situations[situation]!(f);
    const sent = outcome(() => f.call(type, input, revision ?? null, personal));
    expect(sent.code).toBe(expected);
    const recorded = f.store.db
      .prepare("SELECT payload FROM events WHERE kind='personal.called'")
      .all() as { payload: string }[];
    expect(recorded.map((row) => JSON.parse(row.payload))).toEqual(
      expected === 'accepted' ? [{ key_id: 'k1', type, project_id: f.project.id }] : [],
    );
    await then?.(sent.result);
  },
);

it("lets a plan task quote the words of a personal agent's request as its source", async () => {
  const f = await setup([]);
  const routed = f.call<{ session_id: string }>(
    'request.send',
    { project_id: f.project.id, input: 'Add a CSV download to the export page' },
    null,
    personal,
  );
  await idle(f, routed.session_id);
  expect(
    outcome(() =>
      f.call(
        'board.plan.update',
        {
          project_id: f.project.id,
          base_version: 0,
          headline: 'CSV download',
          lanes: [{ id: 'web', title: 'Web' }],
          tasks: [
            {
              id: 'csv',
              title: 'CSV download',
              goal: 'Download the export as CSV',
              lane: 'web',
              depends_on: [],
              source: ['Add a CSV download to the export page'],
              scope: ['src/export'],
              acceptance: ['pnpm test'],
            },
          ],
          milestones: [],
          risks: [],
          assumptions: [],
        },
        null,
        leadOf(f, routed.session_id),
      ),
    ).code,
  ).toBe('accepted');
});

it.each<[PersonalAnswerKind[], Record<string, boolean>]>([
  [[], { question: false, relayed: false, proposal: false, milestone: false }],
  [['question'], { question: true, relayed: false, proposal: false, milestone: false }],
  [ALL, { question: true, relayed: false, proposal: true, milestone: true }],
])(
  'shows a personal principal with %j allowed which decisions it may answer',
  async (answers, allowed) => {
    const f = await setup(answers);
    const question = askQuestion(f);
    relayQuestion(f);
    const proposal = propose(f);
    const milestone = readyMilestone(f);
    const names: Record<string, string> = {
      [question]: 'question',
      relayed: 'relayed',
      [proposal]: 'proposal',
      [milestone.id]: 'milestone',
    };
    const shown = Object.fromEntries(
      f.control
        .needsYou(personal, f.project.id)
        .items.filter((item) => names[item.request_id ?? item.source.id])
        .map((item) => [names[item.request_id ?? item.source.id], item.actions[0]!.allowed]),
    );
    expect(shown).toEqual(allowed);
    expect(
      f.control
        .needsYou(user, f.project.id)
        .items.filter((item) => names[item.request_id ?? item.source.id])
        .every((item) => item.actions[0]!.allowed),
    ).toBe(true);
  },
);
