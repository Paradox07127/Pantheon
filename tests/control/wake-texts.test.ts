import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { INBOX_HEADER, inboxDigest } from '../../packages/control/dist/lead-inbox.js';
import { settle } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);

/** A settled lead with a one-task plan and a settled session of that task, the lead's inbox empty. */
async function leadWithTask() {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Serve exports over HTTP',
          goal: 'Exports download',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  const worker = await boundTaskSession(f, lead.id, 'a');
  await settle(f, worker);
  const plan = planOf(f, lead.id);
  f.store.update<BoardPlan>('board_plans', { ...plan, inbox: [] }, plan.revision);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  return { f, ctx, lead, worker };
}

const report = (f: Fixture, workerId: string, kind: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind, text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

/** The digest the lead's next message carries, once that message's turn has ended. */
async function nextDigest(f: Fixture, leadId: string): Promise<string> {
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: leadId, input: 'Keep going' },
    f.store.must<Session>('sessions', leadId).revision,
  );
  await settle(f, f.store.must<Session>('sessions', leadId));
  return sent.input.slice(sent.input.indexOf(INBOX_HEADER));
}

it('wraps a requirement report in the wake envelope with its handling text', async () => {
  const { f, lead, worker } = await leadWithTask();
  report(f, worker.id, 'requirement', 'The fix needs src/ui too');
  const note = f.store.kindEvents(f.project.id, ['lead.note_added']).at(-1)!.payload as LeadNote;
  const wake = f.turns(lead.id).find((turn) => turn.origin === 'tracker')!.input;
  const lines = wake.split('\n');
  expect(lines[0]).toBe(INBOX_HEADER);
  expect(lines[1]).toMatch(
    /^Wake at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\. 1 update\(s\); not a user request\.$/,
  );
  expect(lines.slice(2)).toEqual([
    `<note kind="requirement" id="${note.id}" task="a" generation="1">`,
    'What happened: The session of task a "Serve exports over HTTP" reports a requirement: "The fix needs src/ui too"',
    'Since your last turn: task is active, generation 1.',
    "How to handle: the task cannot be done as written, and Pantheon holds its merge until you answer; change the plan, ask the user, or explain why it goes on as planned, then tell the session which. The report is the session's view, not the user's words.",
    '</note>',
  ]);
});

it('tells the lead when a task has not changed since its last update', async () => {
  const { f, lead, worker } = await leadWithTask();
  report(f, worker.id, 'risk', 'The format may change');
  expect(await nextDigest(f, lead.id)).toContain(
    'Since your last turn: task is active, generation 1.',
  );
  report(f, worker.id, 'risk', 'The header may change');
  expect(await nextDigest(f, lead.id)).toContain(
    'Since your last turn: no change (task is active, generation 1).',
  );
});

it('does not present a risk note Pantheon wrote as the report of the session', async () => {
  const { f, ctx, lead, worker } = await leadWithTask();
  const note: LeadNote = {
    id: 'n-thrash',
    at: f.store.now(),
    session_id: worker.id,
    task_id: 'a',
    kind: 'risk',
    text: 'Compaction thrash: the session compacted twice within five minutes.',
    source: 'pantheon',
  };
  const { text } = inboxDigest(ctx, planOf(f, lead.id), [note], 20_000);
  expect(text).toContain(
    'What happened: Pantheon notes a risk on task a "Serve exports over HTTP": Compaction thrash: the session compacted twice within five minutes.',
  );
  expect(text).not.toContain('reports a risk');
  expect(text).not.toContain("The report is the session's view");
});

it('names the state of a user edit in its note and its wake', async () => {
  const { f, lead } = await leadWithTask();
  const edit = (ops: unknown[]) =>
    f.call<{ edit_id: string }>('board.plan.edit', {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: planOf(f, lead.id).plan_version,
      ops,
    });
  edit([{ type: 'set_task', task_id: 'a', patch: { title: 'Serve exports' } }]);
  const held = edit([{ type: 'set_task', task_id: 'a', patch: { goal: 'Exports stream' } }]);
  f.call('board.plan.edit.withdraw', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    edit_id: held.edit_id,
  });
  expect(
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .map((event) => event.payload as LeadNote)
      .filter((note) => note.kind === 'user_edit')
      .map((note) => note.edit_state),
  ).toEqual(['applied', 'pending', 'withdrawn']);
  await settle(f, f.store.must<Session>('sessions', lead.id));
  await nextDigest(f, lead.id);
  const digest = f
    .turns(lead.id)
    .map((turn) => turn.input)
    .join('\n');
  expect(digest).toContain('What happened: the user changed your plan:\n- set title Serve exports');
  expect(digest).toContain(
    `What happened: the user asks to change tasks that have open sessions (edit ${held.edit_id}):\n- set goal Exports stream of task a`,
  );
  expect(digest).toContain(
    `What happened: the user withdrew edit ${held.edit_id}; your plan stays as it is`,
  );
});

it('renders each kind of note from its template', async () => {
  const { f, ctx, lead, worker } = await leadWithTask();
  const at = f.store.now();
  const question = {
    id: 'q1',
    at,
    question: 'Which format?',
    options: ['CSV', 'JSON'],
    recommended: 'CSV',
    assumption: 'CSV',
    blocks: [],
  };
  const plan = { ...planOf(f, lead.id), questions: [question] };
  const notes: LeadNote[] = [
    {
      id: 'n-merged',
      at,
      session_id: worker.id,
      task_id: 'a',
      generation: 1,
      kind: 'merged',
      text: 'The session merged into its source.',
      commit: 'c0ffee1',
      source_branch: 'main',
    },
    {
      id: 'n-stalled',
      at,
      session_id: worker.id,
      task_id: 'a',
      kind: 'stalled',
      text: 'The running turn of the session makes no progress.',
    },
    {
      id: 'n-answer',
      at,
      session_id: '',
      task_id: '',
      kind: 'answer',
      question_id: 'q1',
      answer: 'JSON',
      text: 'Question: Which format?\nAnswer: JSON\nPrevious assumption: CSV',
    },
    {
      id: 'n-routine',
      at,
      session_id: '',
      task_id: '',
      kind: 'routine',
      text: 'Look for stalled tasks',
      routine_id: 'stalls',
      last_run_at: Date.parse('2026-11-16T09:00:00.000Z'),
    },
    {
      id: 'n-external',
      at,
      session_id: '',
      task_id: '',
      kind: 'external',
      text: 'External request from github: Crash',
      subject_key: 'github:o/r#12',
      source: 'github',
    },
    {
      id: 'n-signal',
      at,
      session_id: '',
      task_id: '',
      kind: 'signal',
      text: 'Signal issues that changed since your last digest; call signal_read with an id for details:\n- open: gate_failures, Lint, 3 signals, issue s1',
      signal: 'digest',
    },
    {
      id: 'n-other-plan',
      at,
      session_id: 'direct-lead',
      task_id: '',
      kind: 'other_plan',
      text: 'Fix the parser (direct-lead) planned: Parser fixed; lanes: Core, Docs',
    },
  ];
  const { text } = inboxDigest(ctx, plan, notes, 20_000);
  for (const expected of [
    `<note kind="merged" id="n-merged" task="a" generation="1" session="${worker.id}">\nWhat happened: Task a "Serve exports over HTTP" session ${worker.id} merged into main at c0ffee1.`,
    `<note kind="stalled" id="n-stalled" task="a" session="${worker.id}">\nWhat happened: Task a "Serve exports over HTTP": The running turn of the session makes no progress.`,
    `How to handle: read the last turn of session ${worker.id} first.`,
    '<note kind="answer" id="n-answer">\nWhat happened: the user answered your question: "Which format?" Answer: "JSON". You had assumed: "CSV".',
    '<note kind="routine" id="n-routine" routine="stalls">\nWhat happened: your routine "stalls" is due. Its prompt: "Look for stalled tasks"\nLast run: 2026-11-16T09:00:00.000Z.',
    '<note kind="external" id="n-external" subject="github:o/r#12" source="github">',
    'Since your last turn: first event on this subject.',
    '<note kind="signal" id="n-signal">\nSignal issues that changed since your last digest',
    'How to handle: give each item one outcome: joined to a task, fix task started, told the user, or recorded.',
    '<note kind="other_plan" id="n-other-plan" session="direct-lead">\nWhat happened: Fix the parser (direct-lead) planned: Parser fixed; lanes: Core, Docs\nHow to handle: do not plan the same work; when a request of the user matches it, name that plan to them instead.\n</note>',
  ])
    expect(text).toContain(expected);
});
