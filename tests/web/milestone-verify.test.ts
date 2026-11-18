import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { t } from '@/i18n';
import { durationText } from '@/lib/time-text';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'card-id' }),
);
import { RuntimeGlyph, runtimeName } from '@/components/RuntimeGlyph';
import { MilestoneCard } from '@/screens/board/MilestoneCard';
import type { BoardMilestone, SnapshotMilestone } from '@/screens/board/panels-model';

type Verification = NonNullable<BoardMilestone['verification']>;

const NOW = Date.UTC(2026, 10, 1, 12);
const say = (id: string, values: Record<string, string | number>) =>
  t({ id, defaultMessage: '' }, values);

const milestone = (verification?: Partial<Verification>): BoardMilestone => ({
  id: 'ms-cur',
  title: 'importer ready',
  session_ids: [],
  merged: 0,
  status: 'ready_for_acceptance',
  criteria: [{ text: 'Imports a CSV', accepted: false }],
  owner_session_id: 'lead-1',
  tasks: { done: 2, total: 2 },
  ...(verification && {
    verification: {
      id: 'verify-1',
      state: 'running',
      started_at: NOW - 3 * 60_000,
      failed: [],
      commands: [],
      ...verification,
    },
  }),
});
const stored = {
  id: 'ms-cur',
  revision: 2,
  project_id: 'project-a',
  title: 'importer ready',
  required_sessions: [],
  criteria: ['Imports a CSV'],
  created_at: NOW,
  updated_by: 'lead-1',
  owner_session_id: 'lead-1',
} as unknown as SnapshotMilestone;
const board = (ms: BoardMilestone) =>
  ({ now: NOW, tasks: [], merges: [], milestones: [ms] }) as unknown as BoardModel;
const card = (ms: BoardMilestone) =>
  new HookHost(() =>
    MilestoneCard({
      model: board(ms),
      milestone: ms,
      actions: {
        projectId: 'project-a',
        milestones: [stored],
        sessions: [],
        run: async () => null,
      },
      onOpenTask: () => {},
    }),
  ).render();

const children = (n: ReactElement<any>): ReactElement<any>[] =>
  [n.props.children]
    .flat(Infinity)
    .filter((c): c is ReactElement<any> => !!c && typeof c === 'object' && 'props' in c);
/** The parts of the card's line beside its title. */
const line = (out: ReactElement) =>
  children(find(out, (n) => children(n).some((c) => c.type === 'h2'))).filter(
    (n) => n.type !== 'h2',
  );
const badgeTexts = () => [
  say('board.verify.badge.running', { elapsed: durationText(3 * 60_000) }),
  zh('board.verify.badge.passed'),
  zh('board.verify.badge.failed'),
  zh('board.verify.badge.inconclusive'),
];
const verdict = (out: ReactElement) =>
  nodes(out).find(
    (n) => n.props['aria-label'] === say('board.verify.card.label', { title: 'importer ready' }),
  );

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('verification badge on the milestone card', () => {
  it.each([
    [
      'pending',
      (): string | null => say('board.verify.badge.running', { elapsed: durationText(3 * 60_000) }),
    ],
    [
      'running',
      (): string | null => say('board.verify.badge.running', { elapsed: durationText(3 * 60_000) }),
    ],
    ['passed', (): string | null => zh('board.verify.badge.passed')],
    ['failed', (): string | null => zh('board.verify.badge.failed')],
    ['inconclusive', (): string | null => zh('board.verify.badge.inconclusive')],
    ['skipped', (): string | null => null],
    ['absent', (): string | null => null],
  ] as const)('a %s verification shows its badge by name', (state, words) => {
    const out = card(
      milestone(
        state === 'absent'
          ? undefined
          : { state, runtime: 'codex', finished_at: NOW - 60_000, independence: 'other_vendor' },
      ),
    );
    const shown = line(out).filter((n) => badgeTexts().includes(text(n)));
    const expected = words();
    expect(shown.map(text)).toEqual(expected === null ? [] : [expected]);
  });

  it('names the runtime of the verifier after Verified', () => {
    const out = card(milestone({ state: 'passed', runtime: 'codex', finished_at: NOW }));
    const badge = line(out).find((n) => text(n) === zh('board.verify.badge.passed'))!;
    const icon = find(badge, (n) => n.props.role === 'img');
    expect(icon.props['aria-label']).toBe(runtimeName('codex'));
  });
});

describe('verdict of a milestone verification', () => {
  it.each(['pending', 'running', 'skipped'] as const)('has no verdict while %s', (state) => {
    expect(verdict(card(milestone({ state })))).toBeUndefined();
  });

  it('opens a failed verification with each command, the output of the failed one, and keeps Accept on', () => {
    const out = card(
      milestone({
        state: 'failed',
        finished_at: NOW - 34 * 60_000,
        commands: [
          { name: 'pnpm lint', exit_code: 0 },
          { name: 'pnpm test', exit_code: 1 },
        ],
        failed: [{ name: 'pnpm test', output_tail: 'FAIL importer.test.ts\nexpected 2 rows' }],
      }),
    );
    const shown = verdict(out)!;
    expect(shown.props.defaultOpen).toBe(true);
    expect(text(shown)).toContain(say('board.verify.card.checksFailed', { count: 1 }));
    const rows = nodes(shown).filter((n) => n.type === 'li');
    expect(text(rows[0]!)).toBe('pnpm lint');
    expect(text(rows[1]!).startsWith('pnpm test')).toBe(true);
    expect(rows.map((row) => find(row, (n) => n.props.role === 'img').props['aria-label'])).toEqual(
      [zh('board.verify.check.passed'), zh('board.verify.check.failed')],
    );
    expect(text(find(rows[1]!, (n) => n.type === 'pre'))).toBe(
      'FAIL importer.test.ts\nexpected 2 rows',
    );
    expect(nodes(rows[0]!).some((n) => n.type === 'pre')).toBe(false);
    expect(nodes(shown).some((n) => n.type === RuntimeGlyph)).toBe(false);
    const accept = find(
      out,
      (n) =>
        n.type === 'button' &&
        n.props['aria-label'] ===
          say('board.plan.milestone.acceptLabel', { title: 'importer ready' }),
    );
    expect(accept.props.disabled).toBe(false);
  });

  it('keeps a passed verification closed and names the verifier and how far it stands from the writers', () => {
    const shown = verdict(
      card(
        milestone({
          state: 'passed',
          runtime: 'codex',
          independence: 'other_vendor',
          finished_at: NOW,
        }),
      ),
    )!;
    expect(shown.props.defaultOpen).toBe(false);
    expect(text(shown)).toContain(runtimeName('codex'));
    expect(text(shown)).toContain(zh('board.verify.independence.otherVendor'));
  });

  it("warns when the verifier ran on the writers' own runtime", () => {
    const shown = verdict(
      card(
        milestone({
          state: 'passed',
          runtime: 'claude',
          independence: 'same_runtime',
          finished_at: NOW,
        }),
      ),
    )!;
    expect(text(shown)).toContain(zh('board.verify.independence.sameRuntime'));
    expect(text(shown)).not.toContain(zh('board.verify.independence.otherVendor'));
  });

  it("gives the verifier's own words when it failed the milestone", () => {
    const shown = verdict(
      card(
        milestone({
          state: 'failed',
          runtime: 'codex',
          independence: 'other_vendor',
          reason: 'The export drops the header row.',
          finished_at: NOW,
          commands: [{ name: 'pnpm test', exit_code: 0 }],
        }),
      ),
    )!;
    expect(text(shown)).toContain(zh('board.verify.card.verifierFailed'));
    expect(text(shown)).toContain('The export drops the header row.');
  });

  it('words a known reason and leaves an unknown one out', () => {
    const restarted = verdict(
      card(milestone({ state: 'inconclusive', reason: 'daemon_restart', finished_at: NOW })),
    )!;
    expect(text(restarted)).toContain(zh('board.verify.badge.inconclusive'));
    expect(text(restarted)).toContain(zh('board.verify.reason.daemonRestart'));
    expect(text(restarted)).not.toContain('daemon_restart');
    const unknown = verdict(
      card(milestone({ state: 'inconclusive', reason: 'spawn git ENOENT', finished_at: NOW })),
    )!;
    expect(text(unknown)).not.toContain('ENOENT');
  });
});
