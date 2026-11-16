import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoutingCell } from '@pantheon/protocol';

const mock = vi.hoisted(() => ({ cells: [] as unknown[] }));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useRoutingTable: () => ({ read: { cells: mock.cells }, error: null, reload() {} }),
}));

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { kindText } from '@/data/workflow-policy';
import { setLocaleSync, t } from '@/i18n';
import { RoutingPage } from '@/screens/settings/RoutingPage';
import { zhCatalog } from './i18n-setup.js';

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };
const backend: RoutingCell = {
  domain: 'backend-logic',
  tier: 't2',
  first: { runtime: 'claude', model: 'claude-opus-4-5', effort: 'high' },
  alternate: { runtime: 'codex', model: 'gpt-5.1-codex' },
  candidates: [
    { runtime: 'codex', model: 'gpt-5.1-codex', p: 0.6, n: 5, s: 3, success_rate: 0.6 },
    {
      runtime: 'claude',
      model: 'claude-opus-4-5',
      effort: 'high',
      p: 0.8,
      n: 10,
      s: 8,
      success_rate: 0.8,
    },
  ],
  prior: { source: 'swe-bench', fetched_at: '2026-11-09T09:12:00.000Z' },
};
const review: RoutingCell = {
  domain: 'review',
  tier: 't1',
  first: { runtime: 'claude', model: 'claude-sonnet-4-5' },
  candidates: [
    { runtime: 'claude', model: 'claude-sonnet-4-5', p: 0.5, n: 0, s: 0, success_rate: null },
  ],
  prior: null,
};

const render = (cells: RoutingCell[], session_defaults?: { single_model: boolean }) => {
  mock.cells = cells;
  return renderToStaticMarkup(
    createElement(RoutingPage, {
      project: {
        ...project,
        ...(session_defaults && {
          session_defaults: { runtime: 'claude', permission_mode: 'ask', ...session_defaults },
        }),
      } as never,
    }),
  );
};
/** The markup of the table row whose row header reads `kind`. */
const row = (html: string, kind: string) =>
  html.split('role="row"').find((r) => r.includes(`>${kind}</span>`)) ?? '';
const cells = (markup: string) => markup.split('role="cell"').slice(1);
const firstOf = (kind: string) =>
  t({ id: 'settings.routing.firstOf', defaultMessage: '{kind} first choice' }, { kind });

afterEach(() => {
  setLocaleSync('zh-CN', zhCatalog());
});

describe('routing table', () => {
  it('names its section and table the routing table', () => {
    setLocaleSync('en', {});
    const html = render([backend]);
    expect(html).toContain('<h3>Routing table</h3>');
    expect(html).toContain('role="table" aria-label="Routing table"');
  });

  it('shows each choice as a model chip named for its task kind and slot, shut while the project runs on one model', () => {
    const kind = kindText('backend-logic', 't2');
    const [first, alternate] = cells(row(render([backend]), kind));
    expect(first).toContain(`aria-label="${firstOf(kind)}"`);
    expect(first).not.toContain('disabled');
    expect(first).toContain('claude-opus-4-5');
    expect(alternate).toContain(
      `aria-label="${t({ id: 'settings.routing.alternateOf', defaultMessage: '{kind} alternate' }, { kind })}"`,
    );
    expect(alternate).toContain('gpt-5.1-codex');
    const single = cells(row(render([backend], { single_model: true }), kind));
    expect(single[0]).toContain(
      `<button type="button" class="chip rtt-mc" disabled="" aria-label="${firstOf(kind)}"`,
    );
  });

  it('shows a dash where a task kind has no alternate', () => {
    const [, alternate] = cells(row(render([review]), kindText('review', 't1')));
    expect(alternate).not.toContain('<button');
    expect(alternate).toContain('—');
  });

  it("gives the first choice's local runs and first-try pass rate as one value", () => {
    const html = render([backend, review]);
    const samples = cells(row(html, kindText('backend-logic', 't2')))[2]!;
    expect(samples).toContain('10 次');
    expect(samples).toContain('80%');
    expect(samples).not.toContain('5 次');
    expect(html).not.toContain('rs-smp');
    const none = cells(row(html, kindText('review', 't1')))[2]!;
    expect(none).toContain('—');
    expect(none).not.toContain('%');
  });

  it('dates the leaderboard by month and day only', () => {
    const board = cells(row(render([backend]), kindText('backend-logic', 't2')))[3]!;
    expect(board).toContain('swe-bench');
    expect(board).toMatch(/<time[^>]*dateTime="2026-11-09T09:12:00.000Z"[^>]*>11\/09<\/time>/);
  });
});
