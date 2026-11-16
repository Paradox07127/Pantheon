import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardTaskState, BoardTaskStatus, WorkbenchSession } from '@pantheon/protocol';
import {
  GateMark,
  LastTurnMark,
  MergeBlockedMark,
  SessionStateIcon,
  lastTurnLabel,
  recapLine,
} from '../../apps/web/src/components/SessionStateIcon.js';
import {
  STATE,
  STATUS,
  StateIcon,
  StatusIcon,
  runtimeName,
} from '../../apps/web/src/screens/board/status.js';
import { SessionListRow } from '../../apps/web/src/screens/sessions/SessionsScreen.js';
import {
  SessionPreview,
  SessionRowButton,
} from '../../apps/web/src/screens/sessions/SessionRow.js';
import { zh } from './i18n-setup.js';

type Place = 'list' | 'header' | 'card';
const PLACES: Place[] = ['list', 'header', 'card'];

const session = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T08:00:00.000Z',
  title: 'fix the importer',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

const render = (s: WorkbenchSession, place: Place = 'list') =>
  renderToStaticMarkup(createElement(SessionStateIcon, { session: s, place }));

const attr = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
const inner = (html: string) => /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(html)?.[1];

const CASES: [string, Partial<WorkbenchSession>, string][] = [
  ['starting', { state: 'starting' }, zh('components.sessionState.starting')],
  ['running', { state: 'running' }, zh('components.sessionState.running')],
  [
    'waiting approval',
    { state: 'waiting', waiting: 1, waiting_kind: 'approval' },
    zh('components.sessionState.approval'),
  ],
  [
    'waiting question',
    { state: 'waiting', waiting: 1, waiting_kind: 'question' },
    zh('components.sessionState.question'),
  ],
  [
    'waiting baseline review',
    { state: 'waiting', waiting_kind: 'baseline_review' },
    zh('components.sessionState.baselineReview'),
  ],
  ['idle', { state: 'idle' }, zh('components.sessionState.idle')],
  ['ready', { state: 'ready' }, zh('components.sessionState.ready')],
  ['merging', { state: 'merging' }, zh('components.sessionState.merging')],
  ['failed', { state: 'failed' }, zh('components.sessionState.failed')],
  ['merged', { state: 'merged' }, zh('components.sessionState.merged')],
  ['discarded', { state: 'discarded' }, zh('components.sessionState.discarded')],
  ['done', { state: 'done' }, zh('components.sessionState.done')],
  ['reconciling', { state: 'idle', reconciling: true }, zh('components.sessionState.reconciling')],
  ['stopping', { state: 'running', stopping: true }, zh('components.sessionState.stopping')],
];

describe('last turn result', () => {
  const mark = (s: WorkbenchSession) =>
    renderToStaticMarkup(createElement(LastTurnMark, { session: s }));

  it('shows a failed turn beside the idle lifecycle without changing its glyph', () => {
    const s = session({ last_turn: { id: 'turn-a', state: 'failed', error: 'Build failed' } });
    expect(attr(render(s), 'aria-label')).toBe(zh('components.sessionState.idle'));
    expect(lastTurnLabel(s)).toBe(zh('components.sessionState.lastTurnFailed'));
    expect(attr(mark(s), 'aria-label')).toBe(zh('components.sessionState.lastTurnFailed'));
    expect(attr(mark(s), 'style')).toContain('var(--bad)');
    const row = renderToStaticMarkup(
      createElement(SessionListRow, { session: s, on: false, now: 0, onSelect() {} }),
    );
    expect(row).toContain('，空闲，上回合失败');
    const preview = renderToStaticMarkup(createElement(SessionPreview, { session: s, now: 0 }));
    expect(preview).toContain('空闲，Build failed');
  });

  it('keeps a ready session mergeable and distinguishes a cancelled turn', () => {
    const s = session({ state: 'ready', last_turn: { id: 'turn-a', state: 'cancelled' } });
    expect(attr(render(s), 'aria-label')).toBe(zh('components.sessionState.ready'));
    expect(lastTurnLabel(s)).toBe(zh('components.sessionState.lastTurnInterrupted'));
    expect(attr(mark(s), 'style')).toContain('var(--idle)');
  });

  it('hides an old result while the session works, recovers, stops or ends', () => {
    for (const state of [
      'starting',
      'running',
      'waiting',
      'merging',
      'merged',
      'discarded',
      'done',
      'failed',
    ] as const)
      expect(mark(session({ state, last_turn: { id: 'turn-a', state: 'failed' } }))).toBe('');
    for (const extra of [{ stopping: true }, { reconciling: true }])
      expect(mark(session({ ...extra, last_turn: { id: 'turn-a', state: 'failed' } }))).toBe('');
    for (const state of ['queued', 'running', 'completed'] as const)
      expect(mark(session({ last_turn: { id: 'turn-a', state } }))).toBe('');
    expect(mark(session())).toBe('');
  });
});

describe('recap line', () => {
  const recap = {
    headline: 'Importer fixed',
    needs_you: 'Keep the old column?',
    happened: 'Ran the tests',
    at: 0,
  };
  const plain = { headline: recap.headline, happened: recap.happened, at: 0 };

  it.each<[string, boolean, WorkbenchSession['recap'], string | null]>([
    ['the headline while the session does not wait', false, recap, 'Importer fixed'],
    ['what the session needs while it waits', true, recap, 'Keep the old column?'],
    ['the headline while it waits without saying for what', true, plain, 'Importer fixed'],
    ['nothing without a recap', true, undefined, null],
  ])('gives %s', (_, waits, given, line) => {
    expect(recapLine(given, waits)).toBe(line);
  });

  it("puts the session's recap line under the title of its list row and in its name", () => {
    const row = (extra: Partial<WorkbenchSession>) =>
      renderToStaticMarkup(
        createElement(SessionRowButton, {
          session: session(extra),
          on: false,
          now: 0,
          onSelect() {},
        }),
      );
    const text = (html: string) => html.replace(/<[^>]+>/g, '');
    expect(text(row({ recap }))).toContain('fix the importerImporter fixed');
    expect(attr(row({ recap }), 'aria-label')).toContain('，Importer fixed');
    const waiting = row({ state: 'waiting', waiting: 1, waiting_kind: 'question', recap });
    expect(text(waiting)).toContain('fix the importerKeep the old column?');
    expect(text(waiting)).not.toContain('Importer fixed');
    expect(text(row({}))).not.toMatch(/Importer fixed|Keep the old column/);
  });
});

describe('session state icon', () => {
  it.each(CASES)('renders %s as an image named for the state', (_, extra, label) => {
    const html = render(session(extra));
    expect(html.startsWith('<svg')).toBe(true);
    expect(attr(html, 'role')).toBe('img');
    expect(attr(html, 'aria-label')).toBe(label);
    expect(attr(html, 'width')).toBe('14');
    expect(attr(html, 'height')).toBe('14');
  });

  it('gives each of the fourteen states its own shape and drawing', () => {
    const htmls = CASES.map(([, extra]) => render(session(extra)));
    expect(new Set(htmls.map((h) => attr(h, 'data-shape'))).size).toBe(14);
    expect(new Set(htmls.map(inner)).size).toBe(14);
  });

  it('colours each state from its token', () => {
    const tone = (extra: Partial<WorkbenchSession>) => attr(render(session(extra)), 'style');
    expect(tone({ state: 'running' })).toContain('var(--run)');
    expect(tone({ state: 'starting' })).toContain('var(--run)');
    expect(tone({ state: 'waiting', waiting_kind: 'question' })).toContain('var(--wait)');
    expect(tone({ state: 'idle' })).toContain('var(--idle)');
    expect(tone({ state: 'ready' })).toContain('var(--ready)');
    expect(tone({ state: 'merging' })).toContain('var(--ready)');
    expect(tone({ state: 'failed' })).toContain('var(--bad)');
    expect(tone({ state: 'merged' })).toContain('var(--ok)');
    expect(tone({ state: 'done' })).toContain('var(--ok)');
    expect(tone({ state: 'discarded' })).toContain('var(--idle)');
    expect(tone({ state: 'idle', reconciling: true })).toContain('var(--wait)');
    expect(tone({ state: 'idle', stopping: true })).toContain('var(--idle)');
  });

  it('draws a seen finished state in the list in the idle tone under its own label', () => {
    const seen = (extra: Partial<WorkbenchSession>, place: Place = 'list') =>
      renderToStaticMarkup(
        createElement(SessionStateIcon, { session: session(extra), place, seen: true }),
      );
    for (const [state, label] of [
      ['done', zh('components.sessionState.done')],
      ['failed', zh('components.sessionState.failed')],
      ['merged', zh('components.sessionState.merged')],
    ] as const) {
      const html = seen({ state });
      expect(attr(html, 'style')).toContain('var(--idle)');
      expect(attr(html, 'aria-label')).toBe(label);
      expect(inner(html)).toBe(inner(render(session({ state }))));
      expect(attr(seen({ state }, 'header'), 'style')).not.toContain('var(--idle)');
    }
    expect(attr(seen({ state: 'running' }), 'style')).toContain('var(--run)');
    expect(attr(seen({ state: 'ready' }), 'style')).toContain('var(--ready)');
  });

  it('marks an unread finished row with the unread mark and gives a read finished row none', () => {
    const row = (unread: boolean) =>
      renderToStaticMarkup(
        createElement(SessionListRow, {
          session: session({ state: 'done' }),
          on: false,
          now: 0,
          unread,
          onSelect() {},
        }),
      );
    expect(row(true).match(/class="ss-badge"/g)).toHaveLength(1);
    expect(row(true)).toContain('data-badge="unread"');
    expect(row(false)).not.toContain('ss-badge');
  });

  it('shows stopping over reconciling over the listed state', () => {
    const label = (extra: Partial<WorkbenchSession>) => attr(render(session(extra)), 'aria-label');
    expect(
      label({ state: 'waiting', waiting_kind: 'approval', stopping: true, reconciling: true }),
    ).toBe(zh('components.sessionState.stopping'));
    expect(label({ state: 'waiting', waiting_kind: 'approval', reconciling: true })).toBe(
      zh('components.sessionState.reconciling'),
    );
    expect(label({ state: 'failed', reconciling: true })).toBe(
      zh('components.sessionState.reconciling'),
    );
    expect(label({ state: 'failed' })).toBe(zh('components.sessionState.failed'));
  });

  it('picks the waiting glyph by its kind', () => {
    const shape = (kind: WorkbenchSession['waiting_kind']) =>
      attr(render(session({ state: 'waiting', waiting: 1, waiting_kind: kind })), 'data-shape');
    const shapes = [shape('approval'), shape('question'), shape('baseline_review')];
    expect(new Set(shapes).size).toBe(3);
  });

  it('never animates a waiting glyph in any place', () => {
    for (const place of PLACES)
      for (const kind of ['approval', 'question', 'baseline_review'] as const) {
        const html = render(session({ state: 'waiting', waiting: 1, waiting_kind: kind }), place);
        expect(html).not.toMatch(/si-breathe|si-spin/);
      }
  });

  it('animates starting, running, merging and stopping in every place', () => {
    for (const place of PLACES) {
      expect(render(session({ state: 'running' }), place)).toContain('si-breathe');
      expect(render(session({ state: 'starting' }), place)).toContain('si-spin');
      expect(render(session({ state: 'merging' }), place)).toContain('si-spin');
      expect(render(session({ state: 'idle', stopping: true }), place)).toContain('si-spin');
    }
  });

  it('keeps every resting state still', () => {
    for (const [name, extra] of CASES)
      if (!['starting', 'running', 'merging', 'stopping'].includes(name))
        expect(render(session(extra))).not.toMatch(/si-breathe|si-spin/);
  });
});

describe('gate mark', () => {
  const GATES: [NonNullable<WorkbenchSession['gate']>['state'], string, string][] = [
    ['running', zh('components.gate.running'), 'var(--run)'],
    ['cancelling', zh('components.gate.cancelling'), 'var(--run)'],
    ['cancelled', zh('components.gate.cancelled'), 'var(--idle)'],
    ['passed', zh('components.gate.passed'), 'var(--ok)'],
    ['failed', zh('components.gate.failed'), 'var(--bad)'],
    ['stale', zh('components.gate.stale'), 'var(--idle)'],
  ];
  const mark = (state: NonNullable<WorkbenchSession['gate']>['state']) =>
    renderToStaticMarkup(
      createElement(GateMark, { gate: { state, passed: 0, failed: 0, running: 0 } }),
    );

  it.each(GATES)('marks a %s gate', (state, label, tone) => {
    const html = mark(state);
    expect(attr(html, 'role')).toBe('img');
    expect(attr(html, 'aria-label')).toBe(label);
    expect(attr(html, 'style')).toContain(tone);
  });

  it('draws each gate state differently and spins only while running or cancelling', () => {
    const htmls = GATES.map(([state]) => mark(state));
    expect(new Set(htmls.map((h) => attr(h, 'data-shape'))).size).toBe(GATES.length);
    expect(new Set(htmls.map(inner)).size).toBe(GATES.length);
    expect(htmls.map((h) => h.includes('si-spin'))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('renders nothing without a gate run', () => {
    expect(renderToStaticMarkup(createElement(GateMark, { gate: undefined }))).toBe('');
  });
});

describe('merge blocked mark', () => {
  const blocked = (merge: WorkbenchSession['merge']) =>
    renderToStaticMarkup(createElement(MergeBlockedMark, { merge }));

  it('marks a blocked merge with a red blocked path of its own', () => {
    const html = blocked({ state: 'blocked', reason: 'local_changes' });
    expect(attr(html, 'role')).toBe('img');
    expect(attr(html, 'aria-label')).toBe(zh('components.sessionState.mergeBlocked'));
    expect(attr(html, 'data-shape')).toBe('merge-blocked');
    expect(attr(html, 'style')).toContain('var(--bad)');
    const merging = render(session({ state: 'merging' }));
    expect(inner(html)).not.toBe(inner(merging));
  });

  it('shows in the row preview after the gate mark, and in the row name', () => {
    const blockedSession = session({
      state: 'ready',
      gate: {
        state: 'passed',
        passed: 0,
        failed: 0,
        running: 0,
        finished_at: '2026-11-03T08:00:00.000Z',
      },
      merge: { state: 'blocked', reason: 'local_changes' },
    });
    const row = renderToStaticMarkup(
      createElement(SessionListRow, { session: blockedSession, on: false, now: 0, onSelect() {} }),
    );
    const preview = renderToStaticMarkup(
      createElement(SessionPreview, { session: blockedSession, now: 0 }),
    );
    expect(preview).toMatch(/aria-label="门禁通过".*aria-label="合并被挡"/);
    expect(row).toContain('，门禁通过，合并被挡"');
  });

  it('renders nothing unless the merge is blocked', () => {
    expect(blocked(null)).toBe('');
    expect(blocked({ state: 'running' })).toBe('');
  });
});

describe('board status icon', () => {
  const icon = (status: BoardTaskStatus) =>
    renderToStaticMarkup(createElement(StatusIcon, { status }));

  it('paints running with the running colour, not the accent', () => {
    expect(icon('running')).toContain('var(--run)');
    expect(icon('running')).not.toContain('var(--ac)');
  });

  it('draws ready as the purple diamond the session list uses', () => {
    const html = icon('ready');
    expect(html).toContain('stroke:var(--ready)');
    expect(html).not.toContain('var(--ok)');
    expect(html).toMatch(/<path d="M6 1\.3 10\.7 6 6 10\.7 1\.3 6Z"/);
  });

  it('draws an idle session as a grey ring named 空闲, apart from the orange waiting dot', () => {
    expect(STATUS.idle.label).toBe(zh('board.task.status.idle'));
    expect(STATUS.waiting.label).toBe(zh('board.task.status.waiting'));
    expect(icon('idle')).toMatch(/<circle[^>]*fill="none"[^>]*stroke:var\(--idle\)/);
    expect(icon('waiting')).toContain('fill:var(--wait)');
  });
});

describe('board runtime name', () => {
  it('names each runtime of a segment and keeps an unknown one as given', () => {
    expect(['claude', 'codex', 'agy', 'grok', 'fixture', null].map(runtimeName)).toEqual([
      'Claude',
      'Codex',
      'agy',
      'grok',
      'fixture',
      zh('components.runtime.unknown'),
    ]);
  });
});

describe('board task state icon', () => {
  const icon = (state: BoardTaskState) => renderToStaticMarkup(createElement(StateIcon, { state }));
  const states = Object.keys(STATE) as BoardTaskState[];

  it('draws each of the twelve task states with a glyph of its own', () => {
    expect(states).toHaveLength(12);
    expect(new Set(states.map((state) => inner(icon(state)))).size).toBe(12);
  });

  it('gives waiting on upstream and awaiting acceptance icons no session status has', () => {
    expect(STATE.waiting_upstream.label).toBe(zh('board.task.state.waitingUpstream'));
    expect(STATE.awaiting_acceptance.label).toBe(zh('board.task.state.awaitingAcceptance'));
    const statuses = (Object.keys(STATUS) as BoardTaskStatus[]).map((status) =>
      inner(renderToStaticMarkup(createElement(StatusIcon, { status }))),
    );
    for (const state of ['waiting_upstream', 'awaiting_acceptance'] as const)
      expect(statuses).not.toContain(inner(icon(state)));
    expect(icon('waiting_upstream')).toMatch(/stroke:var\(--idle\)[^>]*stroke-dasharray/);
    expect(icon('awaiting_acceptance')).toContain('stroke:var(--wait)');
  });

  it('draws awaiting merge as the ready diamond', () => {
    expect(STATE.awaiting_merge.label).toBe(zh('board.task.state.awaitingMerge'));
    expect(icon('awaiting_merge')).toContain('stroke:var(--ready)');
  });

  it('draws needs attention in the idle colour', () => {
    expect(STATE.needs_attention.label).toBe(zh('board.task.state.needsAttention'));
    expect(icon('needs_attention')).toContain('stroke:var(--idle)');
  });
});

describe('state icon motion', () => {
  const css = readFileSync(
    new URL('../../apps/web/src/components/state-icon.css', import.meta.url),
    'utf8',
  );
  const index = readFileSync(new URL('../../apps/web/src/index.css', import.meta.url), 'utf8');

  it('breathes in 2s and spins in 1.2s', () => {
    expect(css).toMatch(/\.si-breathe\s*\{[^}]*animation:\s*si-breathe 2s/);
    expect(css).toMatch(/\.si-spin\s*\{[^}]*animation:\s*si-spin 1\.2s linear/);
    expect(css).toMatch(/@keyframes si-breathe\s*\{[^@]*opacity:\s*\.45/);
  });

  it('stays inside the global reduced-motion stop', () => {
    expect(index).toMatch(/^\.pt\[data-motion=reduced\] \*[^{]*\{animation:none!important/m);
    expect(css).not.toContain('!important');
    expect(css).not.toContain('prefers-reduced-motion');
  });
});
