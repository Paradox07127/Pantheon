import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRoutines, RoutineRun } from '@pantheon/protocol';
import { deferred, mount, nodes, text, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  board: {} as any,
  queries: [] as {
    method: string;
    kinds?: ReadonlySet<string>;
    valid?: (value: unknown) => boolean;
  }[],
  answers: {} as Record<string, { read: unknown; error: string | null }>,
  reload: () => {},
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'routine-form' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', async (actual) => ({
  ...(await actual<object>()),
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: vi.fn(async () => ({ ok: true, value: {} })),
}));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (
    method: string,
    _projectId: string | null,
    valid: (value: unknown) => boolean,
    _extra: unknown,
    options?: { kinds?: ReadonlySet<string> },
  ) => {
    mock.queries.push({ method, kinds: options?.kinds, valid });
    const answer = mock.answers[method] ?? { read: null, error: null };
    return { ...answer, loading: false, unavailable: false, stale: false, reload: mock.reload };
  },
}));
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
import type { WorkbenchSession } from '@pantheon/protocol';
import { Failure } from '@/components/PanelBoundary';
import { runCommand } from '@/data/commands';
import { sendProjectCommand } from '@/data/project-read';
import { useProjectRoutines } from '@/data/project-routines';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { ResidentCard } from '@/screens/project/ResidentCard';
import { RoutineEditor, RoutinesCard } from '@/screens/project/RoutinesCard';
import { zh, zhf } from './i18n-setup.js';

type Routine = ProjectRoutines['routines'][number];

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const MINUTE = 60_000;

const routineOf = (extra: Partial<Routine> = {}): Routine =>
  ({
    id: 'r1',
    name: 'Triage issues',
    prompt: 'Look at the issues assigned to me',
    every_minutes: 30,
    enabled: true,
    next_at: NOW + 30 * MINUTE,
    state: 'active',
    last_run: null,
    ...extra,
  }) as Routine;

const dailyOf = (at: string, extra: Partial<Routine> = {}): Routine => {
  const { every_minutes: _, ...rest } = routineOf(extra) as Routine & { every_minutes: number };
  return { ...rest, at } as Routine;
};

const answer = (routines: Routine[], error: string | null = null) => {
  mock.answers['project.routines'] = { read: { routines }, error };
};

const card = () => mount(() => RoutinesCard({ projectId: 'alpha' }) as ReactElement);

const editor = (
  routine: Routine | null,
  onSaved = () => {},
  extra: { removed?: boolean; onBusy?: (busy: boolean) => void } = {},
) =>
  mount(
    () =>
      RoutineEditor({
        routine,
        save: (input) =>
          sendProjectCommand('project.routine.save', { project_id: 'alpha', routine: input }, null),
        removed: false,
        onBusy: () => {},
        onSaved,
        onCancel: () => {},
        ...extra,
      }) as ReactElement,
  );

const all = (tree: unknown) => nodes(tree as ReactElement);
const button = (tree: unknown, name: string) =>
  all(tree).find((n) => n.type === 'button' && text(n) === name);
const field = (tree: unknown, name: string) =>
  all(tree).find((n) => n.props['aria-label'] === name);
const switchOf = (tree: unknown, name: string) =>
  all(tree)
    .find((n) => n.type === 'label' && text(n) === name)!
    .props.children.find((n: any) => n?.props?.type === 'checkbox');
const rows = (tree: unknown) => all(tree).filter((n) => n.type === 'li');
const save = (tree: unknown) => button(tree, zh('project.routines.save'))!;
const type = (h: { value: unknown; render: () => unknown }, name: string, value: string) => {
  field(h.value, name)!.props.onChange({ target: { value } });
  h.render();
};
const toggle = (h: { value: unknown; render: () => unknown }, name: string, checked: boolean) => {
  switchOf(h.value, name).props.onChange({ target: { checked } });
  h.render();
};
const saved = () => {
  const call = vi.mocked(runCommand).mock.calls.find(([type]) => type === 'project.routine.save');
  return (call?.[1] as { routine: Record<string, unknown> } | undefined)?.routine;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    reads: {},
    status: { state: 'live' },
    resync: 0,
  };
  mock.queries = [];
  mock.answers = {};
  mock.reload = () => {};
  vi.mocked(runCommand).mockClear();
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('the routines read', () => {
  it('reads again after routine, resident and policy events', () => {
    mount(() => useProjectRoutines('alpha'));
    expect(mock.queries.at(-1)?.method).toBe('project.routines');
    expect([...mock.queries.at(-1)!.kinds!].sort()).toEqual(
      [
        'routine.saved',
        'routine.removed',
        'routine.ran',
        'project.resident_set',
        'workflow.policy_changed',
        'turn.completed',
        'turn.failed',
        'turn.cancelled',
        'session.closed',
        'session.discarded',
        'session.deleted',
      ].sort(),
    );
  });

  it('reads again when a turn ends or a session closes, as budget and resident depend on them', () => {
    mount(() => useProjectRoutines('alpha'));
    const kinds = mock.queries.at(-1)!.kinds!;
    for (const kind of [
      'turn.completed',
      'turn.failed',
      'turn.cancelled',
      'session.closed',
      'session.discarded',
      'session.deleted',
    ])
      expect(kinds.has(kind), kind).toBe(true);
  });

  it('takes only a read with a routine list', () => {
    mount(() => useProjectRoutines('alpha'));
    const valid = mock.queries.at(-1)!.valid!;
    expect(valid({ routines: [] })).toBe(true);
    expect(valid({ routines: null })).toBe(false);
    expect(valid(null)).toBe(false);
  });
});

describe('a routine row', () => {
  it('writes each state', () => {
    answer([
      routineOf({ id: 'a', state: 'active', next_at: NOW + 30 * MINUTE }),
      routineOf({ id: 'b', state: 'paused', enabled: false, next_at: null }),
      routineOf({ id: 'c', state: 'paused_budget' }),
      routineOf({ id: 'd', state: 'no_resident' }),
    ]);
    const shown = rows(card().value).map((row) => text(row));
    expect(shown[0]).toContain(
      zhf('project.routines.next', { time: zhf('lib.time.minutes', { minutes: 30 }) }),
    );
    expect(shown[1]).toContain(zh('project.routines.paused'));
    expect(shown[2]).toContain(zh('project.routines.pausedBudget'));
    expect(shown[3]).toContain(zh('project.routines.noResident'));
  });

  it('writes an interval, a daily time and active hours', () => {
    answer([
      routineOf({ id: 'a' }),
      dailyOf('09:00', { id: 'b' }),
      routineOf({ id: 'c', active_hours: { from: '09:00', to: '17:00' } }),
    ]);
    const shown = rows(card().value).map((row) => text(row));
    const every = zhf('project.routines.every', { count: 30 });
    expect(shown[0]).toContain(every);
    expect(shown[0]).not.toContain('17:00');
    expect(shown[1]).toContain(zhf('project.routines.daily', { time: '09:00' }));
    expect(shown[2]).toContain(
      zhf('project.routines.withHours', { when: every, from: '09:00', to: '17:00' }),
    );
  });

  it('writes the last run: woken, each skip reason, an exit code, never run', () => {
    const at = NOW - 5 * MINUTE;
    const runs: [RoutineRun | null, string][] = [
      [{ at, outcome: 'woken' }, zh('project.routines.woken')],
      [{ at, outcome: 'woken', exit_code: 0 }, zh('project.routines.woken')],
      [{ at, outcome: 'skipped', reason: 'no_resident' }, zh('project.routines.skippedNoResident')],
      [{ at, outcome: 'skipped', reason: 'budget' }, zh('project.routines.skippedBudget')],
      [
        { at, outcome: 'skipped', reason: 'precheck', exit_code: 3 },
        zhf('project.routines.skippedPrecheckCode', { code: 3 }),
      ],
      [
        { at, outcome: 'skipped', reason: 'precheck', exit_code: null },
        zh('project.routines.skippedPrecheck'),
      ],
      [
        { at, outcome: 'skipped', reason: 'not_accepting' },
        zh('project.routines.skippedNotAccepting'),
      ],
      [
        { at, outcome: 'skipped', reason: 'prechecking' },
        zh('project.routines.skippedPrechecking'),
      ],
      [
        { at, outcome: 'skipped', reason: 'changed', exit_code: 0 },
        zh('project.routines.skippedChanged'),
      ],
      [
        { at, outcome: 'skipped', reason: 'inactive_hours', exit_code: 0 },
        zh('project.routines.skippedInactiveHours'),
      ],
      [null, zh('project.routines.neverRun')],
    ];
    answer(runs.map(([last_run], i) => routineOf({ id: `r${i}`, last_run })));
    const shown = rows(card().value).map((row) => text(row));
    const age = zhf('data.age.minutes', { count: 5 });
    runs.forEach(([run, expected], i) => {
      expect(shown[i]).toContain(run ? `${age}${expected}` : expected);
    });
    expect(shown[1]).not.toContain(zhf('project.routines.skippedPrecheckCode', { code: 0 }));
  });
});

describe('the row actions', () => {
  it('runs a routine now', async () => {
    answer([routineOf()]);
    const h = card();
    button(h.value, zh('project.routines.run'))!.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.routine.run',
      { project_id: 'alpha', routine_id: 'r1' },
      null,
    );
  });

  it.each([
    ['pauses', true, 'project.routines.pause'],
    ['resumes', false, 'project.routines.resume'],
  ])(
    '%s by saving the routine with enabled flipped and the rest unchanged',
    async (_n, enabled, id) => {
      const routine = routineOf({
        enabled,
        state: enabled ? 'active' : 'paused',
        active_hours: { from: '08:00', to: '20:00' },
        precheck: { argv: ['gh', 'issue', 'list'], timeout_seconds: 30 },
        last_run: { at: NOW - MINUTE, outcome: 'woken' },
      });
      answer([routine]);
      const h = card();
      button(h.value, zh(id))!.props.onClick();
      await h.flush();
      expect(runCommand).toHaveBeenCalledWith(
        'project.routine.save',
        {
          project_id: 'alpha',
          routine: {
            id: 'r1',
            name: routine.name,
            prompt: routine.prompt,
            every_minutes: 30,
            active_hours: { from: '08:00', to: '20:00' },
            precheck: { argv: ['gh', 'issue', 'list'], timeout_seconds: 30 },
            enabled: !enabled,
          },
        },
        null,
      );
    },
  );

  it('asks before it deletes, and deletes only once confirmed', async () => {
    answer([routineOf()]);
    const h = card();
    const ask = all(h.value).find(
      (n) =>
        n.type === 'button' &&
        text(n) === zh('project.routines.remove') &&
        n.props.className.includes('ghost'),
    )!;
    ask.props.onClick();
    h.render();
    expect(runCommand).not.toHaveBeenCalled();
    const confirm = all(h.value).find(
      (n) => n.type === 'button' && n.props.className === 'btn dng',
    )!;
    expect(all(h.value).find((n) => n.props.open === true)).toBeDefined();
    confirm.props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'project.routine.remove',
      { project_id: 'alpha', routine_id: 'r1' },
      null,
    );
  });

  it('disables the row while its command is out and shows the failure', async () => {
    const out = deferred<any>();
    vi.mocked(runCommand).mockReturnValueOnce(out.promise);
    answer([routineOf()]);
    const h = card();
    button(h.value, zh('project.routines.run'))!.props.onClick();
    h.render();
    for (const id of ['run', 'pause', 'edit', 'remove'])
      expect(button(h.value, zh(`project.routines.${id}`))!.props.disabled).toBe(true);
    out.resolve({ ok: false, error: { code: 'not_found', message: 'Routine not found' } });
    await h.flush();
    expect(button(h.value, zh('project.routines.run'))!.props.disabled).toBe(false);
    expect(text(all(h.value).find((n) => n.props.role === 'alert'))).toContain('Routine not found');
  });

  it('disables every row while any command is out', async () => {
    const out = deferred<any>();
    vi.mocked(runCommand).mockReturnValueOnce(out.promise);
    answer([routineOf({ id: 'a', name: 'First' }), routineOf({ id: 'b', name: 'Second' })]);
    const h = card();
    button(rows(h.value)[0], zh('project.routines.run'))!.props.onClick();
    h.render();
    for (const id of ['run', 'pause', 'edit', 'remove'])
      expect(button(rows(h.value)[1], zh(`project.routines.${id}`))!.props.disabled, id).toBe(true);
    out.resolve({ ok: true, value: {} });
    await h.flush();
    expect(button(rows(h.value)[1], zh('project.routines.run'))!.props.disabled).toBe(false);
  });

  it('gives the form the routine as listed now, and says when it is gone', () => {
    answer([routineOf()]);
    const h = card();
    const formOf = () => all(h.value).find((n) => n.type === RoutineEditor);
    button(h.value, zh('project.routines.edit'))!.props.onClick();
    h.render();
    expect(formOf()!.props.removed).toBe(false);
    const paused = routineOf({ enabled: false, state: 'paused', next_at: null });
    answer([paused]);
    h.render();
    expect(formOf()!.props.routine).toBe(paused);
    answer([]);
    h.render();
    expect(formOf()!.props.removed).toBe(true);
  });

  it('keeps the form open while it saves', () => {
    answer([routineOf()]);
    const h = card();
    const formOf = () => all(h.value).find((n) => n.type === RoutineEditor);
    const dialog = () => all(h.value).find((n) => n.props.onOpenChange)!;
    button(h.value, zh('project.routines.edit'))!.props.onClick();
    h.render();
    formOf()!.props.onBusy?.(true);
    h.render();
    dialog().props.onOpenChange(false);
    h.render();
    expect(formOf()).toBeDefined();
    formOf()!.props.onBusy?.(false);
    h.render();
    dialog().props.onOpenChange(false);
    h.render();
    expect(formOf()).toBeUndefined();
  });

  it('closes only the form a save came from', () => {
    answer([routineOf()]);
    const h = card();
    const formOf = () => all(h.value).find((n) => n.type === RoutineEditor);
    button(h.value, zh('project.routines.edit'))!.props.onClick();
    h.render();
    const earlier = formOf()!.props.onSaved;
    button(h.value, zh('project.routines.new'))!.props.onClick();
    h.render();
    earlier();
    h.render();
    expect(formOf()?.props.routine).toBeNull();
  });

  it('opens the form on the routine to edit, and empty for a new one', () => {
    const routine = routineOf();
    answer([routine]);
    const h = card();
    const formOf = () => all(h.value).find((n) => n.type === RoutineEditor);
    expect(formOf()).toBeUndefined();
    button(h.value, zh('project.routines.edit'))!.props.onClick();
    h.render();
    expect(formOf()!.props.routine).toBe(routine);
    button(h.value, zh('project.routines.new'))!.props.onClick();
    h.render();
    expect(formOf()!.props.routine).toBeNull();
  });

  it.each([
    ['with no earlier read', false],
    ['beside the earlier read', true],
  ])('shows a failed read with a retry %s', (_name, earlier) => {
    const reload = vi.fn();
    mock.reload = reload;
    mock.answers['project.routines'] = {
      read: earlier ? { routines: [routineOf()] } : null,
      error: 'daemon gone',
    };
    const h = card();
    const failure = all(h.value).find((n) => n.type === Failure)!;
    expect(failure.props.error).toBe('daemon gone');
    failure.props.onRetry();
    expect(reload).toHaveBeenCalled();
    expect(rows(h.value)).toHaveLength(earlier ? 1 : 0);
  });
});

describe('the routine form', () => {
  const fill = (h: ReturnType<typeof editor>) => {
    type(h, zh('project.routines.name'), 'Check CI');
    type(h, zh('project.routines.prompt'), 'Look at the failing checks');
  };

  it('starts a new routine with the precheck on', () => {
    const h = editor(null);
    expect(switchOf(h.value, zh('project.routines.precheck')).props.checked).toBe(true);
    expect(field(h.value, zh('project.routines.argv'))).toBeDefined();
  });

  it('sends no precheck once it is switched off', async () => {
    const h = editor(null);
    fill(h);
    toggle(h, zh('project.routines.precheck'), false);
    expect(field(h.value, zh('project.routines.argv'))).toBeUndefined();
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()).toEqual({
      name: 'Check CI',
      prompt: 'Look at the failing checks',
      every_minutes: 30,
      enabled: true,
    });
  });

  it('splits the precheck into one argument per line', async () => {
    const h = editor(null);
    fill(h);
    type(h, zh('project.routines.argv'), 'gh\npr\n\nchecks\n');
    type(h, zh('project.routines.timeout'), '45');
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()?.precheck).toEqual({ argv: ['gh', 'pr', '', 'checks'], timeout_seconds: 45 });
  });

  it('keeps each typed line as one argument, spaces and blank lines included', async () => {
    const h = editor(routineOf({ precheck: { argv: ['grep', 'x'] } }));
    type(h, zh('project.routines.argv'), 'echo\n  two words  \n\nlast\n');
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()?.precheck).toEqual({ argv: ['echo', '  two words  ', '', 'last'] });
  });

  it('sends the saved arguments back as they were when their box is untouched', async () => {
    const argv = ['grep', ' padded ', '', 'line\nbreak', ''];
    const h = editor(routineOf({ precheck: { argv, timeout_seconds: 10 } }));
    type(h, zh('project.routines.name'), 'Renamed');
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()?.precheck).toEqual({ argv, timeout_seconds: 10 });
  });

  it('names each field in visible text and shows an argument per line in the example', () => {
    const h = editor(null);
    toggle(h, zh('project.routines.hours'), true);
    const labels = all(h.value)
      .filter((n) => n.type === 'label')
      .map((n) => text(n));
    for (const id of [
      'project.routines.name',
      'project.routines.prompt',
      'project.routines.schedule',
      'project.routines.hours',
      'project.routines.from',
      'project.routines.to',
      'project.routines.precheck',
      'project.routines.timeout',
      'project.routines.command',
    ])
      expect(labels, id).toContain(zh(id));
    expect(zh('project.routines.timeout')).toContain('秒');
    expect(field(h.value, zh('project.routines.name'))).toBeDefined();
    expect(field(h.value, zh('project.routines.argv'))!.props.placeholder).toMatch(/\S\n\S/);
  });

  it('locks the schedule and cancel while it saves', async () => {
    const out = deferred<any>();
    vi.mocked(runCommand).mockReturnValueOnce(out.promise);
    const onBusy = vi.fn();
    const h = editor(null, () => {}, { onBusy });
    fill(h);
    toggle(h, zh('project.routines.precheck'), false);
    save(h.value).props.onClick();
    h.render();
    const cancel = () => button(h.value, zh('sessions.parts.cancel'))!;
    expect(field(h.value, zh('project.routines.schedule'))!.props.disabled).toBe(true);
    expect(cancel().props.disabled).toBe(true);
    expect(onBusy).toHaveBeenLastCalledWith(true);
    out.resolve({ ok: false, error: { code: 'invalid_input', message: 'nope' } });
    await h.flush();
    expect(field(h.value, zh('project.routines.schedule'))!.props.disabled).toBe(false);
    expect(cancel().props.disabled).toBe(false);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it('says the routine was deleted and cannot save it', async () => {
    const h = editor(routineOf({ precheck: { argv: ['true'] } }), () => {}, { removed: true });
    expect(text(all(h.value).find((n) => n.props.role === 'alert'))).toContain(
      zh('project.routines.removedNotice'),
    );
    expect(save(h.value).props.disabled).toBe(true);
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()).toBeUndefined();
  });

  it.each<[string, (h: ReturnType<typeof editor>) => void, string]>([
    ['a blank name', (h) => type(h, zh('project.routines.name'), ' '), 'project.routines.name'],
    [
      'a blank prompt',
      (h) => type(h, zh('project.routines.prompt'), ''),
      'project.routines.prompt',
    ],
    [
      'an interval under 5',
      (h) => type(h, zh('project.routines.minutes'), '4'),
      'project.routines.minutes',
    ],
    [
      'a fractional interval',
      (h) => type(h, zh('project.routines.minutes'), '7.5'),
      'project.routines.minutes',
    ],
    [
      'a bad daily time',
      (h) => {
        field(h.value, zh('project.routines.schedule'))!.props.onValueChange('daily');
        h.render();
        type(h, zh('project.routines.time'), '24:00');
      },
      'project.routines.time',
    ],
    [
      'active hours that start where they end',
      (h) => {
        toggle(h, zh('project.routines.hours'), true);
        type(h, zh('project.routines.to'), '09:00');
      },
      'project.routines.to',
    ],
    [
      'a bad active hours start',
      (h) => {
        toggle(h, zh('project.routines.hours'), true);
        type(h, zh('project.routines.from'), '9');
      },
      'project.routines.from',
    ],
    [
      'a precheck with no argument',
      (h) => type(h, zh('project.routines.argv'), '\n \n'),
      'project.routines.argv',
    ],
    [
      'a timeout of 0',
      (h) => type(h, zh('project.routines.timeout'), '0'),
      'project.routines.timeout',
    ],
    [
      'a timeout over 3600',
      (h) => type(h, zh('project.routines.timeout'), '3601'),
      'project.routines.timeout',
    ],
  ])('cannot save %s and marks its field', (_name, spoil, id) => {
    const h = editor(null);
    fill(h);
    type(h, zh('project.routines.argv'), 'true');
    expect(save(h.value).props.disabled).toBe(false);
    spoil(h);
    expect(save(h.value).props.disabled).toBe(true);
    expect(field(h.value, zh(id))!.props['aria-invalid']).toBe(true);
  });

  it('fills in the routine it edits and saves it under its id', async () => {
    const routine = dailyOf('07:30', {
      enabled: false,
      state: 'paused',
      active_hours: { from: '08:00', to: '20:00' },
      precheck: { argv: ['gh', 'issue', 'list'], timeout_seconds: 30 },
    });
    const onSaved = vi.fn();
    const h = editor(routine, onSaved);
    expect(field(h.value, zh('project.routines.name'))!.props.value).toBe('Triage issues');
    expect(field(h.value, zh('project.routines.prompt'))!.props.value).toBe(routine.prompt);
    expect(field(h.value, zh('project.routines.schedule'))!.props.value).toBe('daily');
    expect(field(h.value, zh('project.routines.time'))!.props.value).toBe('07:30');
    expect(field(h.value, zh('project.routines.from'))!.props.value).toBe('08:00');
    expect(field(h.value, zh('project.routines.to'))!.props.value).toBe('20:00');
    expect(field(h.value, zh('project.routines.argv'))!.props.value).toBe('gh\nissue\nlist');
    expect(field(h.value, zh('project.routines.timeout'))!.props.value).toBe('30');
    type(h, zh('project.routines.name'), 'Triage');
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()).toEqual({
      id: 'r1',
      name: 'Triage',
      prompt: routine.prompt,
      at: '07:30',
      active_hours: { from: '08:00', to: '20:00' },
      enabled: false,
      precheck: { argv: ['gh', 'issue', 'list'], timeout_seconds: 30 },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  const template = (tree: unknown) =>
    button(tree, zhf('project.routines.useTemplate', { name: zh('project.routines.githubName') }));
  const issueArgv = [
    'gh',
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    'involves:@me updated:>={since}',
    '--limit',
    '100',
    '--json',
    'number,title,url',
    '--jq',
    'if length == 0 then halt_error else .[] | "#\\(.number) \\(.title) \\(.url)" end',
  ];
  const issuePrompt =
    'These GitHub issues in this repository involve me and changed since the last check. For each one, decide whether it needs work: start a session for a clear fix, and ask me about anything unclear or risky. The list stops at 100: when it has 100, run the same gh issue list with a higher --limit for the rest. Issues:';

  it('fills a new routine from the GitHub issues template and saves its precheck as written', async () => {
    const h = editor(null);
    template(h.value)!.props.onClick();
    h.render();
    expect(field(h.value, zh('project.routines.name'))!.props.value).toBe(
      zh('project.routines.githubName'),
    );
    expect(zh('project.routines.githubName')).toBe('我的 GitHub issue');
    // A prompt sent to a model stays in English whatever the interface language is.
    expect(field(h.value, zh('project.routines.prompt'))!.props.value).toBe(issuePrompt);
    expect(field(h.value, zh('project.routines.schedule'))!.props.value).toBe('every');
    expect(field(h.value, zh('project.routines.minutes'))!.props.value).toBe('30');
    expect(switchOf(h.value, zh('project.routines.precheck')).props.checked).toBe(true);
    expect(switchOf(h.value, zh('project.routines.hours')).props.checked).toBe(false);
    expect(field(h.value, zh('project.routines.argv'))!.props.value).toBe(issueArgv.join('\n'));
    expect(field(h.value, zh('project.routines.timeout'))!.props.value).toBe('');
    save(h.value).props.onClick();
    await h.flush();
    expect(saved()).toEqual({
      name: zh('project.routines.githubName'),
      prompt: issuePrompt,
      every_minutes: 30,
      enabled: true,
      precheck: { argv: issueArgv },
    });
  });

  it('offers no template while it edits a routine', () => {
    expect(template(editor(null).value)).toBeDefined();
    expect(template(editor(routineOf()).value)).toBeUndefined();
  });

  it('saves the card’s new routine through project.routine.save', async () => {
    answer([]);
    const h = card();
    button(h.value, zh('project.routines.new'))!.props.onClick();
    h.render();
    const form = all(h.value).find((n) => n.type === RoutineEditor)!;
    await form.props.save({ name: 'n', prompt: 'p', every_minutes: 30, enabled: true });
    expect(runCommand).toHaveBeenCalledWith(
      'project.routine.save',
      {
        project_id: 'alpha',
        routine: { name: 'n', prompt: 'p', every_minutes: 30, enabled: true },
      },
      null,
    );
  });

  it('shows a failed save in the form and keeps it open', async () => {
    vi.mocked(runCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'Project changed' },
    } as never);
    const onSaved = vi.fn();
    const h = editor(null, onSaved);
    fill(h);
    toggle(h, zh('project.routines.precheck'), false);
    save(h.value).props.onClick();
    await h.flush();
    expect(text(all(h.value).find((n) => n.props.role === 'alert'))).toContain('Project changed');
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('the routines card on the project page', () => {
  const lead: WorkbenchSession = {
    id: 'lead',
    created_at: '2026-11-20T09:00:00.000Z',
    title: 'lead',
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: 'workspace-lead',
    workspace_kind: 'linked_worktree',
    state: 'idle',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-11-20T10:00:00.000Z',
    changes: null,
    merge: null,
    conductor: true,
  };
  const resident = {
    session_id: 'lead',
    since: NOW,
    turns: { pantheon: 0, user: 0 },
    budget: null,
    wakes: [],
  };
  const screen = (sessions: WorkbenchSession[]) =>
    mount(() => ProjectScreen({ projectId: 'alpha', sessions }) as ReactElement);

  it('gives the resident and routines cards their own keys for the project', () => {
    mock.answers['project.resident'] = { read: resident, error: null };
    const tree = all(screen([lead]).value);
    const residentKey = tree.find((n) => n.type === ResidentCard)!.key;
    const routinesKey = tree.find((n) => n.type === RoutinesCard)!.key;
    expect(residentKey).not.toBe(routinesKey);
    expect(residentKey).toContain('alpha');
    expect(routinesKey).toContain('alpha');
  });

  it('shows under the resident card only with a main agent', () => {
    mock.answers['project.resident'] = { read: resident, error: null };
    const shown = all(screen([lead]).value).find((n) => n.type === RoutinesCard);
    expect(shown?.props.projectId).toBe('alpha');
    expect(all(screen([]).value).find((n) => n.type === RoutinesCard)).toBeUndefined();
  });
});
