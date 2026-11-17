import { expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';
import type { LocalCommand } from '../../packages/control/src/local-command.js';

async function setup() {
  let missing = false;
  const body = 'x'.repeat(4000) + 'body beyond the limit';
  const run: LocalCommand = vi.fn(async (_file, args) => {
    if (args[0] === 'auth')
      return {
        stdout: JSON.stringify({
          hosts: {
            'github.com': [
              {
                host: 'github.com',
                login: 'owner',
                state: 'success',
                active: true,
                scopes: 'repo',
              },
            ],
          },
        }),
        stderr: '',
        exit_code: 0,
      };
    return missing
      ? {
          stdout: '',
          stderr: 'Could not resolve to an Issue with the number of 12.',
          exit_code: 1,
        }
      : {
          stdout: JSON.stringify({
            number: 12,
            title: 'Fix the total',
            state: args[0] === 'pr' ? 'MERGED' : 'CLOSED',
            url: `https://github.com/owner/project/${args[0] === 'pr' ? 'pull' : 'issues'}/12`,
            body,
          }),
          stderr: '',
          exit_code: 0,
        };
  });
  const f = await workbenchFixture({ localCommand: run });
  git(f.source, 'remote', 'add', 'origin', 'git@github.com:owner/project.git');
  return {
    ...f,
    run,
    setMissing: () => {
      missing = true;
    },
  };
}

it('reads GitHub references once at create and send time and delivers their context before the message', async () => {
  const f = await setup();
  const send = vi.spyOn(f.adapter, 'send');
  const refs = [
    { kind: 'pr', number: 12 },
    { kind: 'pr', number: 12 },
  ];
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Review this',
    refs,
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const initial = send.mock.calls[0]![1].input;
  expect(initial).toContain('12');
  expect(initial).toContain('Fix the total');
  expect(initial).toContain('MERGED');
  expect(initial).toContain('https://github.com/owner/project/pull/12');
  expect(initial).toContain('x'.repeat(4000));
  expect(initial).not.toContain('body beyond the limit');
  expect(initial.endsWith('Review this')).toBe(true);
  expect(vi.mocked(f.run).mock.calls.filter(([, args]) => args[1] === 'view')).toHaveLength(1);
  const current = f.store.must<Session>('sessions', session.id);
  await f.call(
    'session.send',
    {
      session_id: current.id,
      input: 'Handle the issue',
      refs: [{ kind: 'issue', number: 12 }],
    },
    current.revision,
  );
  await eventually(
    () => send.mock.calls.length > 1,
    () => f.control.tick(),
  );
  expect(send.mock.calls[1]![1].input).toContain('CLOSED');
  expect(send.mock.calls[1]![1].input).toContain('https://github.com/owner/project/issues/12');
  expect(send.mock.calls[1]![1].input.endsWith('Handle the issue')).toBe(true);
});

it('rejects a missing reference before creating a session or a later turn', async () => {
  const f = await setup();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  f.setMissing();
  const sessions = f.store.list('sessions').length;
  const turns = f.store.list('session_turns').length;
  await expect(
    f.call('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Missing issue',
      refs: [{ kind: 'issue', number: 12 }],
    }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  const current = f.store.must<Session>('sessions', session.id);
  await expect(
    f.call(
      'session.send',
      { session_id: current.id, input: 'Missing PR', refs: [{ kind: 'pr', number: 12 }] },
      current.revision,
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  expect(f.store.list('sessions')).toHaveLength(sessions);
  expect(f.store.list('session_turns')).toHaveLength(turns);
});
