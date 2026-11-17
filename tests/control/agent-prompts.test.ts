import { expect, it } from 'vitest';
import type { AgentProfile, Principal, Session, SessionSpec } from '@pantheon/domain';
import { sessionTools } from '@pantheon/protocol';
import { leadSessionTools, type ControlContext } from '../../packages/control/dist/context.js';
import { LEAD_INSTRUCTIONS } from '../../packages/control/dist/agent-prompts.js';
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
    session,
    prompt: spec()!.control_instructions!,
    tools: leadSessionTools(ctx, f.store.must<Session>('sessions', session.id))!,
  };
}

const as = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60_000,
});

const guide = <T>(f: Fixture, sessionId: string, name: string) =>
  f.call<Promise<T>>('agent.guide', { name }, null, as(f, sessionId));

const leadTools: Record<string, string> = sessionTools.lead;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

it.each(['assistant', 'triage', 'ideas', 'goals', 'custom'] as const)(
  'names in the %s resident prompt only lead tools its session has, with its name and role filled in',
  async (template) => {
    const f = await workbenchFixture();
    const { session, prompt, tools } = await resident(f, template);
    for (const name of new Set(prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)))
      if (Object.hasOwn(leadTools, name)) expect(tools, name).toContain(leadTools[name]);
    if (template === 'ideas' || template === 'goals')
      for (const name of DISPATCH_AND_PLAN_WRITES)
        expect(prompt).not.toMatch(new RegExp(`\\b${name}\\b`));
    const profile = f.store.must<AgentProfile>('agents', session.resident!.agent_id!);
    expect(prompt).toContain(
      `You are ${profile.name}, a resident agent of this project (${profile.role}).`,
    );
    expect(prompt).not.toMatch(/\{agent_(?:name|role)\}/);
  },
);

it.each(['assistant', 'triage'] as const)(
  'keeps the %s resident prompt under 3,500 words',
  async (template) => {
    const f = await workbenchFixture();
    const { prompt } = await resident(f, template);
    // The project memory instructions the session adds ahead of the resident prompt are not counted.
    const own = prompt.slice(prompt.indexOf('You are working inside Pantheon'));
    expect(own.length).toBeLessThan(prompt.length);
    expect(words(own)).toBeLessThan(3500);
  },
);

it('lists to the ideas resident only the guides of its template and groups', async () => {
  const f = await workbenchFixture();
  const { session, prompt } = await resident(f, 'ideas');
  expect(prompt).toContain('idea_curation — ');
  expect(prompt).not.toContain('merge_and_gate');
  const index = await guide<{ guides: { name: string }[] }>(f, session.id, 'unknown');
  expect(index.guides.map((each) => each.name)).toEqual(['handoff', 'idea_curation']);
});

it('gives the assistant the kind, domain and tier rule in its dispatch module and the worker_brief guide', async () => {
  const f = await workbenchFixture();
  const { session, prompt } = await resident(f, 'assistant');
  expect(prompt).toContain('and its kind, domain and tier, following lead.routing');
  expect(prompt).toContain('worker_brief — ');
  const brief = await guide<{ text: string }>(f, session.id, 'worker_brief');
  expect(brief.text).toContain('Give each task its kind, a domain and a tier');
  expect(brief.text).toContain('more than two paths or a directory make it at least t2');
});

it('puts the long brief of a task in its brief field in the dispatch module and the worker_brief guide', async () => {
  const f = await workbenchFixture();
  const { session, prompt } = await resident(f, 'assistant');
  expect(prompt).toContain(
    "Context that does not fit the goal goes in the task's brief field (up to 2000 characters), not in message_task.",
  );
  const brief = await guide<{ text: string }>(f, session.id, 'worker_brief');
  expect(brief.text).toContain(
    "write it in the task's brief field (up to 2000 characters), which the session reads when it opens.",
  );
  expect(brief.text).not.toContain('send it with message_task as soon as the session opens');
});

it('does not tell a new goals session that takes over to rewrite the plan with update_board', async () => {
  const f = await workbenchFixture();
  const { session } = await resident(f, 'goals');
  const usage = { context_tokens: 90_000, context_window: 100_000 };
  await eventually(
    () =>
      f.store.must<Session>('sessions', session.id).state === 'open' &&
      f.turns(session.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
  f.call(
    'session.send',
    {
      session_id: session.id,
      input: `fixture-script\n${JSON.stringify([{ say: 'Noted' }, { usage }])}`,
    },
    f.store.must<Session>('sessions', session.id).revision,
  );
  const successor = () =>
    f.store
      .list<Session>('sessions')
      .find(
        (each) =>
          each.resident?.agent_id === session.resident!.agent_id &&
          each.id !== session.id &&
          each.state !== 'closed',
      );
  await eventually(
    () => successor() !== undefined && f.turns(successor()!.id).length > 0,
    () => f.control.tick(),
    10_000,
  );
  const [takeover] = f.turns(successor()!.id);
  expect(takeover!.input).toContain('take over');
  expect(takeover!.input).not.toContain('update_board');
});

it('tells a lead to answer a worker question only from a cited source and otherwise leave it to the user', () => {
  expect(LEAD_INSTRUCTIONS).toContain('answer_worker_question');
  for (const source of ['quoted user words', 'plan assumption', 'memory entry', 'earlier answer'])
    expect(LEAD_INSTRUCTIONS).toContain(source);
  expect(LEAD_INSTRUCTIONS).not.toContain('pass_worker_question');
});
