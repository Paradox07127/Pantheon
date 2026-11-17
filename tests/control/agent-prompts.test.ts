import { expect, it } from 'vitest';
import type { AgentProfile, Session, SessionSpec } from '@pantheon/domain';
import { sessionTools } from '@pantheon/protocol';
import { leadSessionTools, type ControlContext } from '../../packages/control/dist/context.js';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const DISPATCH_AND_PLAN_WRITES = [
  'start_task',
  'merge_task',
  'stop_task',
  'message_task',
  'request_review',
  'accept_task',
  'update_board',
  'edit_board',
];

/** The resident session of the template's agent, opened on a first message. */
async function resident(f: Fixture, template: AgentProfile['template']) {
  const session =
    template === 'assistant' || template === 'triage'
      ? f.call<Session>('resident.open', { project_id: f.project.id, kind: template })
      : f.call<Session>('resident.open', {
          agent_id: f.call<AgentProfile>('agent.create', {
            project_id: f.project.id,
            template,
            name: `The ${template} agent`,
            role: template,
            instructions: 'You keep the changelog current.',
          }).id,
        });
  f.call('session.send', { session_id: session.id, input: 'Hello' }, session.revision);
  const spec = () =>
    [...f.start.mock.calls, ...f.resume.mock.calls]
      .map(([each]) => each as SessionSpec)
      .find((each) => each.platform_session_id === session.id);
  await eventually(
    () => spec() !== undefined,
    () => f.control.tick(),
  );
  const ctx = f.control['ctx'] as ControlContext;
  return {
    prompt: spec()!.control_instructions!,
    tools: leadSessionTools(ctx, f.store.must<Session>('sessions', session.id))!,
  };
}

const leadTools: Record<string, string> = sessionTools.lead;

it.each(['assistant', 'triage', 'ideas', 'goals', 'custom'] as const)(
  'names in the %s resident prompt only lead tools its session has',
  async (template) => {
    const f = await workbenchFixture();
    const { prompt, tools } = await resident(f, template);
    for (const name of new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)))
      if (Object.hasOwn(leadTools, name)) expect(tools, name).toContain(leadTools[name]);
    if (template === 'ideas' || template === 'goals')
      for (const name of DISPATCH_AND_PLAN_WRITES)
        expect(prompt).not.toMatch(new RegExp(`\\b${name}\\b`));
  },
);

it('tells the assistant resident to give every task its kind, domain and tier', async () => {
  const f = await workbenchFixture();
  const { prompt } = await resident(f, 'assistant');
  expect(prompt).toContain('Give every task its kind, a domain and a tier');
});
