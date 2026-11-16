import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionGateRun, SessionGates } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { t } from '@/i18n';
import { GateResults, type GateResultsProps } from '@/screens/sessions/GateResults';
import { failedTests } from '@/screens/sessions/inspector-model';

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const CHECKED = Date.UTC(2026, 10, 3, 12);
const last: NonNullable<SessionGates['last']> = {
  commit: 'c30123456789abcdef',
  checked_at: CHECKED,
  results: [
    { name: 'lint', exit_code: 0, timed_out: false, output_tail: 'clean' },
    {
      name: 'unit',
      exit_code: 1,
      timed_out: false,
      output_tail: [
        ' ✓ refund/state.test.ts (41)',
        ' ✗ reconcile/diff.test.ts (12)',
        '   AssertionError: expected [] to deeply equal [ 1 ]',
        '     at reconcile/diff.test.ts:88:24',
        '     88 |   expect(rows).toEqual([1])',
        ' Tests  1 failed | 40 passed (41)',
      ].join('\n'),
    },
    { name: 'types', exit_code: 0, timed_out: false, output_tail: '' },
    { name: 'e2e', exit_code: null, timed_out: true, output_tail: 'still waiting' },
  ],
};
const run: SessionGateRun = {
  run_id: 'run-1',
  commit: last.commit,
  started_at: new Date(CHECKED - 40_000).toISOString(),
  finished_at: new Date(CHECKED).toISOString(),
  results: [
    { name: 'lint', command: ['pnpm', 'lint'], exit_code: 0, duration_ms: 1000 },
    { name: 'unit', command: ['pnpm', 'test'], exit_code: 1, duration_ms: 4000 },
    { name: 'types', command: ['pnpm', 'tsc'], exit_code: 0, duration_ms: 2000 },
    { name: 'e2e', command: ['pnpm', 'e2e'], timed_out: true, duration_ms: 4000 },
    { name: 'review', command: ['pnpm', 'review'], skipped: true },
  ],
};

function results(patch: Partial<GateResultsProps> = {}) {
  return mount(() => GateResults({ last, run, running: false, readOnly: false, ...patch }));
}
const groups = (tree: unknown) =>
  nodes(tree as never)
    .filter((n) => n.type === 'section')
    .map((s) => [
      text(find(s, (n) => n.props.className === 'gres-h')),
      nodes(s)
        .filter((n) => n.props.className === 'gres-nm mono')
        .map((n) => text(n)),
    ]);
const row = (tree: unknown, name: string) =>
  find(
    tree as never,
    (n) =>
      n.type === 'button' &&
      n.props.className === 'gres-row' &&
      nodes(n.props.children).some((c) => c.props.title === name),
  );
const openLog = (tab: HookHost<any>) => {
  const el = named(tab.value, 'Log');
  return mount(() => (el.type as (p: unknown) => ReactNode)(el.props));
};
const button = (tree: unknown, label: string) =>
  find(
    tree as never,
    (n) => n.type === 'button' && (n.props['aria-label'] === label || text(n) === label),
  );

describe('gate results', () => {
  it('lists failed commands first, then passed, then those not run, each group counted', () => {
    expect(groups(results().value)).toEqual([
      [`${zh('sessions.gateResults.group.failed')}2`, ['unit', 'e2e']],
      [`${zh('sessions.gateResults.group.passed')}2`, ['lint', 'types']],
      [`${zh('sessions.gateResults.group.notRun')}1`, ['review']],
    ]);
  });

  it('names the glyph of a command not run as not run, apart from a skipped one', () => {
    const tree = results().value;
    const glyphs = (label: string) =>
      nodes(find(tree, (n) => n.type === 'section' && n.props['aria-label'] === label))
        .filter((n) => n.props.role === 'img')
        .map((n) => n.props['aria-label']);
    expect(glyphs(zh('sessions.gateResults.group.notRun'))).toEqual([
      zh('sessions.gateResults.group.notRun'),
    ]);
  });

  it('shows the log without terminal colour codes', () => {
    const coloured = {
      ...last,
      results: [
        {
          name: 'unit',
          exit_code: 1,
          timed_out: false,
          output_tail:
            '\x1b[1m\x1b[30m\x1b[46m RUN \x1b[49m\x1b[39m \x1b[36mv5.0.5\x1b[39m\nTests  1 failed',
        },
      ],
    };
    const tab = results({ last: coloured, run: undefined });
    row(tab.value, 'unit').props.onClick();
    tab.render();
    const log = find(
      openLog(tab).value,
      (n) =>
        n.props['aria-label'] ===
        t({ id: 'sessions.gateResults.log', defaultMessage: '' }, { name: 'unit' }),
    );
    expect(text(log)).toBe(' RUN  v5.0.5\nTests  1 failed');
  });

  it('lists the commands skipped after failing apart, with why, neither passed nor failed', () => {
    const skipped: NonNullable<SessionGates['last']> = {
      ...last,
      results: [
        last.results[0]!,
        {
          name: 'audit',
          exit_code: 1,
          timed_out: false,
          state: 'skipped',
          reason: 'npm audit\n3 high severity vulnerabilities\n',
          output_tail: '3 high severity vulnerabilities',
        },
        {
          name: 'docs',
          exit_code: null,
          timed_out: false,
          state: 'skipped',
          reason: 'cannot_start',
          output_tail: '',
        },
      ],
    };
    const tree = results({ last: skipped, run: undefined, onFix: vi.fn() }).value;
    expect(groups(tree)).toEqual([
      [`${zh('sessions.gateResults.group.passed')}1`, ['lint']],
      [`${zh('sessions.gateResults.group.skipped')}2`, ['audit', 'docs']],
    ]);
    const why = (name: string) =>
      text(find(row(tree, name), (n) => n.props.className === 'gres-rs'));
    expect(why('audit')).toBe('3 high severity vulnerabilities');
    expect(why('docs')).toBe(zh('sessions.gateResults.skip.cannotStart'));
    expect(() => button(tree, zh('sessions.gateResults.fix'))).toThrow();
  });

  it('draws each duration against the longest and leaves a command not run without one', () => {
    const tree = results().value;
    const widths = nodes(tree)
      .filter((n) => n.props.className === 'meter')
      .map((n) => n.props.style['--v']);
    expect(widths).toEqual(['100%', '100%', '25%', '50%', '0%']);
    const times = nodes(tree)
      .filter((n) => n.props.className === 'gres-t mono')
      .map((n) => text(n));
    expect(times).toEqual(['4.0 秒', '4.0 秒', '1.0 秒', '2.0 秒', '']);
    expect(nodes(tree).some((n) => n.type === 'button' && text(n).includes('review'))).toBe(false);
  });

  it('counts the tests of a step between its name and its meter, and leaves the cell out without counts', () => {
    const counted = {
      ...last,
      results: last.results.map((r) =>
        r.name === 'unit'
          ? { ...r, tests: { passed: 40, failed: 1, skipped: 2 } }
          : r.name === 'lint'
            ? { ...r, tests: { passed: 12, failed: 0, skipped: 0 } }
            : r,
      ),
    };
    const tree = results({ last: counted }).value;
    const cells = (name: string): ReactElement<any>[] =>
      [row(tree, name).props.children.props.children].flat().filter(Boolean);
    expect(cells('unit').map((n) => n.props.className)).toEqual([
      'gres-st',
      'gres-nm mono',
      'gres-tc',
      'meter',
      'gres-t mono',
    ]);
    const counts = (name: string) =>
      nodes(find(row(tree, name), (n) => n.props.className === 'gres-tc').props.children).map(
        (n) => [text(n), n.props.className],
      );
    expect(counts('unit')).toEqual([
      [t({ id: 'sessions.gateResults.testsFailed', defaultMessage: '' }, { count: 1 }), 'gres-tf'],
      [t({ id: 'sessions.gateResults.testsPassed', defaultMessage: '' }, { count: 40 }), undefined],
      [t({ id: 'sessions.gateResults.testsSkipped', defaultMessage: '' }, { count: 2 }), undefined],
    ]);
    expect(counts('lint')).toEqual([
      [t({ id: 'sessions.gateResults.testsPassed', defaultMessage: '' }, { count: 12 }), undefined],
    ]);
    expect(cells('types').map((n) => n.props.className)).toEqual([
      'gres-st',
      'gres-nm mono',
      'meter',
      'gres-t mono',
    ]);
  });

  it('marks a step carried over from the last run, with no time of its own', () => {
    const carried = {
      ...last,
      results: last.results.map((r) => (r.name === 'lint' ? { ...r, carried: true } : r)),
    };
    const tree = results({ last: carried }).value;
    const lint = row(tree, 'lint');
    expect(text(find(lint, (n) => n.props.className === 'gres-cr'))).toBe(
      zh('sessions.gateResults.carried'),
    );
    expect(find(lint, (n) => n.props.className === 'meter').props.style['--v']).toBe('0%');
    expect(text(find(lint, (n) => n.props.className === 'gres-t mono'))).toBe('');
    expect(() => find(row(tree, 'types'), (n) => n.props.className === 'gres-cr')).toThrow();
  });

  it('keeps every log folded until a command is opened, then shows its command and exit code', () => {
    const tab = results();
    expect(nodes(tab.value).filter((n) => n.type === 'pre')).toEqual([]);
    expect(() => named(tab.value, 'Log')).toThrow();
    row(tab.value, 'unit').props.onClick();
    tab.render();
    expect(row(tab.value, 'unit').props['aria-expanded']).toBe(true);
    const shown = openLog(tab).value;
    expect(text(find(shown, (n) => n.props.className === 'gres-cmd mono'))).toBe('pnpm test');
    expect(text(find(shown, (n) => n.props.className === 'gres-code'))).toBe(
      t({ id: 'sessions.gateResults.exitCode', defaultMessage: '' }, { code: 1 }),
    );
    row(tab.value, 'unit').props.onClick();
    tab.render();
    expect(() => named(tab.value, 'Log')).toThrow();
  });

  it('marks the lines of the log that report the failure', () => {
    const tab = results();
    row(tab.value, 'unit').props.onClick();
    tab.render();
    const pre = find(openLog(tab).value, (n) => n.type === 'pre');
    expect(
      nodes(pre.props.children).map((n) => [n.props.className, text(n).split('\n').length]),
    ).toEqual([
      ['gres-ok', 1],
      ['gres-bad', 3],
      ['gres-ok', 2],
    ]);
  });

  it('steps between the failed commands', () => {
    const tab = results();
    row(tab.value, 'unit').props.onClick();
    tab.render();
    let shown = openLog(tab).value;
    expect(button(shown, zh('sessions.gateResults.previous')).props.disabled).toBe(true);
    button(shown, zh('sessions.gateResults.next')).props.onClick();
    tab.render();
    expect(row(tab.value, 'e2e').props['aria-expanded']).toBe(true);
    expect(row(tab.value, 'unit').props['aria-expanded']).toBe(false);
    shown = openLog(tab).value;
    expect(button(shown, zh('sessions.gateResults.next')).props.disabled).toBe(true);
    button(shown, zh('sessions.gateResults.previous')).props.onClick();
    tab.render();
    expect(row(tab.value, 'unit').props['aria-expanded']).toBe(true);
  });

  it('offers no failure stepping on a passed command', () => {
    const tab = results();
    row(tab.value, 'lint').props.onClick();
    tab.render();
    const shown = openLog(tab).value;
    expect(() => button(shown, zh('sessions.gateResults.next'))).toThrow();
    expect(() => find(shown, (n) => n.props.className === 'gres-cmd mono')).not.toThrow();
  });

  it('copies the whole log', () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const tab = results();
    row(tab.value, 'e2e').props.onClick();
    tab.render();
    button(openLog(tab).value, zh('sessions.gateResults.copy')).props.onClick();
    expect(writeText).toHaveBeenCalledWith('still waiting');
  });

  it('asks the agent to fix every failed command at once', () => {
    const onFix = vi.fn();
    button(results({ onFix }).value, zh('sessions.gateResults.fix')).props.onClick();
    expect(onFix).toHaveBeenCalledOnce();
    const items = onFix.mock.calls[0]![0] as { id: string; label: string; text: string }[];
    expect(items.map((item) => item.label)).toEqual(['unit', 'e2e']);
    expect(items[0]!.text).toContain('AssertionError');
  });

  const vitestRun = {
    ...last,
    results: [
      {
        name: 'test',
        exit_code: 1,
        timed_out: false,
        output_tail: [
          '\x1b[31m \u276f\x1b[39m tests/web/a.test.ts \x1b[2m(\x1b[22m3 tests | 1 failed\x1b[2m)\x1b[22m 20ms',
          '   \x1b[31m\u00d7\x1b[39m opens the page\x1b[33m 5ms\x1b[39m',
          '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m',
          '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/web/a.test.ts\x1b[2m > \x1b[22mopens the page',
          '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/web/c.test.ts\x1b[2m > \x1b[22mdrafts\x1b[2m > \x1b[22mkeeps the draft',
        ].join('\n'),
      },
    ],
  };

  it('lists the failed test files and tests of a vitest log above the log', () => {
    const tab = results({ last: vitestRun, run: undefined });
    row(tab.value, 'test').props.onClick();
    tab.render();
    const list = find(
      openLog(tab).value,
      (n) => n.props['aria-label'] === zh('sessions.gateResults.failedTests'),
    );
    expect(
      nodes(list)
        .filter((n) => n.type === 'li')
        .map((n) => text(n)),
    ).toEqual([
      'tests/web/a.test.tsopens the page',
      'opens the page',
      'tests/web/c.test.tsdrafts > keeps the draft',
      'drafts > keeps the draft',
    ]);
  });

  it('lists a test inside a describe block once, by its full name', () => {
    const log = [
      ' ❯ tests/web/c.test.ts (2 tests | 1 failed) 12ms',
      '   × keeps the draft 5ms',
      ' FAIL  tests/web/c.test.ts > drafts > keeps the draft',
    ].join('\n');
    expect(failedTests(log)).toEqual([
      { file: 'tests/web/c.test.ts', tests: ['drafts > keeps the draft'] },
    ]);
  });

  it('sends the agent the log without colour codes, with the failed tests listed first', () => {
    const onFix = vi.fn();
    button(
      results({ onFix, last: vitestRun, run: undefined }).value,
      zh('sessions.gateResults.fix'),
    ).props.onClick();
    const [item] = onFix.mock.calls[0]![0] as { text: string }[];
    expect(item!.text).not.toContain('\x1b');
    expect(item!.text).toContain(
      'Failed tests:\n- tests/web/a.test.ts\n  - opens the page\n- tests/web/c.test.ts\n  - drafts > keeps the draft',
    );
    expect(item!.text).toContain(' Test Files  2 failed');
  });

  it('offers no fix to an ended session, nor while all commands pass', () => {
    const onFix = vi.fn();
    expect(() =>
      button(results({ onFix, readOnly: true }).value, zh('sessions.gateResults.fix')),
    ).toThrow();
    const passing = {
      ...last,
      results: last.results.filter((r) => r.exit_code === 0),
    };
    expect(() =>
      button(results({ onFix, last: passing }).value, zh('sessions.gateResults.fix')),
    ).toThrow();
  });

  it('says the gates are running with no progress fraction while they run', () => {
    const onFix = vi.fn();
    const tree = results({ onFix, running: true }).value;
    expect(text(find(tree, (n) => n.props.role === 'status'))).toBe(
      zh('sessions.gateResults.running'),
    );
    expect(nodes(tree).some((n) => n.props.role === 'progressbar')).toBe(false);
    expect(button(tree, zh('sessions.gateResults.fix')).props.disabled).toBe(true);
  });
});
