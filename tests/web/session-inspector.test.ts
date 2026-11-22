import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChangeStory, ProjectFacts, ReviewFinding, Session } from '@pantheon/domain';
import type { LandingDiff, SessionDiff, SessionGates, WorkbenchSession } from '@pantheon/protocol';
import type { SessionTurn } from '@/data/transcript';
import { zh, zhf } from './i18n-setup.js';

const mock = vi.hoisted(() => ({
  diff: null as SessionDiff | null,
  facts: null as ProjectFacts | null,
  board: {} as any,
  stories: [] as ChangeStory[],
  storyDiff: null as LandingDiff | null,
  gates: null as SessionGates | null,
}));
vi.mock('@/data/commands', async (actual) => ({
  ...(await actual<object>()),
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
vi.mock('@/screens/sessions/GateResults', async (actual) => {
  const real = await actual<typeof import('@/screens/sessions/GateResults')>();
  return { ...real, GateResults: vi.fn(real.GateResults) };
});
vi.mock('@/data/change-story', async (actual) => ({
  ...(await actual<object>()),
  useChangeStories: () => ({ read: mock.stories, error: null, reload: () => {} }),
  useChangeStoryDiff: () => ({ data: mock.storyDiff, error: null, reload: () => {} }),
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: mock.diff, error: null, reload: () => {} }),
}));
vi.mock('@/data/session-panel', async (actual) => ({
  ...(await actual<object>()),
  useSessionGates: () => ({ data: mock.gates, error: null, reload: () => {} }),
  useSessionReviews: () => ({ data: [], error: null, reload: () => {} }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({
    read: { facts: mock.facts, collected_at: 1, workstreams: [] },
    error: null,
    loading: false,
    unavailable: false,
    reload: () => {},
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload: () => {} }),
}));

import { runCommand } from '@/data/commands';
import { withFeedback } from '@/data/feedback';
import { t } from '@/i18n';
import { GateResults } from '@/screens/sessions/GateResults';
import {
  findingOpen,
  panelOf,
  type Panel,
  type PanelTab,
} from '@/screens/sessions/inspector-model';
import { checkItem } from '@/screens/sessions/model';
import { ChecksTab, PlanTab } from '@/screens/sessions/panel';
import { SessionInspector, SessionsScreen } from '@/screens/sessions/SessionsScreen';
import { showThreadTurns } from '@/screens/sessions/trace';

const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id: 'a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: 'claude-opus-4',
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: { files: 1, additions: 2, deletions: 1 },
  merge: null,
  ...extra,
});

const session: Session = {
  id: 'a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
  workspace_id: 'workspace-a',
};

const turn: SessionTurn = {
  id: 'turn-1',
  revision: 1,
  project_id: 'project-a',
  session_id: 'a',
  input: 'Write the release notes',
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
};

const inspector = (tab: Exclude<PanelTab, 'run'>, row = listed()) =>
  renderToStaticMarkup(
    createElement(SessionInspector, {
      sessionId: 'a',
      listed: row,
      session,
      panels: [panelOf(tab)!.panel],
      view: panelOf(tab)!.view ?? 'diff',
      onOpen: () => {},
      onClose: () => {},
      onView: () => {},
    }),
  );

const tab = {
  changes: zh('sessions.screen.tabChanges'),
  checks: zh('sessions.screen.tabChecks'),
  plan: zh('sessions.panel.dock.plan'),
  trace: zh('sessions.panel.dock.trace'),
};
const closeChanges = t(
  { id: 'sessions.screen.closePanel', defaultMessage: 'Close {panel}' },
  { panel: tab.changes },
);
const explain = zh('sessions.panel.dock.explain');
const reviewLabel = zh('sessions.panel.dock.review');
const sessionActions = zh('sessions.screen.sessionActions');
const generate = zh('sessions.panel.story.generate');
const fix = zh('sessions.gateResults.fix');
const commandPassed = zh('sessions.panel.story.commandPassed');

const ALL: Panel[] = ['changes', 'checks', 'plan'];
const many = (panels: Panel[], row = listed(), sheet = false) =>
  renderToStaticMarkup(
    createElement(SessionInspector, {
      sessionId: 'a',
      listed: row,
      session,
      panels,
      sheet,
      onOpen: () => {},
      onClose: () => {},
      onView: () => {},
    }),
  );
const columns = (html: string) =>
  [...html.matchAll(/<section[^>]*aria-label="([^"]+)"/g)].map(([, label]) => label);
/** What comes before the first column: the sheet's own head, if any. */
const head = (html: string) => html.slice(0, html.indexOf('<section'));
const column = (html: string, label: string) =>
  new RegExp(`<section[^>]*aria-label="${label}"[\\s\\S]*?</section>`).exec(html)![0];

beforeEach(() => {
  mock.gates = null;
  vi.mocked(GateResults).mockClear();
  vi.mocked(runCommand).mockClear();
  mock.stories = [];
  mock.storyDiff = null;
  mock.diff = {
    session_id: 'a',
    base_sha: '0123456789abcdef',
    head_sha: 'fedcba9876543210',
    files: [{ path: 'notes.md', additions: 2, deletions: 1, untracked: false }],
    patch: null,
    truncated: true,
  };
  mock.facts = {
    collected_at: 1,
    folders: [
      { root: '/repo', git: true, branch: 'main' } as unknown as ProjectFacts['folders'][number],
    ],
  };
  mock.board = {
    board: {
      cursor: 1,
      sessions: [session],
      session_turns: [turn],
      projects: [{ id: 'project-a', roots: ['/repo'] }],
      workspaces: [
        {
          id: 'workspace-a',
          source: '/repo',
          path: '/work/worktrees/a',
          base_sha: '0123456789abcdef',
        },
      ],
    },
    events: [],
    status: { state: 'live' },
  };
});
afterEach(() => {
  showThreadTurns(null);
  vi.unstubAllGlobals();
});

describe('session panel columns', () => {
  it('lays the columns out in the order they were opened, with no tabs', () => {
    expect(columns(many(['plan', 'changes']))).toEqual([tab.plan, tab.changes]);
    expect(columns(many(ALL))).toEqual([tab.changes, tab.checks, tab.plan]);
    expect(many(ALL)).not.toContain('role="tab');
  });

  it('gives a baseline session only the plan column', () => {
    const html = many(ALL, listed({ workspace_id: null, state: 'done' }));
    expect(columns(html)).toEqual([tab.plan]);
    expect(html).not.toContain('合并');
  });

  it('heads the panels with the session title only as a sheet, and each column with a close button', () => {
    const html = inspector('changes');
    expect(head(html)).not.toContain('Release notes');
    expect(column(html, tab.changes)).toContain(`aria-label="${closeChanges}"`);

    const sheetHtml = many(['changes'], listed(), true);
    expect(head(sheetHtml)).toContain('Release notes');
    expect(column(sheetHtml, tab.changes)).toContain(`aria-label="${closeChanges}"`);
  });

  it('carries the open and session menus of the covered thread header only as a sheet', () => {
    const docked = head(inspector('changes'));
    const open = zh('sessions.screen.open');
    expect(docked).not.toContain(`aria-label="${sessionActions}"`);
    expect(docked).not.toContain(`>${open}<`);
    const sheet = head(many(['changes'], listed(), true));
    expect(sheet).toContain(`>${open}<svg`);
    expect(sheet).toContain(`aria-label="${sessionActions}"`);
  });

  it('counts the files in the head and in the summary row against the source branch, with the merge button at its foot', () => {
    const html = inspector('changes');
    const colHead = new RegExp(`<div class="ss-colh">[\\s\\S]*?${closeChanges}`).exec(html)![0];
    expect(colHead).toMatch(/class="ss-coln" role="img" aria-label="文件 1">1</);
    expect(html).not.toContain('class="ss-sum"');
    const summary = /<div class="ss-chd">[\s\S]*?<\/div>/.exec(html)![0];
    expect(summary).toContain('1 个文件，相对 main');
    expect(summary).toMatch(/>\+2<\/span> <span[^>]*>−1</);
    expect(html).toMatch(/class="ss-pf"[\s\S]*>合并到 main…<\/button>/);
    expect(html).not.toContain('>丢弃<');
  });

  it('switches the changes column to its change story from the head and to its review from the summary row', () => {
    const button = (pressed: boolean, label: string) =>
      new RegExp(`<button[^>]*aria-pressed="${pressed}"[^>]*>${label}</button>`);
    const diff = inspector('changes');
    expect(diff).toMatch(button(false, `.*?${explain}`));
    expect(diff).toMatch(button(false, reviewLabel));
    const story = inspector('story');
    expect(columns(story)).toEqual([tab.changes]);
    expect(story).toMatch(button(true, `.*?${explain}`));
    expect(story).toContain(generate);
    const review = inspector('review');
    expect(columns(review)).toEqual([tab.changes]);
    expect(review).toMatch(button(true, reviewLabel));
    expect(review).toContain('请 Codex 审查');
    expect(review).not.toContain('class="ss-diff"');
  });
});

describe('plan column', () => {
  it('counts the steps done over a meter and marks each step done, current or not started', () => {
    const html = renderToStaticMarkup(
      createElement(PlanTab, {
        steps: [
          { status: 'completed', title: 'Read the notes' },
          { status: 'in_progress', title: 'Write the notes' },
          { status: 'pending', title: 'Check the notes' },
        ],
        waiting: true,
      }),
    );
    expect(html).toMatch(/class="ss-meter"[^>]*><i style="transform:scaleX\(0\.333/);
    expect(html).toContain('<span class="ss-ptn">1 / 3</span>');
    expect(
      [
        ...html.matchAll(
          /data-step="(\w+)"(?: data-wait="true")? role="img" aria-label="([^"]+)"/g,
        ),
      ].map(([, step, label]) => `${step} ${label}`),
    ).toEqual([
      `completed ${zh('sessions.panel.dock.stepDone')}`,
      `in_progress ${zh('sessions.panel.dock.stepNow')}`,
      `pending ${zh('sessions.panel.dock.stepLater')}`,
    ]);
    expect(html).toContain('data-step="in_progress" data-wait="true"');
  });

  it('says there is no plan yet without a todo list', () => {
    expect(many(['plan'])).toContain(zh('sessions.panel.dock.noPlan'));
  });

  it("reads the main agent's newest todo list of the thread on screen", () => {
    showThreadTurns({
      sessionId: 'a',
      turns: [
        {
          turn: { id: 'turn-1' },
          started_at: null,
          items: [
            {
              kind: 'tool',
              id: 'call-1',
              name: 'TodoWrite',
              input: { todos: [{ status: 'in_progress', content: 'Write the notes' }] },
            },
          ],
        },
      ] as any,
    });
    const html = column(many(['plan']), tab.plan);
    expect(html).toContain('Write the notes');
    expect(html).toContain('0 / 1');
  });
});

describe('trace column', () => {
  it("draws the waterfall of the thread's turns and names the running turn as running", () => {
    const now = Date.now();
    showThreadTurns({
      sessionId: 'a',
      turns: [
        {
          turn: { id: 'turn-1', state: 'completed' },
          items: [],
          at: now - 120_000,
          started_at: now - 120_000,
          ended_at: now - 90_000,
        },
        {
          turn: { id: 'turn-2', state: 'running' },
          items: [],
          at: now - 60_000,
          started_at: now - 60_000,
          ended_at: null,
        },
      ] as any,
    });
    const html = column(many(['trace']), tab.trace);
    expect(html).toMatch(/role="group" aria-label="Trace 瀑布/);
    const turnLabel = (n: number) =>
      new RegExp(`aria-label="${zhf('sessions.run.waterfall.turn', { n })}[^"]*"`).exec(html)?.[0];
    expect(turnLabel(2)).toContain(zh('sessions.run.tone.run'));
    expect(turnLabel(1)).toContain(zh('sessions.run.tone.ok'));
    expect(turnLabel(1)).not.toContain(zh('sessions.run.tone.run'));
  });
});

describe('checks column', () => {
  const gatesData = (): SessionGates => ({
    configured: true,
    running: false,
    last: {
      commit: 'abcdef1234567',
      checked_at: 5000,
      results: [
        { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
        { name: 'Unit tests', exit_code: 1, timed_out: false, output_tail: 'boom' },
      ],
    },
  });
  const run = {
    run_id: 'run-1',
    commit: 'abcdef1234567',
    started_at: new Date(1000).toISOString(),
    finished_at: new Date(5000).toISOString(),
    results: [
      { name: 'Lint', command: ['lint'], duration_ms: 1200 },
      { name: 'Unit tests', command: ['test'], exit_code: 1, duration_ms: 2800 },
    ],
  };
  const checksTab = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(ChecksTab, {
        gates: { data: gatesData(), error: null, reload: () => {} },
        history: { data: { runs: [run] }, error: null, reload: () => {} } as any,
        readOnly: true,
        projectId: null,
        merging: false,
        busy: false,
        attached: new Set<string>(),
        onAttach: () => {},
        onRun: () => {},
        onSettings: () => {},
        ...extra,
      }),
    );
  const gateProps = () => vi.mocked(GateResults).mock.calls.at(-1)![0];

  it('heads the results with a bar and the passed count, then hands the newest result and its run to the gate results', () => {
    const attached = new Set<string>(['check-x']);
    const onAttach = vi.fn();
    const html = checksTab({ attached, onAttach, busy: true });
    expect(html).toMatch(
      /class="ss-pseg"[^>]*><i data-tone="ok"[^>]*><\/i><i data-tone="bad"[^>]*><\/i><\/span><span class="ss-ptn">1 \/ 2 通过</,
    );
    expect(html).toContain('class="gres"');
    expect(html).not.toContain('class="ss-checks"');
    expect(gateProps()).toMatchObject({
      last: gatesData().last,
      run,
      running: false,
      readOnly: true,
      busy: true,
      attached,
      onAttach,
    });
  });

  it('offers no fix to the agent while the session is read-only or merging', () => {
    const onFix = vi.fn();
    expect(checksTab({ readOnly: false, onFix })).toContain(fix);
    expect(checksTab({ readOnly: true, onFix })).not.toContain(fix);
    expect(gateProps().onFix).toBeUndefined();
    expect(checksTab({ readOnly: false, merging: true, onFix })).not.toContain(fix);
    expect(gateProps().onFix).toBeUndefined();
  });

  it('sends the output of the failed checks to the session when asked to fix them', () => {
    mock.gates = gatesData();
    many(['checks']);
    const props = gateProps();
    expect(props.readOnly).toBe(false);
    const items = [checkItem(gatesData().last!.results[1]!, 5000, 1)];
    props.onFix!(items);
    expect(vi.mocked(runCommand).mock.calls).toEqual([
      ['session.send', { session_id: 'a', input: withFeedback('', items) }, 2],
    ]);
  });

  it('draws the bar as one running stretch while the checks run again', () => {
    const html = checksTab({
      gates: { data: { ...gatesData(), running: true }, error: null, reload: () => {} },
      history: undefined,
    });
    expect(html).toMatch(/class="ss-pseg"[^>]*><i data-tone="run"[^>]*><\/i><\/span>/);
  });
});

describe('panel look', () => {
  const css = (name: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../apps/web/src/screens/sessions/${name}`, import.meta.url)),
      'utf8',
    );

  it('slides each column in from 16px to its right as it fades in', () => {
    expect(css('panel.css')).toMatch(
      /\.ss-col \{[^}]*transition:\s*opacity var\(--dur-4\)[^,]*,\s*transform var\(--dur-4\)[^}]*\}\s*@starting-style \{\s*\.ss-col \{\s*opacity: 0;\s*transform: translateX\(16px\);/,
    );
  });

  it('leaves the timeline’s width right of the thread and the composer too, so both centre', () => {
    const sheet = css('thread.css');
    const declared = (selector: string, property: string) =>
      new RegExp(
        `${selector.replace(/[.[\]()>+]/g, '\\$&')} \\{[^}]*?(?<![\\w-])${property}: ([^;]+);`,
      ).exec(sheet)?.[1];
    for (const rail of ['.ss-tl', '.ss-tl[data-slim]']) {
      const width = declared(rail, 'width');
      expect(width).toBeTruthy();
      expect(declared(`.ss-flow:has(> ${rail}) > .ss-scroll`, 'padding-right')).toBe(width);
      expect(declared(`.ss-flow:has(> ${rail}) + .cp-dock`, 'padding-left')).toBe(width);
      expect(declared(`.ss-flow:has(> ${rail}) + .cp-dock`, 'padding-right')).toBe(width);
    }
  });

  it('narrows the timeline to a 40px strip while panels are open', () => {
    expect(css('thread.css')).toMatch(/\.ss-tl\[data-slim\] \{\s*width: 40px;/);
    expect(css('thread.css')).toMatch(
      /\.ss-flow:has\(> \.ss-tl\[data-slim\]\) \+ \.cp-dock \{\s*padding-left: 40px;/,
    );
  });
});

describe('story tab', () => {
  const ready = (to_sha: string): ChangeStory => ({
    id: 'story-a',
    revision: 1,
    project_id: 'project-a',
    workbench_session_id: 'a',
    source: '/repo',
    from_sha: '0123456789abcdef',
    to_sha,
    state: 'ready',
    created_at: 1,
    result: {
      overall: { before: ['wrong answer'], after: ['right answer'] },
      cards: [],
      noise: [],
      uninterpreted: [],
      hunk_total: 0,
      unmatched_acceptance: [],
    },
  });

  it.each([
    [
      'shows a ready interpretation of the current head without offering another',
      'fedcba9876543210',
      false,
    ],
    [
      'keeps an interpretation of an older head and offers one of the current head',
      '1111111111111111',
      true,
    ],
  ])('%s', (_name, head, offered) => {
    mock.stories = [ready(head)];
    const html = inspector('story');
    expect(html).toContain('right answer');
    expect(html.includes(generate)).toBe(offered);
  });

  it('shows real acceptance mapping, command evidence and impact from the frozen story diff', () => {
    const story = ready('fedcba9876543210');
    story.context = {
      goal: 'Verify notes',
      acceptance: ['node tests/notes.cjs'],
      contract_available: true,
      checks: {
        state: 'recorded',
        spec_hash: 'notes-checks',
        commit: story.to_sha,
        commands: [{ name: 'Verify notes', argv: ['node', 'tests/notes.cjs'] }],
        results: [
          {
            name: 'Verify notes',
            argv: ['node', 'tests/notes.cjs'],
            exit_code: 0,
            timed_out: false,
            duration_ms: 1,
            output: 'PASS tests/notes.cjs',
          },
        ],
      },
    };
    story.result!.hunk_total = 1;
    story.result!.cards = [
      {
        title: 'Notes',
        kind: 'added',
        surface: 'data',
        before: 'no notes',
        after: 'notes',
        acceptance: [0],
        hunks: ['H1'],
        tests: [],
        how: [],
        out_of_scope: false,
        evidence: [],
        shared_with: [],
      },
    ];
    mock.stories = [story];
    mock.storyDiff = {
      source: '/repo',
      from_sha: story.from_sha,
      to_sha: story.to_sha,
      files: [{ path: 'notes.md', status: 'added', additions: 1, deletions: 0 }],
      hunks: [
        {
          id: 'H1',
          file: 'notes.md',
          header: '@@ -0,0 +1 @@',
          old_start: 0,
          old_lines: 0,
          new_start: 1,
          new_lines: 1,
          text: '+notes',
        },
      ],
      truncated: false,
    };
    const html = inspector('story');
    expect(html).toContain('验收对应 1/1');
    expect(html).toContain('node tests/notes.cjs');
    expect(html).toContain('PASS tests/notes.cjs');
    expect(html).toContain(commandPassed);
    expect(html).toContain(zh('sessions.panel.story.reach'));
    expect(html).toContain('卡 1：1 行');
  });

  it('offers regeneration when only command evidence is outdated and marks stale results unverified', () => {
    const story = { ...ready('fedcba9876543210'), outdated: true };
    story.context = {
      goal: 'Notes',
      acceptance: [],
      contract_available: true,
      checks: {
        state: 'stale',
        spec_hash: 'changed',
        commands: [{ name: 'Verify notes', argv: ['node', 'tests/notes.cjs'] }],
        results: [
          {
            name: 'Verify notes',
            argv: ['node', 'tests/notes.cjs'],
            exit_code: 0,
            timed_out: false,
            duration_ms: 1,
            output: 'PASS tests/notes.cjs',
          },
        ],
      },
    };
    mock.stories = [story];
    const html = inspector('story');
    expect(html).toContain(zh('sessions.panel.story.checksStale'));
    expect(html).toContain(zh('sessions.panel.story.unverified'));
    expect(html).toContain(generate);
    expect(html).not.toContain(commandPassed);
  });
});

it('shows the turns of the session in the thread', () => {
  vi.stubGlobal('window', { innerWidth: 1400 });
  const html = renderToStaticMarkup(
    createElement(SessionsScreen, {
      projectId: 'project-a',
      needs: { items: [], loading: false, error: null, reload() {} } as any,
      list: { data: [listed()], loading: false, error: null, reload() {} } as any,
    }),
  );
  expect(html).toContain('Write the release notes');
});

it('opens the diff of the changes panel for a link to a file', () => {
  expect(panelOf('diff')).toEqual({ panel: 'changes', view: 'diff' });
});

it('leaves a stale finding without a resolution open to resolve', () => {
  const finding = { status: 'stale' } as ReviewFinding;
  expect(findingOpen(finding)).toBe(true);
  expect(
    findingOpen({
      ...finding,
      resolution: { outcome: 'fixed', resolved_at: 1, resolved_by: 'user' },
    }),
  ).toBe(false);
});
