import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { Sidebar } from '@/components/Sidebar';
import { runtimeName } from '@/components/RuntimeGlyph';
import { sessionStateTone } from '@/components/SessionStateIcon';
import { t } from '@/i18n';
import { listText } from '@/lib/list-text';
import { EFFORT_LABEL, permissionModeLabel } from '@/screens/sessions/model';
import { SessionListRow, SessionPreview, SessionRowButton } from '@/screens/sessions/SessionRow';

const local = (hour: number, minute: number, day = 13) =>
  new Date(2026, 10, day, hour, minute).toISOString();

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: local(10, 2),
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
  last_activity_at: local(10, 30),
  changes: null,
  merge: null,
  ...extra,
});

const css = readFileSync(new URL('../../apps/web/src/index.css', import.meta.url), 'utf8');
const overview = readFileSync(
  new URL('../../apps/web/src/screens/sessions/overview.css', import.meta.url),
  'utf8',
);
const rule = (sheet: string, selector: string) =>
  // The selector alone or as one entry of a selector list.
  new RegExp(
    `^(?:[^{}()\\n]*,)?${selector.replace(/[.[\]()>=]/g, '\\$&')}(?:,[^{}()\\n]*)? ?\\{([^}]*)\\}`,
    'm',
  ).exec(sheet)?.[1];
const approval = (detail: string) =>
  t({ id: 'sessions.row.preview.waitingApproval', defaultMessage: '' }, { detail });
const SOURCE = zh('sessions.row.preview.source');
const CONTEXT = zh('sessions.row.preview.context');

describe('session row styles', () => {
  it.each([
    ['.ss-badge', 'width', '8px'],
    ['.ss-badge', 'height', '8px'],
    ['.ss-badge', 'border', '1.5px solid transparent'],
    ['.ss-badge', 'border-radius', '50%'],
    ['.ss-badge[data-badge=running]', 'animation', 'ss-breathe'],
    ['.ss-badge[data-badge=merging]', 'animation', 'ss-breathe'],
    ['.ss-badge[data-badge=queued]', 'width', '7px'],
    ['.ss-badge[data-badge=queued]', 'height', '7px'],
    ['.ss-badge[data-badge=queued]', 'border-color', 'var(--idle)'],
    ['.ss-dstat i', 'width', '6px'],
    ['.ss-dstat i', 'height', '6px'],
    ['.ss-hc-kv', 'grid-template-columns', '52px minmax(0,1fr)'],
    ['.ss-hc-h b', 'font-weight', '500'],
    ['.sb-vm', 'width', '196px'],
    ['.sb-vm-h', 'font-weight', '500'],
    ['.sb-vm [data-checked]>.ps-sw', 'background', 'var(--ink)'],
    ['.ov-card', 'width', '280px'],
  ])('%s sets %s to %s', (selector, property, value) => {
    const body = rule(css, selector) ?? rule(overview, selector);
    expect(body).toMatch(new RegExp(`(^|;|\\s)${property}: ?${value.replace(/[().]/g, '\\$&')}`));
  });

  it('stops the running pulse when state motion is off and defines no unread mark', () => {
    expect(css).toMatch(/\[data-state-motion=off\]\) :is\([^)]*\.ss-badge\[data-badge=running\]/);
    expect(css).not.toMatch(/\.ss-unread\b/);
  });
});
const target = { addEventListener() {}, removeEventListener() {} };
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, hasFocus: () => true, visibilityState: 'visible' });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  mock.board = {
    board: { sessions: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    refresh() {},
  };
  mock.shell = { screen: 'sessions', sessionId: null, sessionGroup: null, renaming: null };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('sidebar row status mark', () => {
  const row = (s: WorkbenchSession, unread = false) =>
    renderToStaticMarkup(
      createElement(SessionRowButton, {
        session: s,
        on: false,
        unread,
        now: Date.parse(local(10, 40)),
        onSelect() {},
      }),
    );
  const marks = (html: string) =>
    [
      ...html.matchAll(
        /<span class="ss-badge" role="img" aria-label="([^"]*)" data-badge="([a-z]+)"(?: style="--c:var\(([^)]*)\)")?><\/span>/g,
      ),
    ].map(([, label, badge, tone]) => [badge, label, tone]);

  it('draws one mark by priority: recovery, environment, approval, failure, running, review, unread', () => {
    const cases: [WorkbenchSession, boolean, string | null][] = [
      [session('a', 'waiting', { waiting: 1, reconciling: true }), true, 'reconciling'],
      [
        session('b', 'ready', { merge: { state: 'blocked', failure_class: 'environment' } }),
        false,
        'environment',
      ],
      [
        session('c', 'waiting', {
          waiting: 1,
          gate: { state: 'failed', passed: 0, failed: 1, running: 0 },
        }),
        true,
        'approval',
      ],
      [
        session('d', 'running', { gate: { state: 'failed', passed: 0, failed: 1, running: 0 } }),
        true,
        'failed',
      ],
      [session('e', 'running'), true, 'running'],
      [session('f', 'idle', { last_turn: { id: 't', state: 'queued' } }), true, 'queued'],
      [session('g', 'ready'), true, 'ready'],
      [session('h', 'idle'), true, 'unread'],
      [session('i', 'merged'), true, 'unread'],
      [session('j', 'idle'), false, null],
      [session('k', 'merged'), false, null],
    ];
    for (const [listed, unread, badge] of cases) {
      const html = row(listed, unread);
      expect(
        marks(html).map(([b]) => b),
        listed.id,
      ).toEqual(badge ? [badge] : []);
      expect(html).not.toContain('ss-unread');
    }
    const recovering = session('a', 'waiting', { reconciling: true });
    expect(marks(row(recovering))[0]!.slice(1)).toEqual([
      zh('components.sessionState.reconciling'),
      sessionStateTone(recovering),
    ]);
    expect(
      marks(
        row(session('b', 'ready', { merge: { state: 'blocked', failure_class: 'environment' } })),
      )[0]![1],
    ).toBe(zh('sessions.sidebar.badge.environment'));
    expect(marks(row(session('h', 'idle'), true))[0]![1]).toBe(zh('sessions.sidebar.badge.unread'));
  });
});

describe('session preview', () => {
  const render = (s: WorkbenchSession, extra: Partial<Parameters<typeof SessionPreview>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(SessionPreview, { session: s, now: Date.parse(local(10, 42)), ...extra }),
    );
  const facts = (html: string) =>
    [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, label, value]) => [
      label,
      value!.replace(/<[^>]*>/g, ''),
    ]);

  it('names what it was forked from and when', () => {
    const forked = session('b', 'idle', { forked_from: { session_id: 's' } });
    expect(facts(render(forked, { source: 'Source' }))).toContainEqual([
      SOURCE,
      t(
        { id: 'sessions.sidebar.preview.forkedFrom', defaultMessage: '' },
        { source: 'Source', time: '10:02' },
      ),
    ]);
    const before = session('c', 'idle', {
      forked_from: { session_id: 's' },
      created_at: local(10, 2, 11),
    });
    const [, value] = facts(render(before, { source: 'Source' })).find(([l]) => l === SOURCE)!;
    expect(value).toMatch(/^分叉自 Source，.*11.*10:02$/);
  });

  it('draws changes as five cells of added and deleted lines', () => {
    const html = render(
      session('a', 'idle', { changes: { files: 3, additions: 61, deletions: 19 } }),
    );
    expect(html).toContain(
      `<span class="ss-dstat" role="img" aria-label="${t({ id: 'components.diffBar.label', defaultMessage: '' }, { additions: 61, deletions: 19 })}"><i data-k="add"></i><i data-k="add"></i><i data-k="add"></i><i data-k="del"></i><i></i></span>`,
    );
    expect(html).not.toContain('dbar');
  });

  it('says what an approval waits for under the title, by its detail or else its tool', () => {
    const waiting = (request: WorkbenchSession['waiting_request']) =>
      session('a', 'waiting', { waiting: 1, waiting_kind: 'approval', waiting_request: request });
    expect(render(waiting({ tool: 'Bash', detail: 'run the migration on staging' }))).toContain(
      `<span class="ss-hc-mu ss-hc-cut" title="${approval('run the migration on staging')}">${approval('run the migration on staging')}</span>`,
    );
    expect(render(waiting({ tool: 'Bash' }))).toContain(`>${approval('Bash')}</span>`);
    const question = render(
      session('b', 'waiting', {
        waiting: 1,
        waiting_kind: 'question',
        waiting_request: { tool: 'AskUserQuestion', detail: 'Which branch?' },
      }),
    );
    expect(question).toContain(zh('components.sessionState.question'));
    expect(question).not.toContain(approval(''));
  });

  it('draws the context used as a meter and its tokens, warning past 80%', () => {
    const html = render(
      session('a', 'running', { context: { used_tokens: 184000, window_tokens: 400000 } }),
    );
    expect(facts(html)).toContainEqual([CONTEXT, '184k']);
    expect(html).toContain('style="--v:46%;--c:var(--run)"');
    expect(html).toContain('<span class="ss-hc-mu ss-hc-n">184k</span>');
    const full = render(
      session('b', 'running', { context: { used_tokens: 340000, window_tokens: 400000 } }),
    );
    expect(full).toContain('style="--v:85%;--c:var(--wait)"');
  });

  it('names the model and permission mode in one unlabelled line, whole in its title', () => {
    const html = render(
      session('a', 'idle', { model: 'claude-opus-4-7', effort: 'high', permission_mode: 'ask' }),
    );
    const line = listText(
      'claude-opus-4-7',
      EFFORT_LABEL.high,
      permissionModeLabel('claude', 'ask'),
    );
    expect(html).toContain(`title="${line}">${line}</span>`);
    const labels = facts(html).map(([label]) => label);
    expect(labels).not.toContain('模型');
    expect(labels).not.toContain('权限');
  });

  it.each([
    ['the model the default row resolves to', { model: null }, 'Opus 5.5'],
    ['the label of a listed model', { model: 'opus' }, 'Opus 5.5'],
  ])('names %s with its default effort in the model line', (_, own, name) => {
    const row = (id: string, extra = {}) => ({
      id,
      label: id,
      permission_modes: [],
      efforts: [],
      default_effort: 'high' as const,
      default: false,
      ...extra,
    });
    const models = {
      state: 'ready' as const,
      models: [
        row('default', { default: true, resolved: 'claude-opus-5-5' }),
        row('opus', { label: 'Opus 5.5', resolved: 'claude-opus-5-5' }),
      ],
    };
    const s = session('a', 'idle', {
      runtime: 'claude',
      effort: null,
      permission_mode: 'ask',
      ...own,
    });
    const line = listText(name, EFFORT_LABEL.high, permissionModeLabel('claude', 'ask'));
    expect(render(s, { models })).toContain(`title="${line}">${line}</span>`);
  });

  it('names the runtime in the model line while its model list is not read', () => {
    const s = session('a', 'idle', {
      runtime: 'claude',
      model: null,
      effort: null,
      permission_mode: 'ask',
    });
    const line = listText(runtimeName('claude'), permissionModeLabel('claude', 'ask'));
    expect(render(s)).toContain(`title="${line}">${line}</span>`);
  });

  it('shows no waiting line or context without those facts', () => {
    const html = render(session('a', 'waiting', { waiting: 1 }));
    expect(html).not.toContain(approval(''));
    expect(facts(html).map(([label]) => label)).not.toContain(CONTEXT);
  });
});

describe('row preview', () => {
  const preview = (s: WorkbenchSession) =>
    find(
      mount(() => SessionListRow({ session: s, on: false, now: 0, onSelect() {} })).value,
      (n) => n.type === SessionPreview,
    ) as ReactElement<any>;

  it('shows only information, with no buttons, for a session it could review, fork or archive', () => {
    const shown = preview(
      session('a', 'idle', { changes: { files: 2, additions: 3, deletions: 1 } }),
    );
    expect(renderToStaticMarkup(createElement(SessionPreview, shown.props))).not.toContain(
      '<button',
    );
  });
});

describe('sidebar view menu and search', () => {
  const sidebar = () =>
    mount(() =>
      Sidebar({
        layout: {
          collapsed: false,
          width: 264,
          resize: () => {},
          commit: () => {},
          reset: () => {},
          toggle: () => {},
        },
        projects: [{ id: 'alpha', name: 'Alpha' }],
        currentProjectId: 'alpha',
        onChooseProject: () => {},
        list: { data: [], loading: false, error: null, reload() {} } as any,
        allNeeds: { items: [], error: null } as any,
      }),
    );
  const viewMenu = () => {
    const node = find(sidebar().value, (n) => (n.type as any)?.name === 'ViewMenu');
    return mount(() => (node.type as (props: object) => any)(node.props)).value;
  };

  it('shows archived with a switch at the end of its row in a 196px menu', () => {
    const menu = viewMenu();
    const popup = find(
      menu,
      (n) => typeof n.props.className === 'string' && n.props.className.includes('pjm'),
    );
    expect(popup.props.className).toContain('sb-vm');
    const item = find(
      menu,
      (n) =>
        'checked' in n.props &&
        'onCheckedChange' in n.props &&
        text(n.props.children) === zh('components.sidebar.showArchived'),
    );
    const parts = nodes(item.props.children);
    expect(text(item.props.children)).toBe(zh('components.sidebar.showArchived'));
    expect(parts.at(-1)!.props).toMatchObject({ className: 'ps-sw', 'aria-hidden': 'true' });
  });

  it('leaves search out of the sidebar bottom, which holds only settings', () => {
    const bottom = find(sidebar().value, (n) => n.props.className === 'sb-gz');
    const buttons = nodes(bottom).filter((n) => n.type === 'button');
    expect(buttons.map((n) => text(n.props.children))).toEqual([zh('app.screenName.settings')]);
  });
});
