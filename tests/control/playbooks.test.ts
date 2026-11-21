import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { id, type Project, type Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import {
  LEAD_INSTRUCTIONS,
  LEAD_PLAYBOOK,
  leadInstructions,
} from '../../packages/control/dist/agent-prompts.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { fixture, registerWorkspace } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const editedSections = {
  before_you_plan: 'Read the code the request touches, then plan.',
  routing: '- Send every task to codex with high effort.\n### Exceptions\n- None.',
  replies: '- Reply in one line.',
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
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  return f;
}

function leadSession(f: Fixture): Session {
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
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
    lead: true,
  });
}

const section = (heading: string, body: string, next: string) =>
  `## ${heading}\n${body}\n\n## ${next}\n`;

it('composes the lead instructions from the behaviour sections written in code', () => {
  expect(LEAD_PLAYBOOK).toEqual({
    before_you_plan: expect.stringMatching(/^- Call project_read, then read the code/),
    routing: expect.stringMatching(/^- Give every task its kind, a domain and a tier/),
    replies: expect.stringMatching(/^- After a turn that changed the plan/),
  });
  expect(leadInstructions(LEAD_PLAYBOOK)).toBe(LEAD_INSTRUCTIONS);
  expect(LEAD_INSTRUCTIONS).toContain(
    section('Before you plan', LEAD_PLAYBOOK.before_you_plan, 'The plan'),
  );
  expect(LEAD_INSTRUCTIONS).toContain(section('Routing', LEAD_PLAYBOOK.routing, 'Dispatching'));
  expect(LEAD_INSTRUCTIONS.endsWith(`## Replies\n${LEAD_PLAYBOOK.replies}`)).toBe(true);
});

it('starts a lead with the sections written in code although the project stores an edited playbook', async () => {
  const f = await setup();
  const stored = f.store.db.prepare('INSERT INTO playbooks (id, revision, data) VALUES (?, 1, ?)');
  for (const runtime of [undefined, f.adapter.name])
    stored.run(
      id(),
      JSON.stringify({
        project_id: f.project.id,
        ...(runtime ? { runtime } : {}),
        version: 1,
        versions: { 1: editedSections },
      }),
    );
  const lead = leadSession(f);
  const prompt = workbenchSessionSpec(
    f.control['ctx'] as ControlContext,
    lead,
  ).control_instructions!;
  expect(prompt).toContain(LEAD_INSTRUCTIONS);
  for (const text of Object.values(editedSections)) expect(prompt).not.toContain(text);
  expect(f.store.must<Session>('sessions', lead.id)).not.toHaveProperty('playbook');
});
