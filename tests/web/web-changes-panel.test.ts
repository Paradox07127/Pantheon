import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectFacts, Session } from '@pantheon/domain';
import type {
  SessionDiff,
  SessionGates,
  SessionTurnDiff,
  WorkbenchSession,
} from '@pantheon/protocol';

const mock = vi.hoisted(() => ({
  diff: null as SessionDiff | null,
  turnDiff: null as SessionTurnDiff | null,
  gates: null as SessionGates | null,
  facts: null as ProjectFacts | null,
  board: {
    board: {
      cursor: 1,
      workspaces: [
        {
          id: 'workspace-a',
          source: '/repo',
          path: '/work/worktrees/a',
          base_sha: '0123456789abcdef',
        },
      ],
      sessions: [],
    },
    events: [],
    status: { state: 'live' },
  } as any,
}));
vi.mock('@/data/board', () => ({
  useBoard: (selector: any) => selector(mock.board),
}));
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useSessionDiff: () => ({ data: mock.diff, error: null, reload: () => {} }),
  useTurnDiff: (sessionId: string | null, turnId: string | null) => ({
    data: sessionId && turnId ? mock.turnDiff : null,
    error: null,
    reload: () => {},
  }),
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

import { gateSummary, lineComment, messageCommand } from '@/screens/sessions/model';
import { panelOf, type PanelTab } from '@/screens/sessions/inspector-model';
import { SessionInspector, useTurnScope } from '@/screens/sessions/SessionsScreen';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const commentOn = (path: string, line: number) =>
  `aria-label="${t({ id: 'components.diff.commentLine', defaultMessage: '' }, { path, line })}"`;
const checkStatus = (gate: string, passed: number, total: number) =>
  `aria-label="${t({ id: 'sessions.panel.merge.checkStatus', defaultMessage: '' }, { gate: zh(`sessions.panel.gate.${gate}`), passed, total })}"`;

const listed = (state: WorkbenchSession['state']): WorkbenchSession => ({
  id: 'a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of a',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: { files: 3, additions: 3, deletions: 2 },
  merge: null,
});

const open: Session = {
  id: 'a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};

const patch = [
  'diff --git a/src/answer.ts b/src/answer.ts',
  '--- a/src/answer.ts',
  '+++ b/src/answer.ts',
  '@@ -10,3 +10,3 @@ export function answer() {',
  '   const base = 40;',
  '-  return base + 1;',
  '+  return base + 2;',
  '   // done',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const one = 1;',
  '+export const two = 2;',
  'diff --git a/src/old.ts b/src/old.ts',
  'deleted file mode 100644',
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-export const gone = 0;',
].join('\n');

const diff: SessionDiff = {
  session_id: 'a',
  base_sha: 'base',
  head_sha: 'head',
  files: [
    { path: 'src/answer.ts', additions: 1, deletions: 1, untracked: false },
    { path: 'src/new.ts', additions: 2, deletions: 0, untracked: false },
    { path: 'src/old.ts', additions: 0, deletions: 1, untracked: false },
  ],
  patch,
  truncated: false,
};

const gates = (exit_code: number): SessionGates => ({
  configured: true,
  running: false,
  last: {
    commit: 'abcdef1234567890',
    checked_at: 1,
    results: [
      { name: 'Lint', exit_code: 0, timed_out: false, output_tail: '' },
      { name: 'Unit tests', exit_code, timed_out: false, output_tail: '1 failed' },
    ],
  },
});

const panel = (state: WorkbenchSession['state'], tab: Exclude<PanelTab, 'run'>) =>
  renderToStaticMarkup(
    createElement(SessionInspector, {
      sessionId: 'a',
      listed: listed(state),
      session: state === 'merged' ? { ...open, state: 'closed' } : open,
      panels: [panelOf(tab)!.panel],
      view: panelOf(tab)!.view ?? 'diff',
      onOpen: () => {},
      onClose: () => {},
      onView: () => {},
    }),
  );

beforeEach(() => {
  mock.diff = diff;
  mock.gates = gates(0);
  mock.facts = null;
  mock.board.board.sessions = [];
  mock.board.board.session_turns = [];
  mock.turnDiff = null;
  useTurnScope.setState({ scopes: {} });
});

describe('changes tab head', () => {
  it('counts the files and lines in the summary row of the changes column only, with the review switch at its end', () => {
    const html = panel('ready', 'changes');
    const head = html.slice(html.indexOf('class="ss-chd"'), html.indexOf('class="ss-diff"'));
    expect(head).toContain('<span class="ss-cn" title="文件 3">文件 3</span>');
    expect(head).toContain('+3');
    expect(head).toContain('−2');
    expect(head).toMatch(/>审阅<\/button><\/div>/);
    expect(html).not.toContain('class="ss-sum"');
    const other = panel('ready', 'checks');
    expect(other).not.toContain('class="ss-chd"');
    expect(other).not.toContain('文件 3');
  });
});

describe('changes panel files', () => {
  it('marks each file added, modified or deleted', () => {
    const html = panel('ready', 'changes');
    const letters = [...html.matchAll(/class="ss-fs (\w)"/g)].map(([, letter]) => letter);
    expect(letters).toEqual(['M', 'A', 'D']);
  });

  it('numbers the diff lines and offers a comment on each line of a live session', () => {
    const html = panel('ready', 'changes');
    expect(html).toContain(commentOn('src/answer.ts', 10));
    expect(html).toContain(commentOn('src/answer.ts', 11));
    expect(html).toContain(commentOn('src/new.ts', 2));
    expect(html).toContain(commentOn('src/old.ts', 1));
  });

  it('shows the numbers of an ended session without a comment button', () => {
    const html = panel('merged', 'changes');
    expect(html).toContain('>11<');
    expect(html).not.toContain('aria-label="评论');
  });
});

describe('changes scope', () => {
  const ended = { project_id: 'project-a', session_id: 'a', state: 'completed', kind: 'send' };

  it('shows the whole branch by default above the changes of a live session with ended turns', () => {
    mock.board.board.session_turns = [{ ...ended, id: 'turn-1' }];
    const html = panel('ready', 'changes');
    expect(html).toContain(`aria-label="${zh('sessions.screen.changeScope')}"`);
    expect(html).toContain(zh('sessions.screen.scopeBranch'));
    mock.board.board.session_turns = [];
    expect(panel('ready', 'changes')).not.toContain(
      `aria-label="${zh('sessions.screen.changeScope')}"`,
    );
  });

  it('lists the files of the turn the turn menu asked for', () => {
    mock.board.board.session_turns = [{ ...ended, id: 'turn-1' }];
    mock.turnDiff = {
      session_id: 'a',
      turn_id: 'turn-1',
      files: [{ path: 'src/answer.ts', additions: 1, deletions: 1, untracked: false }],
      patch: patch.slice(0, patch.indexOf('src/new.ts') - 'diff --git a/'.length),
      truncated: false,
    };
    useTurnScope.getState().set('a', 'turn-1');
    const html = panel('ready', 'changes');
    expect(html).toContain(t({ id: 'sessions.screen.scopeTurn', defaultMessage: '' }, { n: 1 }));
    expect(html).toContain(commentOn('src/answer.ts', 10));
    expect(html).not.toContain('src/new.ts');
    const head = html.slice(html.indexOf('class="ss-chd"'), html.indexOf('class="ss-diff"'));
    expect(head).toContain('文件 1');
  });
});

describe('line comments', () => {
  it('names the file and line and quotes the line before the comment', () => {
    expect(
      lineComment(
        { path: 'src/answer.ts', line: 11, kind: 'add', text: '  return base + 2;' },
        '  This should stay 1.  ',
      ),
    ).toBe('src/answer.ts:11\n> +  return base + 2;\n\nThis should stay 1.');
    expect(lineComment({ path: 'src/old.ts', line: 1, kind: 'del', text: 'gone' }, 'Keep it')).toBe(
      'src/old.ts:1\n> -gone\n\nKeep it',
    );
  });
});

describe('merge button', () => {
  it('offers no fix button in the bottom row while a gate fails, only one in the gate results', () => {
    mock.gates = gates(1);
    const html = panel('ready', 'checks');
    expect(html).not.toContain('让它修');
    expect(html).toMatch(/class="gres"[\s\S]*让 agent 修/);
    expect(html.slice(html.indexOf('class="ss-pf"'))).not.toContain('附加');
  });

  it('names the current branch of the source', () => {
    mock.facts = {
      collected_at: 1,
      folders: [
        {
          root: '/repo',
          git: true,
          branch: 'main',
          commits_per_day: [],
          hotspots: [],
          recent_commits: [],
        } as unknown as ProjectFacts['folders'][number],
      ],
    };
    expect(panel('ready', 'changes')).toContain(
      `>${t({ id: 'sessions.panel.merge.mergeInto', defaultMessage: '' }, { target: 'main' })}</button>`,
    );
  });

  it('says only merge when the branch is unknown', () => {
    expect(panel('ready', 'changes')).toContain(`>${zh('sessions.panel.merge.merge')}</button>`);
  });

  it('says merging while it runs', () => {
    expect(panel('merging', 'changes')).toMatch(
      new RegExp(`aria-busy="true"[^>]*>${zh('sessions.panel.merge.merging')}</button>`),
    );
  });
});

describe('gate summary', () => {
  it('reports running before the last result', () => {
    expect(gateSummary({ ...gates(1), running: true })).toBe('running');
  });

  it('reports none without gates or a result', () => {
    expect(gateSummary(null)).toBe('none');
    expect(gateSummary({ configured: true, running: false, last: null })).toBe('none');
    expect(gateSummary({ ...gates(0), configured: false })).toBe('none');
  });

  it('passes only when every gate exits 0 in time', () => {
    expect(gateSummary(gates(0))).toBe('passed');
    expect(gateSummary(gates(1))).toBe('failed');
    const slow = gates(0);
    slow.last!.results[0] = { name: 'Lint', exit_code: 0, timed_out: true, output_tail: '' };
    expect(gateSummary(slow)).toBe('failed');
  });

  it('shows the result in the bottom row and unchecked without a result', () => {
    const card = () => {
      const html = panel('ready', 'changes');
      return html.slice(html.indexOf('class="ss-pf"'));
    };
    expect(card()).toContain(checkStatus('passed', 2, 2));
    mock.gates = gates(1);
    expect(card()).toContain(checkStatus('failed', 1, 2));
    mock.gates = { ...gates(1), running: true };
    expect(card()).toContain(checkStatus('running', 1, 2));
    mock.gates = null;
    expect(card()).toContain(checkStatus('none', 0, 0));
  });
});

describe('messages to a session', () => {
  it('steers a running session and sends to any other', () => {
    expect(messageCommand('running')).toBe('session.steer');
    expect(messageCommand('ready')).toBe('session.send');
    expect(messageCommand(undefined)).toBe('session.send');
  });
});
