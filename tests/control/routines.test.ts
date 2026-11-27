import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  id,
  type Project,
  type Routine,
  type Session,
  type SessionTurn,
  type Timer,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const minute = 60_000;
const start = new Date(2026, 3, 8, 8, 30).getTime();
const stored: Routine = {
  id: 'assigned-issues',
  name: 'Assigned issues',
  prompt: 'Review my assigned issues',
  enabled: true,
  every_ms: 30 * minute,
  saved_at: start,
};
const input = { name: stored.name, prompt: stored.prompt, enabled: true, every_minutes: 30 };

async function routinesFixture() {
  const f = await workbenchFixture();
  const project_id = f.project.id;
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(start);
  const timers = () => f.store.list<Timer>('timers').filter((t) => t.state === 'pending');
  const runs = () => f.store.kindEvents(project_id, ['routine.ran']).map((e) => e.payload);
  function seed(routine: Routine = stored, due_at = start) {
    const project = f.store.must<Project>('projects', project_id);
    f.store.update(
      'projects',
      { ...project, routines: [...(project.routines ?? []), routine] },
      project.revision,
    );
    if (routine.enabled)
      f.store.insert<Timer>('timers', {
        id: id(),
        revision: 1,
        project_id,
        kind: 'routine',
        subject_id: routine.id,
        due_at,
        state: 'pending',
      });
  }
  function resident() {
    const session = f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id,
      runtime: f.adapter.name,
      conductor: true,
      state: 'running',
      turn_count: 0,
    });
    f.call('project.resident.set', { project_id, session_id: session.id });
    return session;
  }
  function spend(session_id: string) {
    f.call('workflow.policy.set', { project_id, project_budget: { input_tokens: 10 } });
    clock.mockReturnValue(start + 1);
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: id(),
      revision: 1,
      project_id,
      session_id,
      state: 'completed',
      kind: 'send',
      delivery: 'delivered',
      input: 'Review changes',
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    f.store.event('turn.completed', turn, project_id, {});
  }
  const read = () => f.control.projectRoutines(user, project_id).routines;
  return { ...f, project_id, clock, timers, runs, seed, resident, spend, read };
}

it.each([
  ['both schedules', { at: '09:00' }],
  ['missing schedule', { every_minutes: undefined }],
  ['short interval', { every_minutes: 4 }],
  ['fractional interval', { every_minutes: 5.5 }],
  ['invalid hour', { every_minutes: undefined, at: '24:00' }],
  ['invalid active hours', { active_hours: { from: '09:00', to: '17:60' } }],
  ['empty precheck', { precheck: { argv: [] } }],
  ['blank name', { name: '   ' }],
  ['blank prompt', { prompt: '\n' }],
  ['empty active hours', { active_hours: { from: '09:00', to: '09:00' } }],
  ['zero precheck timeout', { precheck: { argv: ['check'], timeout_seconds: 0 } }],
  ['precheck timeout over an hour', { precheck: { argv: ['check'], timeout_seconds: 3601 } }],
])('rejects a routine with %s', (_label, fields) => {
  expect(
    inputSchemas['project.routine.save']?.safeParse({
      project_id: 'project',
      routine: { ...input, ...fields },
    }).success,
  ).toBe(false);
});

it('creates, replaces, pauses, resumes and removes a routine and its pending timer', async () => {
  const f = await routinesFixture();
  const save = (routine: Record<string, unknown>) =>
    f.call<{ routine_id: string }>('project.routine.save', { project_id: f.project_id, routine });
  const { routine_id } = save(input);
  const precheck = { argv: ['check', '--issues'], timeout_seconds: 12 };
  expect(f.timers()).toMatchObject([{ due_at: start + 30 * minute }]);
  const replacement = {
    id: routine_id,
    name: 'Morning issues',
    prompt: 'Review issues',
    at: '09:15',
    enabled: true,
    precheck,
  };
  expect(save(replacement)).toEqual({ routine_id });
  expect(f.timers()).toMatchObject([{ due_at: start + 45 * minute }]);
  expect(f.read()).toEqual([
    { ...replacement, state: 'no_resident', next_at: start + 45 * minute, last_run: null },
  ]);
  save({ ...replacement, enabled: false });
  expect(f.timers()).toEqual([]);
  expect(f.read()[0]).toMatchObject({ enabled: false, state: 'paused', next_at: null });
  save(replacement);
  f.call('project.routine.remove', { project_id: f.project_id, routine_id });
  expect(f.timers()).toEqual([]);
  expect(f.read()).toEqual([]);
});

it.each(['project.routine.save', 'project.routine.remove', 'project.routine.run'] as const)(
  'requires a user for %s',
  async (type) => {
    const f = await routinesFixture();
    f.seed();
    expect(() =>
      f.call(
        type,
        {
          project_id: f.project_id,
          ...(type === 'project.routine.save' ? { routine: input } : { routine_id: stored.id }),
        },
        null,
        { id: 'main', role: 'conductor' },
      ),
    ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  },
);

it.each([
  ['interval', { every_ms: 5 * minute }, 5],
  ['clock time today', { at: '09:00' }, 30],
  ['clock time tomorrow', { at: '08:00' }, 23.5 * 60],
  [
    'next active start',
    { every_ms: 10 * minute, active_hours: { from: '10:00', to: '16:00' } },
    90,
  ],
  [
    'overnight active hours',
    { every_ms: 5 * minute, active_hours: { from: '11:00', to: '09:00' } },
    5,
  ],
] as const)('computes the next run for %s', async (_label, schedule, minutes) => {
  const { nextRun } = await import('../../packages/control/dist/routines.js');
  expect(nextRun(schedule, start)).toBe(start + minutes * minute);
});

it('finds the clock time on the day after a spring-forward night', async () => {
  const { nextRun } = await import('../../packages/control/dist/routines.js');
  const zone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const after = new Date(2026, 2, 8, 3, 30).getTime();
    expect(nextRun({ at: '02:30' }, after)).toBe(new Date(2026, 2, 9, 2, 30).getTime());
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

it('runs no routine of a removed project and keeps its timer for a reopening', async () => {
  const f = await routinesFixture();
  f.seed();
  const session = f.resident();
  const project = f.store.must<Project>('projects', f.project_id);
  f.store.update('projects', { ...project, removed_at: start }, project.revision);
  await f.control.tick();
  expect(f.runs()).toEqual([]);
  expect(f.turns(session.id)).toEqual([]);
  expect(f.timers()).toMatchObject([{ subject_id: stored.id, due_at: start + 30 * minute }]);
});

it('records saving and removing a routine as events other windows read again after', async () => {
  const f = await routinesFixture();
  const { routine_id } = f.call<{ routine_id: string }>('project.routine.save', {
    project_id: f.project_id,
    routine: input,
  });
  f.call('project.routine.remove', { project_id: f.project_id, routine_id });
  expect(
    f.store
      .kindEvents(f.project_id, ['routine.saved', 'routine.removed'])
      .map((e) => [e.kind, e.payload]),
  ).toEqual([
    ['routine.saved', { routine_id }],
    ['routine.removed', { routine_id }],
  ]);
});

it.each(['active', 'unset', 'closed', 'budget'] as const)(
  'dispatches a due routine with resident status %s',
  async (state) => {
    const f = await routinesFixture();
    f.seed();
    const session = state === 'unset' ? undefined : f.resident();
    if (state === 'closed')
      f.store.update<Session>('sessions', { ...session!, state: 'closed' }, session!.revision);
    if (state === 'budget') f.spend(session!.id);
    await f.control.tick();
    if (state === 'active') {
      const [turn] = f.turns(session!.id);
      expect(turn?.input).toBe(stored.prompt);
      expect(f.runs()).toEqual([{ routine_id: stored.id, outcome: 'woken', turn_id: turn!.id }]);
      expect(f.store.kindEvents(f.project_id, ['resident.woken'])).toMatchObject([
        { payload: { cause: expect.stringContaining(stored.id), turn_id: turn!.id } },
      ]);
    } else {
      expect(f.runs()).toEqual([
        {
          routine_id: stored.id,
          outcome: 'skipped',
          reason: state === 'budget' ? 'budget' : 'no_resident',
        },
      ]);
      expect(f.store.kindEvents(f.project_id, ['resident.woken'])).toEqual([]);
      if (state === 'budget')
        expect(f.store.kindEvents(f.project_id, ['resident.wake_skipped'])).toMatchObject([
          { payload: { reason: 'budget', cause: expect.stringContaining(stored.id) } },
        ]);
    }
    expect(f.timers()).toMatchObject([
      { subject_id: stored.id, due_at: f.store.now() + 30 * minute },
    ]);
  },
);

it('defers an overdue timer found outside its active hours', async () => {
  const f = await routinesFixture();
  f.resident();
  f.seed({ ...stored, active_hours: { from: '09:00', to: '17:00' } }, start - 24 * 60 * minute);
  await f.control.tick();
  expect(f.timers()).toMatchObject([{ due_at: start + 30 * minute }]);
  expect(f.runs()).toEqual([]);
});

it.each(['success', 'failure', 'timeout'] as const)(
  'uses the precheck result on %s',
  async (mode) => {
    const f = await routinesFixture();
    const session = f.resident();
    const script =
      mode === 'success'
        ? "if (!require('node:fs').existsSync('answer.txt')) process.exit(2); process.stderr.write('diagnostic'); process.stdout.write(process.argv[1] + 'x'.repeat(4100))"
        : mode === 'failure'
          ? 'process.exit(1)'
          : 'setInterval(() => {}, 5000)';
    const literal = '$(echo issue)';
    f.seed({ ...stored, precheck: { argv: [process.execPath, '-e', script, literal] } });
    if (mode === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await f.control.tick();
      if (mode === 'timeout') vi.advanceTimersByTime(minute);
      await Promise.all(f.control['ctx'].completions);
    } finally {
      vi.useRealTimers();
    }
    const turns = f.turns(session.id);
    if (mode === 'success') {
      expect(turns.map((t) => t.input)).toEqual([
        stored.prompt + '\n\n' + (literal + 'x'.repeat(4100)).slice(0, 4000),
      ]);
      expect(f.runs()).toMatchObject([{ outcome: 'woken', exit_code: 0 }]);
    } else {
      expect(f.runs()).toEqual([
        {
          routine_id: stored.id,
          outcome: 'skipped',
          reason: 'precheck',
          exit_code: mode === 'failure' ? 1 : null,
        },
      ]);
      expect(turns).toEqual([]);
    }
  },
);

it.each(['latest save', 'latest wake'] as const)(
  'expands every {since} in precheck arguments using the %s',
  async (source) => {
    const f = await routinesFixture();
    const session = f.resident();
    const save = () =>
      f.call('project.routine.save', {
        project_id: f.project_id,
        routine: {
          ...input,
          id: stored.id,
          precheck: {
            argv: [
              process.execPath,
              '-e',
              'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
              '>={since}',
              '{since}/{since}',
              '$(echo {other})',
            ],
          },
        },
      });
    save();
    const run = () =>
      f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
    if (source === 'latest wake') {
      for (const offset of [2, 4]) {
        f.clock.mockReturnValue(start + offset * minute + 789);
        run();
        await Promise.all(f.control['ctx'].completions);
      }
    }
    f.clock.mockReturnValue(start + 6 * minute + 345);
    save();
    f.clock.mockReturnValue(start + 8 * minute);
    for (const [routine_id, outcome] of [
      [stored.id, 'skipped'],
      ['other', 'woken'],
    ])
      f.store.event('routine.ran', f.project, f.project_id, { routine_id, outcome });
    run();
    await Promise.all(f.control['ctx'].completions);
    const since = new Date(start + (source === 'latest wake' ? 4 : 6) * minute)
      .toISOString()
      .replace('.000Z', 'Z');
    expect(f.turns(session.id).at(-1)?.input).toContain(
      stored.prompt +
        '\n\n' +
        JSON.stringify([`>=${since}`, `${since}/${since}`, '$(echo {other})']),
    );
  },
);

it('expands {since} from the routine itself once the event history is pruned', async () => {
  const f = await routinesFixture();
  const session = f.resident();
  const argv = [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{since}'];
  f.clock.mockReturnValue(start + 2 * minute);
  f.call('project.routine.save', {
    project_id: f.project_id,
    routine: { ...input, id: stored.id, precheck: { argv } },
  });
  f.clock.mockReturnValue(start + 4 * minute);
  f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
  await Promise.all(f.control['ctx'].completions);
  f.store.db.prepare("DELETE FROM events WHERE kind IN ('routine.saved', 'routine.ran')").run();
  f.clock.mockReturnValue(start + 6 * minute);
  f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
  await Promise.all(f.control['ctx'].completions);
  const at = (m: number) => new Date(start + m * minute).toISOString().replace('.000Z', 'Z');
  // The second notice joins the first while that turn still waits.
  expect(f.turns(session.id).map((t) => t.input)).toEqual([
    `${stored.prompt}\n\n${at(2)}\n\n${stored.prompt}\n\n${at(4)}`,
  ]);
});

it('records a woken run against the project revision that holds its wake time', async () => {
  const f = await routinesFixture();
  f.resident();
  f.call('project.routine.save', {
    project_id: f.project_id,
    routine: { ...input, id: stored.id },
  });
  f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
  await Promise.all(f.control['ctx'].completions);
  const [ran] = f.store.kindEvents(f.project_id, ['routine.ran']);
  expect(ran).toMatchObject({ payload: { outcome: 'woken' } });
  expect(ran!.aggregate_revision).toBe(f.store.must<Project>('projects', f.project_id).revision);
});

it('advances the timer without launching a second in-flight precheck', async () => {
  const f = await routinesFixture();
  f.resident();
  const script =
    "const fs = require('node:fs'); fs.appendFileSync('checks', 'run\\n'); const wait = setInterval(() => { if (fs.existsSync('release')) clearInterval(wait) }, 5)";
  f.seed({ ...stored, precheck: { argv: [process.execPath, '-e', script], timeout_ms: 750 } });
  await f.control.tick();
  f.clock.mockReturnValue(start + 30 * minute);
  await f.control.tick();
  writeFileSync(path.join(f.source, 'release'), '');
  await Promise.all(f.control['ctx'].completions);
  expect(f.timers()).toMatchObject([{ due_at: start + 60 * minute }]);
  expect(readFileSync(path.join(f.source, 'checks'), 'utf8')).toBe('run\n');
  expect(f.runs().filter((r) => (r as { outcome: string }).outcome === 'woken')).toHaveLength(1);
});

it('runs now through the precheck without moving the timer', async () => {
  const f = await routinesFixture();
  f.seed(
    { ...stored, precheck: { argv: [process.execPath, '-e', 'process.exit(1)'] } },
    start + minute,
  );
  f.resident();
  f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
  await Promise.all(f.control['ctx'].completions);
  expect(f.runs()).toEqual([
    { routine_id: stored.id, outcome: 'skipped', reason: 'precheck', exit_code: 1 },
  ]);
  expect(f.timers()).toMatchObject([{ due_at: start + minute }]);
});

it('runs the precheck with the environment a session gets, so tools find their home folder', async () => {
  const f = await routinesFixture();
  const script = `process.exit(process.env.HOME === ${JSON.stringify(process.env.HOME)} ? 0 : 1)`;
  f.seed({ ...stored, precheck: { argv: [process.execPath, '-e', script] } }, start + minute);
  f.resident();
  f.call('project.routine.run', { project_id: f.project_id, routine_id: stored.id });
  await Promise.all(f.control['ctx'].completions);
  expect(f.runs()).toMatchObject([{ outcome: 'woken', exit_code: 0 }]);
});

it('leaves old agent-routine timers pending when firing a current routine', async () => {
  const f = await routinesFixture();
  f.seed();
  const legacy = f.store.insert<Timer>('timers', {
    ...f.timers()[0]!,
    id: id(),
    kind: 'agent-routine',
  });
  await f.control.tick();
  expect(f.runs()).toHaveLength(1);
  expect(f.store.must('timers', legacy.id)).toEqual(legacy);
});

it.each(['active', 'paused', 'paused_budget', 'no_resident'] as const)(
  'reads %s with its schedule and latest run',
  async (state) => {
    const f = await routinesFixture();
    const enabled = state !== 'paused';
    f.seed({ ...stored, enabled }, start + minute);
    if (state !== 'no_resident') {
      const session = f.resident();
      if (state === 'paused_budget') f.spend(session.id);
    }
    f.store.event('routine.ran', f.project, f.project_id, {
      routine_id: stored.id,
      outcome: 'woken',
      turn_id: id(),
    });
    const result = { outcome: 'skipped', reason: 'precheck', exit_code: null };
    f.store.event('routine.ran', f.project, f.project_id, { routine_id: stored.id, ...result });
    f.store.event('routine.ran', f.project, f.project_id, {
      routine_id: id(),
      outcome: 'woken',
      turn_id: id(),
    });
    expect(f.read()).toEqual([
      {
        ...input,
        id: stored.id,
        enabled,
        next_at: enabled ? start + minute : null,
        state,
        last_run: { at: f.store.now(), ...result },
      },
    ]);
  },
);

it('dispatches the other due timer when one routine fails to record its run', async () => {
  const f = await routinesFixture();
  f.seed();
  f.seed({ ...stored, id: 'review-queue' });
  const event = f.store.event.bind(f.store);
  vi.spyOn(f.store, 'event').mockImplementation((...args) => {
    if (args[0] === 'routine.ran' && (args[3] as { routine_id: string }).routine_id === stored.id)
      throw new Error('Cannot record assigned issues');
    return event(...args);
  });
  await expect(f.control.tick()).rejects.toThrow('Cannot record assigned issues');
  expect(f.runs()).toMatchObject([{ routine_id: 'review-queue' }]);
  expect(f.timers().map((t) => t.due_at)).toEqual([start, start + 30 * minute]);
});

it('honors a pause while a scheduled precheck is finishing', async () => {
  const f = await routinesFixture();
  const precheck = { argv: [process.execPath, '-e', 'process.exit(0)'] };
  f.seed({ ...stored, precheck });
  const session = f.resident();
  await f.control.tick();
  f.call('project.routine.save', {
    project_id: f.project_id,
    routine: { ...input, id: stored.id, precheck, enabled: false },
  });
  await Promise.all(f.control['ctx'].completions);
  expect(f.runs()).toMatchObject([{ outcome: 'skipped' }]);
  expect(f.turns(session.id)).toEqual([]);
  expect(f.timers()).toEqual([]);
});
