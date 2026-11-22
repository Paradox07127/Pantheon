import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchSession } from '@pantheon/protocol';
import { SessionRowButton } from '@/screens/sessions/SessionRow';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.parse('2026-11-13T10:40:00.000Z');

const session = (
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id: 'row',
  created_at: new Date(NOW - 40 * 60_000).toISOString(),
  title: 'Refund v2',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-row',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: new Date(NOW - 3 * 60_000).toISOString(),
  changes: null,
  merge: null,
  ...extra,
});

const render = (s: WorkbenchSession, unread: boolean) =>
  renderToStaticMarkup(
    createElement(SessionRowButton, { session: s, on: false, unread, now: NOW, onSelect() {} }),
  );
/** What the row shows after its title, as a sighted user reads it. */
const shownState = (html: string) =>
  html
    .replace(/<title>.*?<\/title>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/^Refund v2/, '');
const nameOf = (html: string) => /aria-label="([^"]*)"/.exec(html)![1]!;

const failedGate = { state: 'failed', passed: 2, failed: 1, running: 0 } as const;
const changed = { files: 4, additions: 184, deletions: 22 };
const environment = { state: 'blocked', failure_class: 'environment' } as const;
const runningTurn = { id: 'turn', state: 'running' } as const;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sidebar row state', () => {
  it.each([
    [
      'environment broken over waiting',
      session('waiting', { waiting: 1, merge: environment }),
      false,
      () => zh('sessions.sidebar.badge.environment'),
    ],
    [
      'waiting for approval over running',
      session('waiting', { waiting: 1, waiting_kind: 'approval', last_turn: runningTurn }),
      false,
      () => zh('components.sessionState.approval'),
    ],
    [
      'waiting for an answer over a new result',
      session('waiting', { waiting: 1, waiting_kind: 'question' }),
      true,
      () => zh('components.sessionState.question'),
    ],
    [
      'gate failed over ready',
      session('ready', { gate: failedGate, changes: changed }),
      false,
      () => zh('sessions.screen.gateFailed'),
    ],
    [
      'gate failed over running',
      session('running', { gate: failedGate, last_turn: runningTurn }),
      false,
      () => zh('sessions.screen.gateFailed'),
    ],
    [
      'run failed over a new result',
      session('failed'),
      true,
      () => zh('components.sessionState.failed'),
    ],
    [
      'running time over a new result',
      session('running', { last_turn: runningTurn, changes: changed }),
      true,
      () => zhf('lib.time.minutes', { minutes: 40 }),
    ],
    [
      'ready diff over a new result',
      session('ready', { changes: changed }),
      true,
      () => '+184 −22',
    ],
    ['new result over landed', session('merged'), true, () => zh('sessions.sidebar.badge.unread')],
    ['landed', session('merged'), false, () => zh('components.sessionState.merged')],
    [
      'run failed over a failed gate',
      session('failed', { gate: failedGate }),
      false,
      () => zh('components.sessionState.failed'),
    ],
    ['idle shows nothing', session('idle'), false, () => ''],
  ])('%s', (_case, listed, unread, expected) => {
    expect(shownState(render(listed, unread))).toBe(expected());
  });

  it('names a broken environment, a ready diff and a queued turn in the row name', () => {
    expect(
      nameOf(render(session('idle', { last_turn: { id: 'turn', state: 'queued' } }), false)),
    ).toContain(zh('sessions.row.badge.queued'));
    expect(nameOf(render(session('ready', { merge: environment }), false))).toContain(
      zh('sessions.sidebar.badge.environment'),
    );
    expect(nameOf(render(session('ready', { changes: changed }), false))).toContain(
      zhf('components.diffBar.label', { additions: 184, deletions: 22 }),
    );
  });

  it('counts the running time from when the current turn started', () => {
    const running = session('running', {
      created_at: new Date(NOW - 3 * 86_400_000).toISOString(),
      turn_started_at: new Date(NOW - 2 * 60_000).toISOString(),
      last_turn: runningTurn,
    });
    expect(shownState(render(running, false))).toBe(zhf('lib.time.minutes', { minutes: 2 }));
  });

  it('counts a running turn without a start time on from when the session opened', () => {
    const running = session('running', { last_turn: runningTurn });
    vi.setSystemTime(NOW + 5 * 60_000);
    expect(shownState(render(running, false))).toBe(zhf('lib.time.minutes', { minutes: 45 }));
  });
});
