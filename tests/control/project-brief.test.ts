import { expect, it } from 'vitest';
import type { Approval, LeadQuestion, Principal, Session } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
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
