import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id, type Playbook, type Principal, type Project, type Session } from '@pantheon/domain';
import type { PlaybookRead } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { LEAD_INSTRUCTIONS } from '../../packages/control/dist/agent-prompts.js';
import { playbookVersion, setPlaybookVersion } from '../../packages/control/dist/playbooks.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { fixture, registerWorkspace } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const codexSections = {
  before_you_plan: 'Read the code the request touches, then plan.',
  routing: '- Send every task to codex with high effort.\n### Exceptions\n- None.',
  replies: '- Reply in one line.',
};
const defaultSections = {
  before_you_plan: 'Plan right away.',
  routing: '- Keep every task on t1.',
  replies: '- Reply with the task ids.',
};

async function setup() {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-playbooks-'));
  const f = await fixture({
    managedWorkspaces: true,
    controlOptions: {
      userConfigDir: configDir,
      issueSessionCredential: () => ({
        token_file: path.join(configDir, 'token'),
        daemon_url: 'http://127.0.0.1:4321',
      }),
    },
  });
  const codex = new FixtureAdapter();
  codex.name = 'codex';
  f.control.adapters.set(codex.name, codex);
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  return f;
}

const ctxOf = (f: Fixture) => f.control['ctx'] as ControlContext;

function leadSession(f: Fixture, runtime: string): Session {
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', f.project.id).roots[0]!,
    base_ref: 'HEAD',
  });
  return f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
}

/** The instructions a planning lead of runtime starts its session with. */
const leadPrompt = (f: Fixture, runtime: string) =>
  workbenchSessionSpec(ctxOf(f), leadSession(f, runtime)).control_instructions!;

const get = (f: Fixture, runtime?: string, principal?: Principal) =>
  f.call<PlaybookRead>(
    'playbook.get',
    { project_id: f.project.id, ...(runtime ? { runtime } : {}) },
    null,
    principal,
  );

const set = (f: Fixture, input: Record<string, unknown>, principal?: Principal) =>
  f.call<PlaybookRead>('playbook.set', { project_id: f.project.id, ...input }, null, principal);

const section = (heading: string, body: string, next: string) =>
  `## ${heading}\n${body}\n\n## ${next}\n`;

it('composes the lead prompt from the text in code while the project stores no playbook', async () => {
  const f = await setup();
  expect(leadPrompt(f, 'codex')).toContain(LEAD_INSTRUCTIONS);
  const read = get(f, 'codex');
  expect(read).toEqual({
    project_id: f.project.id,
    runtime: 'codex',
    version: 0,
    versions: [],
    source: 'code',
    sections: {
      before_you_plan: expect.stringMatching(/^- Call project_read, then read the code/),
      routing: expect.stringMatching(/^- Give every task its kind, a domain and a tier/),
      replies: expect.stringMatching(/^- After a turn that changed the plan/),
    },
    built_in: read.sections,
  });
  expect(LEAD_INSTRUCTIONS).toContain(
    section('Before you plan', read.sections.before_you_plan, 'The plan'),
  );
  expect(LEAD_INSTRUCTIONS).toContain(section('Routing', read.sections.routing, 'Dispatching'));
  expect(LEAD_INSTRUCTIONS.endsWith(`## Replies\n${read.sections.replies}`)).toBe(true);
  expect(f.store.list<Playbook>('playbooks')).toEqual([]);
});

it('changes only the behaviour sections of a codex lead when the user stores a codex playbook', async () => {
  const f = await setup();
  const code = get(f).sections;
  const codexLead = leadSession(f, 'codex'),
    otherLead = leadSession(f, f.adapter.name);
  const prompt = (session: Session) =>
    workbenchSessionSpec(ctxOf(f), session).control_instructions!;
  const before = prompt(codexLead),
    other = prompt(otherLead);
  expect(set(f, { runtime: 'codex', base_version: 0, sections: codexSections })).toEqual({
    project_id: f.project.id,
    runtime: 'codex',
    version: 1,
    versions: [1],
    source: 'runtime',
    sections: codexSections,
    built_in: code,
  });
  const composed = LEAD_INSTRUCTIONS.replace(
    code.before_you_plan,
    () => codexSections.before_you_plan,
  )
    .replace(code.routing, () => codexSections.routing)
    .replace(code.replies, () => codexSections.replies);
  expect(composed).not.toBe(LEAD_INSTRUCTIONS);
  expect(prompt(codexLead)).toBe(before.replace(LEAD_INSTRUCTIONS, () => composed));
  expect(prompt(otherLead)).toBe(other);
  expect(get(f)).toMatchObject({ version: 0, source: 'code', sections: code });
});

it('gives a lead the project default playbook when its runtime has none of its own', async () => {
  const f = await setup();
  set(f, { base_version: 0, sections: defaultSections });
  set(f, { runtime: 'codex', base_version: 0, sections: codexSections });
  expect(leadPrompt(f, f.adapter.name)).toContain(
    section('Routing', defaultSections.routing, 'Dispatching'),
  );
  expect(leadPrompt(f, 'codex')).toContain(
    section('Routing', codexSections.routing, 'Dispatching'),
  );
  expect(get(f, 'claude')).toEqual({
    project_id: f.project.id,
    runtime: 'claude',
    version: 0,
    versions: [],
    source: 'default',
    sections: defaultSections,
    built_in: expect.objectContaining({ routing: expect.any(String) }),
  });
  expect(get(f)).toMatchObject({ version: 1, source: 'default', sections: defaultSections });
});

it('stores each save as a new version and applies the version another module makes current', async () => {
  const f = await setup();
  const ctx = ctxOf(f);
  const second = { ...codexSections, routing: '- Send every task to codex with medium effort.' };
  set(f, { runtime: 'codex', base_version: 0, sections: codexSections });
  expect(() => set(f, { runtime: 'codex', base_version: 0, sections: second })).toThrow(
    expect.objectContaining({ code: 'version_conflict' }),
  );
  expect(set(f, { runtime: 'codex', base_version: 1, sections: second })).toMatchObject({
    version: 2,
  });
  expect(leadPrompt(f, 'codex')).toContain(second.routing);
  expect(playbookVersion(ctx, f.project.id, 'codex')).toBe(2);
  expect(playbookVersion(ctx, f.project.id, undefined)).toBe(0);

  setPlaybookVersion(ctx, f.project.id, 'codex', 1);
  expect(playbookVersion(ctx, f.project.id, 'codex')).toBe(1);
  expect(leadPrompt(f, 'codex')).toContain(
    section('Routing', codexSections.routing, 'Dispatching'),
  );
  expect(leadPrompt(f, 'codex')).not.toContain(second.routing);
  expect(get(f, 'codex')).toMatchObject({ version: 1, sections: codexSections });
  expect(() => setPlaybookVersion(ctx, f.project.id, 'codex', 4)).toThrow();
  expect(() => setPlaybookVersion(ctx, f.project.id, undefined, 1)).toThrow();

  expect(set(f, { runtime: 'codex', base_version: 1, sections: defaultSections })).toMatchObject({
    version: 3,
  });
  const [stored] = f.store.list<Playbook>('playbooks');
  expect(Object.keys(stored!.versions)).toEqual(['1', '2', '3']);
  expect(stored!.versions[2]).toEqual(second);
});

it('reads a stored version by its number and lists the stored numbers with the built-in text', async () => {
  const f = await setup();
  const code = get(f).sections;
  const second = { ...codexSections, routing: '- Send every task to codex with medium effort.' };
  set(f, { runtime: 'codex', base_version: 0, sections: codexSections });
  set(f, { runtime: 'codex', base_version: 1, sections: second });
  const read = (version: number) =>
    f.call<PlaybookRead>('playbook.get', { project_id: f.project.id, runtime: 'codex', version });
  expect(get(f, 'codex')).toMatchObject({ version: 2, versions: [1, 2], built_in: code });
  expect(read(1)).toMatchObject({
    version: 2,
    versions: [1, 2],
    source: 'runtime',
    sections: codexSections,
  });
  expect(() => read(3)).toThrow(expect.objectContaining({ code: 'not_found' }));
});

it('removes a stored playbook so its leads fall back to the project default and then the code', async () => {
  const f = await setup();
  const code = get(f).sections;
  const remove = (input: Record<string, unknown>, principal?: Principal) =>
    f.call<PlaybookRead>(
      'playbook.remove',
      { project_id: f.project.id, ...input },
      null,
      principal,
    );
  set(f, { base_version: 0, sections: defaultSections });
  set(f, { runtime: 'codex', base_version: 0, sections: codexSections });
  expect(() => remove({ runtime: 'codex', base_version: 0 })).toThrow(
    expect.objectContaining({ code: 'version_conflict' }),
  );
  const session = leadSession(f, 'codex');
  const lead: Principal = {
    id: `session:${session.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000,
  };
  expect(() => remove({ runtime: 'codex', base_version: 1 }, lead)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );

  expect(remove({ runtime: 'codex', base_version: 1 })).toMatchObject({
    version: 0,
    versions: [],
    source: 'default',
    sections: defaultSections,
  });
  expect(leadPrompt(f, 'codex')).toContain(
    section('Routing', defaultSections.routing, 'Dispatching'),
  );
  expect(remove({ base_version: 1 })).toMatchObject({ version: 0, source: 'code', sections: code });
  expect(get(f, 'codex')).toMatchObject({ source: 'code', sections: code });
  expect(f.store.list<Playbook>('playbooks')).toEqual([]);
  expect(
    f.store
      .kindEvents(f.project.id, ['playbook.changed'])
      .slice(-2)
      .map((event) => event.payload),
  ).toEqual([{ runtime: 'codex', version: 0 }, { version: 0 }]);
  expect(() => remove({ base_version: 0 })).toThrow(expect.objectContaining({ code: 'not_found' }));
});

it('refuses a playbook with a missing or empty section or a line that opens a section', async () => {
  const f = await setup();
  for (const sections of [
    { before_you_plan: 'Plan.', routing: 'Route.' },
    { ...codexSections, replies: '  \n ' },
    { ...codexSections, routing: '- Route.\n## Dispatching\n- Start every task.' },
    { ...codexSections, before_you_plan: '## Before you plan\nPlan.' },
  ])
    expect(() => set(f, { base_version: 0, sections })).toThrow();
  expect(f.store.list<Playbook>('playbooks')).toEqual([]);
});

it('lets only the user read and change playbooks', async () => {
  const f = await setup();
  const session = leadSession(f, 'codex');
  const lead: Principal = {
    id: `session:${session.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: session.id,
    expires_at: f.store.now() + 60_000,
  };
  expect(() => get(f, 'codex', lead)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  expect(() =>
    set(f, { runtime: 'codex', base_version: 0, sections: codexSections }, lead),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(f.store.list<Playbook>('playbooks')).toEqual([]);
});
