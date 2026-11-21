import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@pantheon/domain';
import type {
  SessionGates,
  SessionGatesHistory,
  SessionPreflight,
  WorkbenchSession,
} from '@pantheon/protocol';
import { zh } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  board: { board: null as any, events: [] as any[], status: { state: 'live' } },
  history: { events: [] as any[], error: null as string | null, reload() {} },
  gates: null as any,
  shell: {} as Record<string, unknown>,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => mock.history,
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: mock.gates, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
}));
// The shell's own state with the fields a test sets; zustand would give a server render its initial state.
vi.mock('@/store', async (actual) => {
  const real = await actual<any>();
  const state = () => ({ ...real.useShell.getState(), ...mock.shell });
  return {
    ...real,
    useShell: Object.assign((selector: any) => selector(state()), real.useShell, {
      getState: state,
    }),
  };
});

import { LastTurnMark } from '@/components/SessionStateIcon';
import { t } from '@/i18n';
import { RecentActivity } from '@/components/RecentActivity';
import { AttachmentStrip } from '@/screens/sessions/parts';
import { ChecksTab, MergeBar } from '@/screens/sessions/panel';
import { SessionInspector } from '@/screens/sessions/SessionsScreen';

afterEach(() => {
  mock.board = { board: null, events: [], status: { state: 'live' } };
  mock.history.events = [];
  mock.gates = null;
  mock.shell = {};
});

const NOW = Date.UTC(2026, 10, 10, 12);
const html = (el: ReactElement) => renderToStaticMarkup(el);
const shapeOf = (markup: string) => /data-shape="([^"]*)"/.exec(markup)?.[1];
const lucide = (markup: string) => [...markup.matchAll(/lucide-([a-z-]+?)(?:-icon)?[ "]/g)];
const lucideNames = (markup: string) =>
  lucide(markup)
    .map(([, name]) => name!)
    .filter((name) => name !== 'icon');

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-10T08:00:00.000Z',
  title: 'Serve exports',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-10T08:00:00.000Z',
  changes: { files: 1, additions: 2, deletions: 1 },
  merge: null,
  ...extra,
});

describe('recent activity', () => {
  const event = (sequence: number, kind: string, aggregate_id: string) => ({
    sequence,
    event_id: `event-${sequence}`,
    kind,
    aggregate_id,
    aggregate_revision: 1,
    project_id: 'project-a',
    causation_id: '',
    created_at: NOW - sequence * 1000,
    payload: {},
  });

  it('marks merged and blocked rows as the session list does and a failure with an octagon', () => {
    mock.board = {
      board: { session_turns: [{ id: 'turn-1', session_id: 'session-a' }], sessions: [] },
      events: [],
      status: { state: 'live' },
    };
    mock.history.events = [
      event(4, 'session.gate_run_cancelled', 'session-a'),
      event(3, 'turn.failed', 'turn-1'),
      event(2, 'session.merge_blocked', 'session-a'),
      event(1, 'session.merged', 'session-a'),
    ];
    const page = html(
      createElement(RecentActivity, {
        projectId: 'project-a',
        sessions: [listed({ state: 'merged' })],
        onOpen() {},
      }),
    );
    const row = (label: string) =>
      new RegExp(
        `<button type="button" class="act-row">((?:(?!</button>)[\\s\\S])*?<span class="act-kind">${label}</span>)`,
      ).exec(page)![1]!;
    const kind = (key: string) => row(zh(`components.recentActivity.${key}`));
    expect(shapeOf(kind('merged'))).toBe('merge-check');
    expect(shapeOf(kind('mergeBlocked'))).toBe('merge-blocked');
    expect(lucideNames(kind('failed'))).toContain('octagon-x');
    expect(lucideNames(kind('failed'))).not.toContain('circle-x');
    expect(lucideNames(kind('cancelled'))).toEqual(['square']);
  });
});

describe('session panel', () => {
  const preflight = (last: SessionPreflight['gate']['last']): SessionPreflight =>
    ({
      can_merge: true,
      target_branch: 'main',
      gate: { last, configured_total: 2 },
      conflicts: { state: 'none' },
    }) as SessionPreflight;
  const results = (exit: number) => [
    { name: 'lint', exit_code: 0, timed_out: false, output_tail: '' },
    { name: 'test', exit_code: exit, timed_out: false, output_tail: '' },
  ];
  const gates = (extra: Partial<SessionGates> = {}): SessionGates => ({
    configured: true,
    running: false,
    last: { commit: 'c', checked_at: 1, results: results(0) },
    ...extra,
  });
  const gateCell = (props: { preflight: SessionPreflight | null; gates: SessionGates | null }) => {
    const bar = html(
      createElement(MergeBar, {
        sessionId: 'session-a',
        revision: 1,
        live: true,
        merging: false,
        onPreflight: () => {},
        branch: 'dev',
        source: '/source',
        onChecks: () => {},
        ...props,
      }),
    );
    return /<button[^>]*aria-label="检查状态 [^"]*"[\s\S]*?<\/button>/.exec(bar)![0];
  };

  it('draws the gate state with the shield the session list uses, each state its own', () => {
    const cells = {
      running: gateCell({ preflight: preflight('passed'), gates: gates({ running: true }) }),
      cancelling: gateCell({
        preflight: preflight('passed'),
        gates: gates({ operation: { id: 'op', state: 'cancelling' } } as Partial<SessionGates>),
      }),
      cancelled: gateCell({
        preflight: preflight('passed'),
        gates: gates({ operation: { id: 'op', state: 'cancelled' } } as Partial<SessionGates>),
      }),
      passed: gateCell({ preflight: preflight('passed'), gates: gates() }),
      failed: gateCell({
        preflight: preflight('failed'),
        gates: gates({ last: { commit: 'c', checked_at: 1, results: results(1) } }),
      }),
      stale: gateCell({ preflight: preflight('stale'), gates: gates() }),
      none: gateCell({ preflight: preflight('none'), gates: null }),
    };
    expect(Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, shapeOf(v)]))).toEqual({
      running: 'shield-arc',
      cancelling: 'shield-stop-arc',
      cancelled: 'shield-stop',
      passed: 'shield-check',
      failed: 'shield-cross',
      stale: 'dashed-shield',
      none: 'shield',
    });
    const status = t(
      {
        id: 'sessions.panel.merge.checkStatus',
        defaultMessage: 'Check status {gate} {passed}/{total}',
      },
      { gate: zh('sessions.panel.gate.none'), passed: 0, total: 2 },
    );
    expect(cells.none).toContain(`aria-label="${status}"`);
  });

  it('marks a skipped check with a dash, apart from the gate states', () => {
    const run = (id: string, minutesAgo: number, skipped: boolean) => ({
      run_id: id,
      commit: `${id}0123456789abcdef`,
      started_at: new Date(NOW - minutesAgo * 60_000 - 10_000).toISOString(),
      finished_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
      results: [
        { name: 'lint', command: ['pnpm', 'lint'], exit_code: 0 },
        {
          name: 'build',
          command: ['pnpm', 'build'],
          ...(skipped ? { skipped: true } : { exit_code: 0 }),
        },
      ],
    });
    const newest = run('c3', 1, false);
    const older = run('b2', 20, true);
    mock.shell = { sessionRun: 'b2' };
    const tab = html(
      createElement(ChecksTab, {
        gates: { data: gates(), error: null, reload: () => {} },
        history: {
          data: { runs: [newest, older] } as unknown as SessionGatesHistory,
          error: null,
          reload: () => {},
        },
        readOnly: false,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach: () => {},
        onRun: () => {},
        onSettings: () => {},
      }),
    );
    const skipped = /<span class="ss-ck skipped"[^>]*aria-label="跳过">[\s\S]*?<\/span>/.exec(
      tab,
    )![0];
    expect(lucideNames(skipped)).toEqual(['minus']);
  });

  it('heads the checks column with its shield and the count of checks that did not pass', () => {
    const session: Session = {
      id: 'session-a',
      revision: 2,
      project_id: 'project-a',
      runtime: 'claude',
      state: 'open',
      turn_count: 1,
      workspace_id: 'workspace-a',
    };
    mock.board = {
      board: {
        cursor: 1,
        sessions: [session],
        session_turns: [],
        projects: [{ id: 'project-a', roots: ['/repo'] }],
        workspaces: [
          { id: 'workspace-a', source: '/repo', path: '/work/a', base_sha: '0123456789abcdef' },
        ],
      },
      events: [],
      status: { state: 'live' },
    };
    mock.gates = gates({ last: { commit: 'c', checked_at: 1, results: results(1) } });
    const inspector = html(
      createElement(SessionInspector, {
        sessionId: 'session-a',
        listed: listed(),
        session,
        panels: ['checks'],
        onOpen: () => {},
        onClose: () => {},
        onView: () => {},
      }),
    );
    const head = /<div class="ss-colh">[\s\S]*?关闭检查/.exec(inspector)![0];
    expect(lucideNames(head)[0]).toBe('shield-check');
    const failing = t(
      {
        id: 'sessions.screen.checksFailing',
        defaultMessage: '{count, plural, one {# check not passed} other {# checks not passed}}',
      },
      { count: 1 },
    );
    expect(head).toContain(`<span class="ss-coln" role="img" aria-label="${failing}">1</span>`);
  });

  it('attaches a merge conflict with the conflict mark, not the merged one', () => {
    const strip = html(
      createElement(AttachmentStrip, {
        items: [],
        pending: [],
        onRemove: () => {},
        feedback: [{ id: 'conflict-a', kind: 'conflict', label: 'src/a.ts', text: 'conflict' }],
      }),
    );
    const conflict = zh('sessions.composer.feedbackConflict');
    const mark = new RegExp(`<svg[^>]*aria-label="${conflict}"[^>]*>`).exec(strip)![0];
    expect(lucideNames(mark)).toEqual(['git-merge-conflict']);
  });
});

describe('last turn mark', () => {
  it('marks an interrupted turn with a stop square, not the discarded slash', () => {
    const mark = html(
      createElement(LastTurnMark, {
        session: listed({ state: 'idle', last_turn: { id: 'turn-a', state: 'cancelled' } }),
      }),
    );
    expect(mark).toContain(`aria-label="${zh('components.sessionState.lastTurnInterrupted')}"`);
    expect(shapeOf(mark)).toBe('filled-square');
    expect(mark).toContain('<rect');
    expect(mark).not.toContain('<circle');
    expect(mark).not.toContain('<path');
  });
});
