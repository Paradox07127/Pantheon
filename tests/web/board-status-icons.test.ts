import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskState, BoardTaskStatus } from '@pantheon/protocol';
import {
  GateMark,
  StateGlyph,
  type GlyphName,
} from '../../apps/web/src/components/SessionStateIcon.js';
import { LeadStates } from '../../apps/web/src/screens/board/BoardFrame.js';
import { LeadPanel } from '../../apps/web/src/screens/board/LeadPanel.js';
import { FindingRow } from '../../apps/web/src/screens/board/Lists.js';
import type { BoardLead } from '../../apps/web/src/screens/board/frame-model.js';
import {
  BlockedIcon,
  StateIcon,
  StatusIcon,
  TaskBadges,
} from '../../apps/web/src/screens/board/status.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const html = (el: ReactElement) => renderToStaticMarkup(el);
const shapes = (markup: string) => [...markup.matchAll(/data-shape="([^"]*)"/g)].map((m) => m[1]);
const inner = (markup: string) => /^<svg[^>]*>([\s\S]*)<\/svg>$/.exec(markup)?.[1];
const glyph = (name: GlyphName) => html(createElement(StateGlyph, { name }));
const status = (s: BoardTaskStatus) => html(createElement(StatusIcon, { status: s }));
const state = (s: BoardTaskState) => html(createElement(StateIcon, { state: s }));
const octagon = inner(html(createElement(BlockedIcon)))!;
/** The colour the first glyph in the markup is drawn in. */
const tone = (markup: string) => /<svg[^>]*style="color:([^"]*)"/.exec(markup)?.[1];

const task = (
  id: string,
  taskStatus: BoardTaskStatus,
  extra: Partial<BoardModel['tasks'][number]> = {},
): BoardModel['tasks'][number] => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: taskStatus,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...extra,
});

const board = (tasks: BoardModel['tasks'], extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    headline: null,
    counts: {
      running: 0,
      waiting: 0,
      ready: 0,
      failed: 0,
      merged: 0,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      cost_usd: null,
    },
    lanes: [],
    tasks,
    edges: [],
    milestones: [],
    burnup: [],
    usage: [],
    models: [],
    merges: [],
    findings: [],
    risks: [],
    ...extra,
  }) as unknown as BoardModel;

const lead = (inbox: number): BoardLead => ({
  session_id: 'lead-a',
  title: 'lead-a',
  state: 'idle',
  inbox,
  updated_at: NOW,
});

describe('board status glyphs', () => {
  it('keeps every board icon a 12px decorative frame beside its label', () => {
    for (const s of ['running', 'done', 'failed', 'waiting'] as const)
      expect(status(s)).toMatch(/^<svg class="bd-sti"[^>]*aria-hidden="true"/);
    for (const s of ['merged', 'gating', 'waiting_approval', 'blocked'] as const)
      expect(state(s)).toMatch(/^<svg class="bd-sti"[^>]*aria-hidden="true"[^>]*data-state/);
  });

  it('draws running, done and failed with the session glyphs of the same meaning', () => {
    expect(status('running')).toContain(glyph('running'));
    expect(status('running')).toContain('si-breathe');
    expect(status('running')).not.toContain('bd-spin');
    expect(status('done')).toContain(glyph('done'));
    expect(status('failed')).toContain(glyph('failed'));
    expect(state('running')).toContain(glyph('running'));
    expect(state('failed')).toContain(glyph('failed'));
  });

  it('draws a merged task as the merge path with a check, apart from a done one', () => {
    expect(shapes(state('merged'))).toEqual(['merge-check']);
    expect(state('merged')).toContain(glyph('merged'));
    expect(inner(state('merged'))).not.toBe(inner(status('done')));
  });

  it('draws a gating task as a shield with a spinning arc, not the diamond kept for ready', () => {
    const gating = state('gating');
    expect(shapes(gating)).toEqual(['shield-arc']);
    expect(gating).toContain('si-spin');
    expect(gating).not.toContain('M6 1.3 10.7 6 6 10.7 1.3 6Z');
  });

  it('draws a gating task in the colour of a session whose gates are running', () => {
    expect(tone(state('gating'))).toBe(tone(html(createElement(GateMark, { state: 'running' }))));
  });

  it('draws a blocked task in the colour of a failed one', () => {
    expect(/<g style="color:([^"]*)"/.exec(state('blocked'))?.[1]).toBe(tone(state('failed')));
  });

  it('draws a task waiting for approval as the session shield with an exclamation', () => {
    expect(state('waiting_approval')).toContain(glyph('approval'));
    expect(state('waiting_approval')).not.toMatch(/<circle[^>]*fill:var\(--wait\)/);
  });

  it('draws a blocked state with the octagon of the blocked badge, in red', () => {
    const blocked = state('blocked');
    expect(blocked).toContain(octagon);
    expect(blocked).toContain('var(--bad)');
  });
});

describe('board badges', () => {
  const badges = (label: string) =>
    html(
      createElement(TaskBadges, {
        badges: [{ kind: 'waiting', label, waits: label === '等待审批' ? 'approval' : 'question' }],
      }),
    );

  it('marks waiting for approval and for an answer with the session glyphs, under their labels', () => {
    expect(shapes(badges('等待审批'))).toEqual(['shield-exclamation']);
    expect(shapes(badges('等待回答'))).toEqual(['diamond-question']);
    for (const label of ['等待审批', '等待回答']) {
      expect(badges(label)).toContain(`role="img" aria-label="${label}"`);
      expect(badges(label)).not.toContain('lucide-hand');
    }
  });

  it('marks a blocker finding with the same octagon as a blocked task', () => {
    const row = html(
      createElement(FindingRow, {
        finding: {
          id: 'finding-a',
          review_id: 'review-a',
          review_revision: 1,
          severity: 'blocker',
          text: 'drops the header row',
          path: null,
          line: null,
          reviewer: 'codex',
          session_id: 'session-a',
          state: 'open',
        },
        onOpenSession() {},
      }),
    );
    expect(row).toContain(octagon);
    expect(row).toMatch(/<svg class="bp-ic"/);
  });
});

describe('board headline and cards', () => {
  it("marks a lead's unread notes with a letter, keeping their count in the label", () => {
    const states = html(createElement(LeadStates, { leads: [lead(2)], onOpenSession() {} }));
    expect(states).toContain('lucide-mail');
    expect(states).not.toContain('lucide-inbox');
    expect(states).toContain('2 条未读');
  });

  it("draws the state of a lead's line with the session state glyph, not a dot", () => {
    const panel = html(
      createElement(LeadPanel, {
        model: board([], { leads: [lead(2)] }),
        sessions: [],
        onOpenSession() {},
        onOpenTask() {},
      }),
    );
    expect(shapes(panel)).toEqual([shapes(glyph('idle'))[0]]);
    expect(panel).not.toContain('ss-dot');
  });

  it("draws a lead's state in the board head with the session state glyph, not a dot", () => {
    const states = html(createElement(LeadStates, { leads: [lead(0)], onOpenSession() {} }));
    expect(shapes(states)).toEqual([shapes(glyph('idle'))[0]]);
    expect(states).not.toContain('ss-dot');
  });
});

describe('small lucide strokes on the board', () => {
  const sheet = (name: string) =>
    readFileSync(new URL(`../../apps/web/src/screens/board/${name}`, import.meta.url), 'utf8');
  const rule = (css: string, selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1];

  it.each([
    ['status.css', '.bd-bdg svg.lucide'],
    ['overview.css', '.bms-due svg'],
    ['frame.css', '.bf-inbox svg'],
  ])('draws the 12px lucide icons of %s %s at the 16px stroke', (file, selector) => {
    expect(rule(sheet(file), selector)).toMatch(/stroke-width:\s*2;/);
  });
});
