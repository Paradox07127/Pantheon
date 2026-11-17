import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Session, SessionTurn } from '@pantheon/domain';
import { agentEvent } from '../../packages/control/dist/agent.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, fixture } from '../helpers.js';
import { git } from './workbench-fixture.js';

type Reply = {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(turnSummarizer: (prompt: string, signal: AbortSignal) => Promise<Reply>) {
  const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-recap-config-'));
  const f = await fixture({
    managedWorkspaces: true,
    controlOptions: { turnSummarizer, userConfigDir },
  });
  cleanups.push(async () => {
    await f.close();
    rmSync(userConfigDir, { recursive: true, force: true });
  });
  git(f.projectRoot, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(f.projectRoot, 'README.md'), 'fixture\n');
  git(f.projectRoot, 'add', '.');
  git(f.projectRoot, 'commit', '--quiet', '-m', 'Initial files');
  return f;
}
type Fixture = Awaited<ReturnType<typeof setup>>;

async function completeTurn(f: Fixture, input: string) {
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input,
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.list<SessionTurn>('session_turns')[0]?.state === 'completed',
    () => f.control.tick(),
  );
  return { session, turn: f.store.list<SessionTurn>('session_turns')[0]! };
}

const recaps = (f: Fixture) =>
  f.store.events(0, undefined, 10_000).filter((event) => event.kind === 'agent.session.recapped');
const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const json = (headline: string, happened = 'Fixed the redirect', needs_you = '') =>
  JSON.stringify({ headline, needs_you, happened });

let injected = 0;
/** Records an adapter event on the session's turn, as the runtime would have sent it. */
function inject(f: Fixture, sessionId: string, turnId: string, event: Record<string, unknown>) {
  agentEvent(ctxOf(f), sessionId, {
    key: `injected-${++injected}`,
    turn_id: turnId,
    ...event,
  } as unknown as AgentEvent);
}

describe('session recaps', () => {
  it.each([
    [
      'a completed turn',
      { kind: 'turn.completed', status: 'completed' },
      'The turn ended: completed',
      undefined,
    ],
    [
      'a failed turn',
      { kind: 'turn.completed', status: 'failed', error: 'tests failed' },
      'The turn ended: failed (tests failed)',
      undefined,
    ],
    [
      'an interrupted turn',
      { kind: 'turn.completed', status: 'interrupted' },
      'The turn ended: interrupted',
      undefined,
    ],
    [
      'a permission request',
      {
        kind: 'permission.requested',
        request_id: 'request-remove-build',
        tool: 'Bash',
        detail: { input: { command: 'rm -rf build' } },
      },
      'The session waits for the user to approve the tool Bash: rm -rf build',
      'Approve rm -rf build',
    ],
  ])('recaps the session after %s and keeps the recap on it', async (_name, event, fact, needs) => {
    const replies: Reply[] = [
      { text: json('First recap') },
      {
        text: `\`\`\`json\n${json('Second recap', 'Ran the build', needs)}\n\`\`\``,
        usage: { input_tokens: 120, output_tokens: 30 },
        model: 'recap-model',
      },
    ];
    const summarizer = vi.fn(async (_prompt: string, _signal: AbortSignal) => replies.shift()!);
    const f = await setup(summarizer);
    const input = `Fix the login redirect${'.'.repeat(3000)}`;
    const { session, turn } = await completeTurn(f, input);
    await eventually(() => recaps(f).length === 1);
    const before = f.store.must<Session>('sessions', session.id).revision;
    inject(f, session.id, turn.id, event);
    await eventually(() => recaps(f).length === 2);
    const prompt = summarizer.mock.calls[1]![0];
    expect(prompt).toContain(fact);
    expect(prompt).toContain(input.slice(0, 2000));
    expect(prompt).not.toContain(input.slice(0, 2001));
    expect(prompt).toContain('fixture completed');
    const recap = {
      headline: 'Second recap',
      happened: 'Ran the build',
      ...(needs ? { needs_you: needs } : {}),
      turn_id: turn.id,
      at: expect.any(Number),
      model: 'recap-model',
    };
    expect(recaps(f)[1]).toMatchObject({
      aggregate_id: session.id,
      payload: { ...recap, usage: { input_tokens: 120, output_tokens: 30 } },
    });
    const recapped = f.store.must<Session>('sessions', session.id);
    expect(recapped.recap).toEqual(recap);
    expect(recapped.revision).toBeGreaterThan(before);
    expect(f.store.events(0, undefined, 10_000).map((e) => e.kind)).not.toContain(
      'agent.turn.summarized',
    );
  });

  it.each([
    [
      'a compaction turn',
      (f: Fixture, turn: SessionTurn) => {
        const latest = f.store.must<SessionTurn>('session_turns', turn.id);
        f.store.update('session_turns', { ...latest, origin: 'compaction' }, latest.revision);
      },
    ],
    [
      'recaps switched off',
      (f: Fixture) => {
        f.call('app.settings.set', { session_recap: false });
        expect(f.call<{ session_recap: boolean }>('app.settings.set', {}).session_recap).toBe(
          false,
        );
      },
    ],
    [
      'a project over its budget',
      (f: Fixture, turn: SessionTurn) => {
        const now = Date.now();
        vi.spyOn(f.store, 'now').mockImplementation(() => now - 60_000);
        f.call('workflow.policy.set', {
          project_id: f.project.id,
          project_budget: { input_tokens: 100 },
        });
        vi.restoreAllMocks();
        const latest = f.store.must<SessionTurn>('session_turns', turn.id);
        f.store.update(
          'session_turns',
          { ...latest, usage: { input_tokens: 150, output_tokens: 0 } },
          latest.revision,
        );
      },
    ],
  ])('writes no recap for %s', async (_name, prepare) => {
    const summarizer = vi.fn(async () => ({ text: json('First recap') }));
    const f = await setup(summarizer);
    const { session, turn } = await completeTurn(f, 'Fix the login redirect');
    await eventually(() => recaps(f).length === 1);
    prepare(f, turn);
    inject(f, session.id, turn.id, { kind: 'turn.completed', status: 'completed' });
    // The summarizer is called on a later microtask.
    await new Promise((resolve) => setImmediate(resolve));
    expect(summarizer).toHaveBeenCalledTimes(1);
  });

  it('drops a recap that arrives after a newer turn event of the session', async () => {
    let release: (reply: Reply) => void = () => {};
    const replies: (() => Promise<Reply>)[] = [
      async () => ({ text: json('First recap') }),
      () => new Promise<Reply>((resolve) => (release = resolve)),
      async () => ({ text: json('Third recap') }),
    ];
    const summarizer = vi.fn(async (_prompt: string, _signal: AbortSignal) => replies.shift()!());
    const f = await setup(summarizer);
    const { session, turn } = await completeTurn(f, 'Fix the login redirect');
    await eventually(() => recaps(f).length === 1);
    inject(f, session.id, turn.id, { kind: 'turn.completed', status: 'completed' });
    await eventually(() => summarizer.mock.calls.length === 2);
    inject(f, session.id, turn.id, { kind: 'turn.started' });
    release({ text: json('Late recap') });
    inject(f, session.id, turn.id, { kind: 'turn.completed', status: 'completed' });
    await eventually(() => recaps(f).length === 2);
    expect(recaps(f).map((event) => (event.payload as { headline: string }).headline)).toEqual([
      'First recap',
      'Third recap',
    ]);
    expect(f.store.must<Session>('sessions', session.id).recap?.headline).toBe('Third recap');
  });

  it.each([
    ['plain text', 'Fixed the redirect'],
    ['JSON without a happened field', JSON.stringify({ headline: 'Fixed' })],
    ['JSON with an empty headline', json('')],
  ])('writes no recap when the reply is %s', async (_name, text) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summarizer = vi.fn(async () => ({ text }));
    const f = await setup(summarizer);
    const { session } = await completeTurn(f, 'Fix the login redirect');
    await eventually(() => logged.mock.calls.length === 1);
    expect(recaps(f)).toEqual([]);
    expect(f.store.must<Session>('sessions', session.id).recap).toBeUndefined();
  });

  it('cuts each field to its length in characters', async () => {
    const summarizer = vi.fn(async () => ({
      text: json('标'.repeat(100), '做'.repeat(200), '批'.repeat(200)),
    }));
    const f = await setup(summarizer);
    const { session } = await completeTurn(f, '修一下登录后的跳转');
    await eventually(() => recaps(f).length === 1);
    expect(f.store.must<Session>('sessions', session.id).recap).toMatchObject({
      headline: '标'.repeat(64),
      happened: '做'.repeat(140),
      needs_you: '批'.repeat(140),
    });
  });

  it('ends the turn without a recap when the summarizer fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summarizer = vi.fn(async (): Promise<Reply> => {
      throw new Error('model unavailable');
    });
    const f = await setup(summarizer);
    const { turn } = await completeTurn(f, 'Fix the login redirect');
    await eventually(() => logged.mock.calls.length === 1);
    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('completed');
    expect(recaps(f)).toEqual([]);
  });

  it('gives up on a recap after twenty seconds and ends the turn as usual', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    const summarizer = vi.fn((_prompt: string, given: AbortSignal) => {
      signal = given;
      return new Promise<Reply>(() => {});
    });
    const f = await setup(summarizer);
    const { turn } = await completeTurn(f, 'Fix the login redirect');
    await eventually(() => signal !== undefined);
    expect(f.store.must<SessionTurn>('session_turns', turn.id).state).toBe('completed');
    vi.advanceTimersByTime(19_000);
    expect(signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(signal!.aborted).toBe(true);
    await eventually(() => logged.mock.calls.length === 1);
    expect(recaps(f)).toEqual([]);
  });
});
