import { expect, it } from 'vitest';
import type {
  LeadNote,
  Principal,
  Project,
  Session,
  SettingProposal,
  WorkflowPolicy,
} from '@pantheon/domain';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

const SAID = 'From now on, propose plan changes before you start them. Run one task at a time.';

/** A project whose Assistant heard the user's standing rules, and a way to call tools as a resident. */
async function settingFixture() {
  const f = await workbenchFixture();
  const resident = (kind: 'assistant' | 'triage') =>
    f.call<Session>('resident.open', { project_id: f.project.id, kind });
  const assistant = resident('assistant');
  f.call('session.send', { session_id: assistant.id, input: SAID }, assistant.revision);
  const as = <T = unknown>(session: Session, type: 'setting.propose', input: object) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, session.id));
  const refusal = async (run: () => unknown) => {
    try {
      await run();
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'accepted';
  };
  const policy = () => f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  const notes = (sessionId: string) =>
    f.store
      .kindEvents(f.project.id, ['lead.note_added'])
      .filter((event) => event.aggregate_id === sessionId)
      .map((event) => event.payload as LeadNote)
      .filter((note) => note.kind === 'setting_proposal');
  return { f, resident, assistant, as, refusal, policy, notes };
}

it('records a proposal that quotes the user and refuses an unquoted rule, another agent and an invalid value', async () => {
  const { f, resident, assistant, as, refusal } = await settingFixture();
  expect(
    await refusal(() =>
      as(assistant, 'setting.propose', {
        param: 'plan_changes',
        value: 'confirm',
        quote: 'Never change the plan without me',
      }),
    ),
  ).toBe('invalid_input');
  expect(
    await refusal(() =>
      as(assistant, 'setting.propose', {
        param: 'max_parallel',
        value: 'one',
        quote: 'Run one task at a time.',
      }),
    ),
  ).toBe('invalid_input');
  const triage = resident('triage');
  expect(
    await refusal(() =>
      as(triage, 'setting.propose', {
        param: 'max_parallel',
        value: 1,
        quote: 'Run one task at a time.',
      }),
    ),
  ).toBe('permission_denied');
  expect(f.control.workflowPolicy(user, f.project.id).max_parallel_limit).toBe(3);
  expect(
    await refusal(() =>
      as(assistant, 'setting.propose', {
        param: 'max_parallel',
        value: 5,
        quote: 'Run one task at a time.',
      }),
    ),
  ).toBe('invalid_input');
  expect(f.store.list('setting_proposals')).toEqual([]);

  const proposal = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'plan_changes',
    value: 'confirm',
    quote: 'propose plan changes before you start them',
  });
  expect(f.store.list('setting_proposals')).toEqual([
    {
      id: proposal.id,
      revision: 1,
      project_id: f.project.id,
      session_id: assistant.id,
      param: 'plan_changes',
      current: 'auto',
      value: 'confirm',
      quote: 'propose plan changes before you start them',
      state: 'pending',
      at: proposal.at,
    },
  ]);
  expect(
    f.store
      .events(0, f.project.id, 1000, ['setting_proposal.created'])
      .map((event) => event.aggregate_id),
  ).toEqual([proposal.id]);
});

it('applies an approved policy setting as the next policy version and tells the Assistant', async () => {
  const { f, assistant, as, policy, notes } = await settingFixture();
  const proposal = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'max_parallel',
    value: 1,
    quote: 'Run one task at a time.',
  });
  expect(policy()).toBeUndefined();
  const resolved = f.call<SettingProposal>('setting.proposal.resolve', {
    proposal_id: proposal.id,
    decision: 'approve',
  });
  expect(policy()).toMatchObject({ max_parallel: 1, policy_version: 1 });
  expect(resolved).toMatchObject({ state: 'applied', policy_version: 1 });
  expect(f.control.workflowPolicy(user, f.project.id).max_parallel).toBe(1);
  expect(notes(assistant.id)).toHaveLength(1);
  expect(notes(assistant.id)[0]!.text).toContain('max_parallel');

  const charter = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'charter.accept_milestone',
    value: 'ask',
    quote: 'propose plan changes before you start them',
  });
  f.call('setting.proposal.resolve', { proposal_id: charter.id, decision: 'approve' });
  expect(policy()).toMatchObject({
    max_parallel: 1,
    policy_version: 2,
    charter: { accept_milestone: 'ask', approve_worker_prompts: 'on' },
  });
});

it('sets an approved external events mode on the project', async () => {
  const { f, assistant, as } = await settingFixture();
  const proposal = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'external_events',
    value: 'approve',
    quote: 'propose plan changes before you start them',
  });
  f.call('setting.proposal.resolve', { proposal_id: proposal.id, decision: 'approve' });
  expect(f.store.must<Project>('projects', f.project.id).external_events).toBe('approve');
});

it('leaves the setting alone on decline and wakes the Assistant with the decision', async () => {
  const { f, assistant, as, policy, notes } = await settingFixture();
  const wakes = () => f.turns(assistant.id).filter((turn) => turn.origin === 'tracker');
  const proposal = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'dispatch_paused',
    value: true,
    quote: 'Run one task at a time.',
  });
  const declined = f.call<SettingProposal>('setting.proposal.resolve', {
    proposal_id: proposal.id,
    decision: 'decline',
  });
  expect(declined).toMatchObject({ state: 'declined' });
  expect(declined).not.toHaveProperty('policy_version');
  expect(policy()).toBeUndefined();
  expect(notes(assistant.id)).toHaveLength(1);
  expect(notes(assistant.id)[0]!.text).toContain('declined');
  expect(wakes().length).toBeGreaterThan(0);
  expect(
    f.store
      .events(0, f.project.id, 1000, ['setting_proposal.resolved'])
      .map((event) => event.aggregate_id),
  ).toEqual([proposal.id]);
});

it('lists a pending setting proposal in needs_you.list until the user resolves it', async () => {
  const { f, assistant, as } = await settingFixture();
  const items = () =>
    f.control.needsYou(user, f.project.id).items.filter((each) => each.kind === 'setting.proposal');
  const proposal = as<SettingProposal>(assistant, 'setting.propose', {
    param: 'plan_changes',
    value: 'confirm',
    quote: 'propose plan changes before you start them',
  });
  expect(items()).toMatchObject([
    {
      source: { table: 'setting_proposals', id: proposal.id },
      session_id: assistant.id,
      reason: 'setting_proposal_awaiting_decision',
      primary: 'setting.proposal.resolve',
      setting_proposal: {
        id: proposal.id,
        param: 'plan_changes',
        current: 'auto',
        value: 'confirm',
        quote: 'propose plan changes before you start them',
      },
      actions: [
        { command: 'setting.proposal.resolve', allowed: true, decision: 'approve' },
        { command: 'setting.proposal.resolve', allowed: true, decision: 'reject' },
      ],
    },
  ]);
  expect(items()[0]!.setting_proposal!.waited_ms).toBeGreaterThanOrEqual(0);
  f.call('setting.proposal.resolve', { proposal_id: proposal.id, decision: 'approve' });
  expect(items()).toEqual([]);
});
