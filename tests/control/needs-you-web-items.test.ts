import { afterEach, expect, it } from 'vitest';
import type { Approval, ApprovalQuestion, Retrospective } from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function opened() {
  const f = await fixture({ managedWorkspaces: true });
  fixtures.push(f);
  return f;
}

const items = (f: Fixture) => f.control.needsYou(user, f.project.id).items;

it('gives a question item its questions and options', async () => {
  const f = await opened();
  insertSession(f, { id: 'asker', turn_count: 1 });
  const questions: ApprovalQuestion[] = [
    {
      question: 'Which format?',
      header: 'Format',
      options: [
        { label: 'CSV', description: 'Opens in spreadsheets' },
        { label: 'JSON', description: 'Keeps nested fields' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which columns?',
      header: 'Columns',
      options: [
        { label: 'Name', description: 'The row name' },
        { label: 'Size', description: 'The file size' },
      ],
      multiSelect: true,
    },
  ];
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
    questions,
  });
  expect(items(f).find((item) => item.source.id === 'ask')?.questions).toEqual(questions);
});

function withRetrospectives(f: Fixture) {
  insertSession(f, { id: 'lead', turn_count: 1 });
  for (const index of [1, 2])
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${index}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${index}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: index,
    });
}

it('lists and counts nothing for an improvement candidate stored earlier', async () => {
  const f = await opened();
  withRetrospectives(f);
  f.store.db.prepare('INSERT INTO improvements VALUES(?,?,?)').run(
    'stored-candidate',
    1,
    JSON.stringify({
      id: 'stored-candidate',
      revision: 1,
      project_id: f.project.id,
      source: 'lead',
      lead_session_id: 'lead',
      retrospective_ids: ['retrospective-1', 'retrospective-2'],
      status: 'candidate',
      change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 2 },
      proposed_at: f.store.now(),
    }),
  );
  expect(items(f).filter((item) => item.source.id === 'stored-candidate')).toEqual([]);
  const summary = f.control
    .projectsSummary(user)
    .projects.find((project) => project.project_id === f.project.id);
  expect(summary?.needs_you).toBe(0);
  expect(summary?.waiting).toBeUndefined();
});
