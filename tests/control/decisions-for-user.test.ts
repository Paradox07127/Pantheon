import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  Principal,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { DecisionForUser } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Plain = Awaited<ReturnType<typeof fixture>>;
type Caller = Pick<Plain, 'call' | 'store' | 'project' | 'control'>;

const plains: Plain[] = [];
afterEach(async () => {
  for (const f of plains.splice(0)) await f.close();
});

async function plain() {
  const f = await fixture({ managedWorkspaces: true });
  plains.push(f);
  return f;
}

const ctxOf = (f: Caller) => (f.control as unknown as { ctx: ControlContext }).ctx;

/** A session running a turn; prompt feeds it a runtime permission request. */
async function promptFixture() {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const session = await f.create('Build it');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const turn: SessionTurn = f.turns(session.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', session.id).state === 'running',
    () => f.control.tick(),
  );
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  let sequence = 100;
  const prompt = async (name: string, extra: Partial<AgentEvent> = {}) => {
    sequence++;
    agentEvent(ctxOf(f), session.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool: 'Edit',
      detail: {
        input: { file_path: `${worktree}/src/${name}.ts`, old_string: 'a', new_string: 'b' },
      },
      ...extra,
    } as AgentEvent);
    await f.control.tick();
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  /** A prompt the stored project rule for Edit answers. */
  let ruleAdded = false;
  const ruled = async (name: string) => {
    if (!ruleAdded)
      f.call('permission.rule.add', {
        project_id: f.project.id,
        rule: 'Edit',
        session_id: session.id,
      });
    ruleAdded = true;
    return prompt(name, { project_rule_supported: true });
  };
  return { f, session, prompt, ruled };
}

type Act = () => Promise<{ f: Caller; match: Record<string, unknown> }>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };

/** What by did in a project, with the personal key let to answer every kind. */
const answeredBy =
  (by: Principal, act: (f: Plain, by: Principal) => Record<string, unknown>): Act =>
  async () => {
    const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-decisions-'));
    const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir } });
    plains.push({
      ...f,
      close: async () => {
        await f.close();
        rmSync(userConfigDir, { recursive: true, force: true });
      },
    });
    return { f, match: act(f, by) };
  };

it.each<[string, Act, DecisionForUser['kind'] | undefined]>([
  [
    'a prompt answered by a stored project rule',
    async () => {
      const { f, session, ruled } = await promptFixture();
      const approval = await ruled('a');
      return {
        f,
        match: { approval_id: approval.id, rule: 'Edit', session_id: session.id, tool: 'Edit' },
      };
    },
    'prompt_by_rule',
  ],
  [
    'the personal key marking the project seen',
    answeredBy(personal, (f, by) => {
      f.call('project.seen', { project_id: f.project.id }, null, by);
      return {};
    }),
    undefined,
  ],
])('lists what %s decided', async (_label, act, kind) => {
  const { f, match } = await act();
  const { items } = f.control.decisionsForUser(user, f.project.id);
  expect(items).toEqual(kind ? [expect.objectContaining({ kind, ...match })] : []);
  if (kind) expect(items[0]!.at).toBeGreaterThan(0);
});

it('drops the decisions made before since and lists the rest newest first', async () => {
  const { f, ruled } = await promptFixture();
  const first = await ruled('a');
  // since is compared with the approval.approved event, which can be written after the approval row.
  const firstAt = f.control.decisionsForUser(user, f.project.id).items[0]!.at;
  await eventually(() => f.store.now() > firstAt);
  const since = f.store.now();
  const second = await ruled('b');
  const ids = (since?: number) =>
    f.control
      .decisionsForUser(user, f.project.id, since)
      .items.map((item) => (item as { approval_id: string }).approval_id);
  expect(ids()).toEqual([second.id, first.id]);
  expect(ids(since)).toEqual([second.id]);
});

it('refuses a principal of another project', async () => {
  const f = await plain();
  const stranger: Principal = {
    id: 'session:elsewhere',
    role: 'conductor',
    project_id: 'another-project',
    session_id: 'elsewhere',
    expires_at: f.store.now() + 60_000,
  };
  expect(() => f.control.decisionsForUser(stranger, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('lists no row for a prompt the user approved', async () => {
  const { f, prompt } = await promptFixture();
  const approval = await prompt('a');
  expect(approval).toMatchObject({ state: 'pending', decider: 'user' });
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
  await f.control.tick();
  expect(f.store.must<Approval>('approvals', approval.id).state).toBe('approved');
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('keeps the row of a prompt whose approval left with its deleted session', async () => {
  const { f, ruled } = await promptFixture();
  const approval = await ruled('a');
  const settled = f.store.must<Approval>('approvals', approval.id);
  f.store.remove('approvals', settled.id, settled.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    expect.objectContaining({ kind: 'prompt_by_rule', approval_id: approval.id }),
  ]);
});
