import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { clampSidebarWidth, readLayout } from '@/data/layout';
import { sidebarGroups } from '@/screens/sessions/model';
import { zh } from './i18n-setup.js';

const BY_STATE = { grouping: 'state', sort: 'activity', archived: false } as const;

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

const shape = (list: WorkbenchSession[]) =>
  sidebarGroups(list, BY_STATE).map((group) => ({
    key: group.key,
    rows: group.rows.map((row) => [row.session.id, row.children.map((c) => c.id)]),
  }));

describe('sidebarGroups', () => {
  const split = [
    { key: 'working', rows: [['task', []]] },
    { key: 'review', rows: [['lead', []]] },
  ];
  it.each([
    [
      'groups a running task by its own state even while its lead is ready',
      [session('lead', 'ready'), session('task', 'running', { lead: 'lead' })],
      split,
    ],
    [
      'groups a task session by its own state when its lead is not listed',
      [session('lead', 'ready'), session('task', 'running', { lead: 'gone' })],
      split,
    ],
    [
      'keeps an active worker out of the group of its settled lead',
      [
        session('second', 'waiting', { lead: 'lead' }),
        session('lead', 'idle'),
        session('first', 'merged', { lead: 'lead' }),
      ],
      [
        { key: 'waiting', rows: [['second', []]] },
        { key: 'merged', rows: [['first', []]] },
        { key: 'ended', rows: [['lead', []]] },
      ],
    ],
  ])('%s', (_name, list, groups) => {
    expect(shape(list)).toEqual(groups);
  });

  it('leaves sessions without a lead in their own groups', () => {
    const list = [session('a', 'waiting'), session('b', 'idle'), session('c', 'done')];
    expect(sidebarGroups(list, BY_STATE)).toEqual([
      {
        key: 'waiting',
        label: zh('sessions.model.group.waiting'),
        folded: false,
        rows: [{ session: list[0], children: [] }],
      },
      {
        key: 'ended',
        label: zh('sessions.model.group.ended'),
        folded: true,
        rows: [
          { session: list[1], children: [] },
          { session: list[2], children: [] },
        ],
      },
    ]);
  });
});

describe('stored sidebar', () => {
  const readSidebar = (raw: string | null) =>
    readLayout(raw === null ? null : `{"sidebar":${raw}}`).sidebar;

  it('reads the default for nothing stored, bad JSON and missing fields', () => {
    const fallback = { collapsed: false, width: 248 };
    expect(readSidebar(null)).toEqual(fallback);
    expect(readSidebar('{not json')).toEqual(fallback);
    expect(readSidebar('null')).toEqual(fallback);
    expect(readSidebar('{}')).toEqual(fallback);
    expect(readSidebar('{"collapsed":"yes","width":"wide"}')).toEqual(fallback);
    expect(readSidebar('{"collapsed":true}')).toEqual({ collapsed: true, width: 248 });
    expect(readSidebar('{"width":300}')).toEqual({ collapsed: false, width: 300 });
  });

  it('clamps the stored width into range', () => {
    expect(readSidebar('{"collapsed":false,"width":90}')).toEqual({ collapsed: false, width: 200 });
    expect(readSidebar('{"collapsed":false,"width":900}')).toEqual({
      collapsed: false,
      width: 420,
    });
  });

  it('keeps a width between 200 and 420', () => {
    expect(clampSidebarWidth(120)).toBe(200);
    expect(clampSidebarWidth(250)).toBe(250);
    expect(clampSidebarWidth(500)).toBe(420);
    expect(clampSidebarWidth(Number.NaN)).toBe(248);
  });
});
