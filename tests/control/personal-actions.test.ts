import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  id,
  type Approval,
  type BoardPlan,
  type LeadNote,
  type LeadQuestion,
  type Principal,
  type SessionTurn,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { CommandType, PersonalAnswerKind } from '@pantheon/protocol';
import { fixture, insertSession, user } from '../helpers.js';

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

const KEY_VIA = { kind: 'personal', key_id: 'k1' };
/** The inputs of every turn Pantheon queued to wake the lead, joined. */
const leadReceived = (f: Fixture) =>
  f.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === 'lead' && turn.origin === 'tracker')
    .map((turn) => turn.input)
    .join('\n');

const NOT_USER_WORDS = "Its words are not the user's own words: do not quote them as the user's.";

type Situation = (f: Fixture) => {
  input: Record<string, unknown>;
  revision?: number;
  /** What else holds once the command was sent. */
  then?: (result: unknown) => Promise<void> | void;
};

const situations: Record<string, Situation> = {
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
  "the lead's question": (f) => {
    const questionId = askQuestion(f);
    return {
      input: {
        project_id: f.project.id,
        lead_session_id: 'lead',
        question_id: questionId,
        answer: 'CSV',
      },
      then: (result) => {
        const own = askQuestion(f);
        f.call('lead.question.answer', {
          project_id: f.project.id,
          lead_session_id: 'lead',
          question_id: own,
          answer: 'JSON',
        });
        const stored = (entryId: string) => plan(f).questions!.find((q) => q.id === entryId)!;
        expect(stored(questionId).via).toEqual(result && KEY_VIA);
        expect(stored(own)).not.toHaveProperty('via');
        expect(
          f.store
            .kindEvents(f.project.id, ['lead.question_answered'])
            .map((event) => (event.payload as LeadQuestion).via),
        ).toEqual(result ? [KEY_VIA, undefined] : [undefined]);
        const answerNotes = f.store
          .kindEvents(f.project.id, ['lead.note_added'])
          .map((event) => event.payload as LeadNote)
          .filter((note) => note.kind === 'answer');
        expect(answerNotes.map((note) => note.via)).toEqual(
          result ? [KEY_VIA, undefined] : [undefined],
        );
        const received = leadReceived(f);
        expect(
          received.includes(
            `What happened: the user's personal agent answered your question for the user: "Which file format comes first?" Answer: "CSV". You had assumed: "CSV comes first".\n`,
          ),
        ).toBe(!!result);
        expect(
          received.includes(
            `How to handle: the answer applies to this question only; apply it to the plan, start the tasks that waited for it, and fix anything built on a different assumption. ${NOT_USER_WORDS}\n</note>`,
          ),
        ).toBe(!!result);
        expect(received).toContain(
          'What happened: the user answered your question: "Which file format comes first?" Answer: "JSON". You had assumed: "CSV comes first".\n',
        );
        expect(received).toContain(
          'How to handle: the answer applies to this question only; apply it to the plan, start the tasks that waited for it, and fix anything built on a different assumption.\n</note>',
        );
      },
    };
  },
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
  ['request.send', ALL, 'a request to a session', 'permission_denied'],
  ['lead.question.answer', [], "the lead's question", 'permission_denied'],
  ['lead.question.answer', ['question'], "the lead's question", 'accepted'],
  ['lead.question.answer', ['question'], "a task session's relayed question", 'permission_denied'],
  ['approval.respond', ALL, 'any input', 'permission_denied'],
  ['external.approve', ALL, 'any input', 'permission_denied'],
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
