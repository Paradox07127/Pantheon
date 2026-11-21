import { afterEach, expect, it } from 'vitest';
import {
  DomainError,
  type Principal,
  type Project,
  type ProjectRead,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { CHARTER_POWERS, charterMode, chartered } from '../../packages/control/dist/charter.js';
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
const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const modes = (f: Fixture) =>
  Object.fromEntries(
    CHARTER_POWERS.map((power) => [power, charterMode(ctxOf(f), f.project.id, power)]),
  );
function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  return f.call<WorkflowPolicy>(
    'workflow.policy.set',
    { project_id: f.project.id, ...input },
    row?.revision ?? null,
  );
}
function setExternalEvents(f: Fixture, mode: 'off' | 'approve' | 'auto') {
  const project = f.store.must<Project>('projects', f.project.id);
  f.call('project.externalEvents.set', { project_id: f.project.id, mode }, project.revision);
}
function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000_000,
  };
}
const powerUses = (f: Fixture) =>
  f.store.events(0, f.project.id).filter((event) => event.kind === 'charter.power_used');

it('lets the coordinator act on its own by default except for creating agents and starting external work', async () => {
  const f = await opened();
  expect(modes(f)).toEqual({
    approve_worker_prompts: 'on',
    answer_worker_questions: 'on',
    create_agent: 'ask',
    merge_out_of_scope: 'on',
    start_external: 'off',
  });
});

it('reads a project override of one power and keeps the others', async () => {
  const f = await opened();
  setPolicy(f, { charter: { answer_worker_questions: 'ask', merge_out_of_scope: 'off' } });
  expect(modes(f)).toMatchObject({
    approve_worker_prompts: 'on',
    answer_worker_questions: 'ask',
    merge_out_of_scope: 'off',
    create_agent: 'ask',
  });
  setPolicy(f, { charter: { approve_worker_prompts: 'ask' } });
  expect(modes(f)).toMatchObject({
    approve_worker_prompts: 'ask',
    answer_worker_questions: 'ask',
    merge_out_of_scope: 'off',
  });
});

it('follows the external events setting for external starts', async () => {
  const f = await opened();
  setExternalEvents(f, 'approve');
  expect(charterMode(ctxOf(f), f.project.id, 'start_external')).toBe('ask');
  setExternalEvents(f, 'auto');
  expect(charterMode(ctxOf(f), f.project.id, 'start_external')).toBe('on');
});

it('refuses to let the coordinator create agents without asking', async () => {
  const f = await opened();
  let error: unknown;
  try {
    setPolicy(f, { charter: { create_agent: 'on' } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe('invalid_input');
  expect(charterMode(ctxOf(f), f.project.id, 'create_agent')).toBe('ask');
});

it("records a lead's use of a power and lets the user act without a record", async () => {
  const f = await opened();
  const subject = f.store.must<Project>('projects', f.project.id);
  expect(chartered(ctxOf(f), user, 'merge_out_of_scope', subject)).toBe('on');
  expect(powerUses(f)).toEqual([]);
  setPolicy(f, { charter: { merge_out_of_scope: 'off' } });
  const lead = leadOf(f);
  expect(chartered(ctxOf(f), lead, 'merge_out_of_scope', subject)).toBe('off');
  expect(chartered(ctxOf(f), lead, 'create_agent', subject)).toBe('ask');
  expect(powerUses(f).map((event) => event.payload)).toEqual([
    { power: 'merge_out_of_scope', mode: 'off', subject: subject.id, session_id: lead.session_id },
    { power: 'create_agent', mode: 'ask', subject: subject.id, session_id: lead.session_id },
  ]);
});

it('shows the lead its charter and plan changes setting in project_read', async () => {
  const f = await opened();
  setPolicy(f, { plan_changes: 'confirm', charter: { accept_milestone: 'off' } });
  const read = f.control.projectRead(leadOf(f), f.project.id) as ProjectRead;
  expect(read.lead!.workflow.plan_changes).toBe('confirm');
  expect(read.lead!.workflow.charter).toEqual({
    approve_worker_prompts: 'on',
    answer_worker_questions: 'on',
    create_agent: 'ask',
    accept_milestone: 'off',
    merge_out_of_scope: 'on',
    start_external: 'off',
  });
});
