import { afterEach, expect, it, vi } from 'vitest';
import {
  id,
  permissionRule,
  type Approval,
  type Project,
  type SessionTurn,
  type WorkflowPolicy,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { MUST_ASK_KINDS, mustAsk } from '../../packages/control/dist/must-ask.js';
import { fixture, insertSession } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

/** A project with one worker session on a linked worktree; ask builds that worker's prompt. */
async function worker() {
  const f = await fixture({ managedWorkspaces: true });
  fixtures.push(f);
  const session = insertSession(f);
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  const ask = (tool: string, summary: string) => {
    const text = summary.replaceAll('{worktree}', worktree);
    const approval: Approval = {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      kind: 'permission',
      session_id: session.id,
      request_id: 'request',
      tool,
      input_hash: 'hash',
      input_summary: text,
      rule: tool === 'Bash' ? permissionRule(tool, { command: text }) : tool,
      decider: 'user',
      state: 'pending',
      created_at: 0,
    };
    return mustAsk(ctxOf(f), f.project.id, approval);
  };
  return { f, session, ask };
}

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  return f.call<WorkflowPolicy>(
    'workflow.policy.set',
    { project_id: f.project.id, ...input },
    row?.revision ?? null,
  );
}

it.each([
  ['Bash', 'git push --force origin feature', true],
  ['Bash', 'git push -f', true],
  ['Bash', 'git push --force-with-lease origin topic', true],
  ['Bash', 'git push origin +topic', true],
  ['Bash', 'git push origin main', true],
  ['Bash', 'git push origin HEAD:refs/heads/master', true],
  ['Bash', 'pnpm test && git push origin main', true],
  ['Bash', 'git push -u origin feature/login', false],
  ['Bash', 'git reset --hard HEAD~1', true],
  ['Bash', 'git reset --soft HEAD~1', false],
  ['Bash', 'git branch -D old-topic', true],
  ['Bash', 'git branch -d merged-topic', false],
  ['Bash', 'git clean -fdx', true],
  ['Bash', 'git clean -n', false],
  ['Bash', 'git status', false],
  ['Bash', 'make release', false],
  ['commandExecution', 'git -C repo push origin main', true],
  ['Write', 'file_path={worktree}/src/a.ts, content=x', false],
  ['Write', 'file_path=/etc/hosts, content=x', true],
  ['Edit', 'file_path=../outside.txt, old_string=a, new_string=b', true],
  ['Edit', 'file_path=src/inside.ts, old_string=a, new_string=b', false],
  ['Read', 'file_path=/etc/hosts', false],
  ['WebFetch', 'url=https://example.com, prompt=summary', true],
  ['WebSearch', 'query=release notes', true],
  ['mcp__vault__read_secret', 'name=database', true],
  ['mcp__keychain__get_credential', 'service=registry', true],
  ['Grep', 'pattern=main', false],
])('asks the user about %s %s: %s', async (tool, summary, expected) => {
  const { ask } = await worker();
  expect(ask(tool, summary)).toBe(expected);
});

it('asks the user about prompts matching the entries the user added, beside the built-in ones', async () => {
  const { f, ask } = await worker();
  expect(ask('Bash', 'npm publish --tag next')).toBe(false);
  expect(ask('mcp__deploy__release', 'target=production')).toBe(false);
  setPolicy(f, { must_ask_extra: ['Bash(npm publish)', 'mcp__deploy__release'] });
  expect(ask('Bash', 'npm publish')).toBe(true);
  expect(ask('Bash', 'npm publish --tag next')).toBe(true);
  expect(ask('Bash', 'cd packages/web && npm publish')).toBe(true);
  expect(ask('mcp__deploy__release', 'target=production')).toBe(true);
  expect(ask('Bash', 'npm pack')).toBe(false);
  expect(ask('Bash', 'git reset --hard origin/topic')).toBe(true);
});

it('asks the user before an agent is created or external work starts, whatever the charter says', async () => {
  const { f } = await worker();
  const project = f.store.must<Project>('projects', f.project.id);
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode: 'auto' },
    project.revision,
  );
  expect(mustAsk(ctxOf(f), f.project.id, 'create_agent')).toBe(true);
  expect(mustAsk(ctxOf(f), f.project.id, 'start_external')).toBe(true);
  expect(mustAsk(ctxOf(f), f.project.id, 'approve_worker_prompts')).toBe(false);
  expect(mustAsk(ctxOf(f), f.project.id, 'accept_milestone')).toBe(false);
  expect(MUST_ASK_KINDS).toEqual([
    'destructive_git',
    'agent_change',
    'external_start',
    'over_budget',
    'outside_sandbox',
  ]);
});

it('asks the user before a plan change once the project spent its budget, and about nothing else', async () => {
  const { f, session, ask } = await worker();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  setPolicy(f, { project_budget: { input_tokens: 100 } });
  expect(ask('Bash', 'git status')).toBe(false);
  expect(mustAsk(ctxOf(f), f.project.id, 'plan_change')).toBe(false);
  skew += 1000;
  const turn = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'work',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  } as SessionTurn);
  f.store.event('turn.completed', turn, f.project.id, {});
  expect(mustAsk(ctxOf(f), f.project.id, 'plan_change')).toBe(true);
  expect(ask('Bash', 'git status')).toBe(false);
  expect(mustAsk(ctxOf(f), f.project.id, 'accept_milestone')).toBe(false);
});
