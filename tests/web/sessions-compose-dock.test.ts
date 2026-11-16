import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import {
  find,
  type HookHost,
  mount as host,
  named,
  nodes,
  text,
  unmountAll,
} from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { Equalizer } from '@/components/Equalizer';
import { t } from '@/i18n';
import { useDrafts } from '@/data/drafts';
import type { TranscriptItem, TurnView } from '@/data/transcript';
import { useQueued, type QueuedMessage } from '@/screens/sessions/parts';
import { QueueDock } from '@/screens/sessions/QueueDock';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';

const NOW = Date.parse('2026-11-14T10:00:00.000Z');

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of session-a',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const running: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'running',
  turn_count: 1,
};
const turn = (items: TranscriptItem[], started = NOW - 5_000): TurnView => ({
  turn: {
    id: 'turn-a',
    revision: 1,
    project_id: 'project-a',
    session_id: 'session-a',
    input: 'Build it',
    kind: 'send',
    delivery: 'delivered',
    state: 'running',
  },
  at: started,
  started_at: started,
  ended_at: null,
  text: '',
  usage: null,
  end: null,
  items,
});
const agent = (id: string, ok?: boolean): TranscriptItem => ({
  kind: 'tool',
  id,
  name: 'Task',
  input: { subagent_type: 'Explore' },
  started_at: NOW - 3_000,
  ...(ok === undefined ? {} : { ok }),
});
const done = (id: string): TranscriptItem => ({
  kind: 'tool',
  id,
  name: 'Read',
  input: { file_path: 'a.ts' },
  ok: true,
  started_at: NOW - 4_000,
});

let session: Session;
let command: ReturnType<typeof vi.fn>;
const mount = (
  props: {
    running?: TurnView | null;
    waiting?: 'approval' | 'question' | null;
    listed?: WorkbenchSession;
  } = {},
) => host(() => SessionCompose({ session, listed, title: 'title of session-a', ...props }));
const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
const hasStatus = (h: HookHost<any>) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === 'ComposeStatus');
/** The status line above the box, drawn with the props the composer gave it. */
function statusLine(h: HookHost<any>) {
  const element = named(h.value, 'ComposeStatus');
  return host(() => (element.type as (props: unknown) => ReactNode)(element.props)).value;
}
const glyph = (tree: ReactNode) => find(tree, (n) => n.props.className === 'cp-stg');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  session = running;
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
  mock.board = {
    status: { state: 'live' },
    board: { cursor: 1, projects: [] },
    events: [],
    resync: 0,
    refresh() {},
  };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  vi.stubGlobal('window', {
    pantheon: {
      command,
      query: vi.fn(async (method: string, params: Record<string, string>) =>
        method === 'extensions.inventory'
          ? {
              ok: true,
              value: {
                runtime: params.runtime,
                mcp_servers: [],
                plugins: [],
                skills: [
                  { id: 'skill-a', name: 'skill-a', enabled: true },
                  { id: 'skill-b', name: 'skill-b', enabled: true },
                ],
                apps: false,
                connectors: [],
                hooks: [],
              },
            }
          : { ok: true, value: [] },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('placeholder of the box', () => {
  it('asks for more or an answer while an approval waits, and queues while a turn runs', () => {
    expect(box(mount({ running: turn([]), waiting: 'approval' })).props.placeholder).toBe(
      zh('sessions.composeDock.approvalPlaceholder'),
    );
    expect(box(mount({ running: turn([]) })).props.placeholder).toBe(
      zh('sessions.composeDock.queuePlaceholder'),
    );
    session = { ...running, state: 'open' };
    expect(box(mount()).props.placeholder).toBe(zh('sessions.composer.reply'));
  });
});

describe('status line above the box', () => {
  it('shows only once the turn has run for a second, in a slot that is always there', () => {
    const h = mount({ running: turn([], NOW) });
    const slot = () => nodes(h.value).filter((n) => n.props.className === 'cp-sts');
    expect(hasStatus(h)).toBe(false);
    expect(slot()).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    h.render();
    expect(hasStatus(h)).toBe(true);
    expect(slot()).toHaveLength(1);
  });

  it('draws bars while the turn works and a breathing ring while it waits for you', () => {
    const working = glyph(statusLine(mount({ running: turn([]) })));
    expect(working.props['data-kind']).toBe('running');
    expect(nodes(working).some((n) => n.type === Equalizer)).toBe(true);
    const waiting = glyph(statusLine(mount({ running: turn([]), waiting: 'question' })));
    expect(waiting.props['data-kind']).toBe('waiting');
    expect(nodes(waiting).some((n) => n.type === Equalizer)).toBe(false);
    const css = readFileSync(
      new URL('../../apps/web/src/screens/sessions/compose.css', import.meta.url),
      'utf8',
    );
    expect(css).toMatch(/\.cp-stg\[data-kind='waiting'\]::after \{[^}]*animation: cp-breathe/);
    expect(css).toMatch(/\.cp-sts \{[^}]*height: 18px/);
  });

  it('writes the newest sentence of the reply with a caret', () => {
    const line = statusLine(
      mount({
        running: turn([done('read-a'), { kind: 'text', text: 'Read it. Now the order of' }]),
      }),
    );
    expect(text(line)).toContain('Now the order of');
    expect(text(line)).not.toContain('Read it.');
    expect(nodes(line).some((n) => n.props.className === 'cp-crt')).toBe(true);
  });

  it('counts the time and the finished steps while no total is known', () => {
    const line = text(statusLine(mount({ running: turn([done('read-a'), done('read-b')]) })));
    expect(line).toContain(zh('sessions.thread.status.thinking'));
    expect(line).toContain(t({ id: 'data.elapsed.seconds', defaultMessage: '' }, { seconds: 5 }));
    expect(line).toContain(
      t({ id: 'sessions.composeDock.steps', defaultMessage: '' }, { count: 2 }),
    );
  });

  it('draws a bar of the dispatched agents with the finished count', () => {
    const line = statusLine(
      mount({ running: turn([agent('agent-a', true), agent('agent-b', true), agent('agent-c')]) }),
    );
    const bar = find(line, (n) => n.props.className === 'cp-sgb');
    expect(
      nodes(bar)
        .filter((n) => n.type === 'i')
        .map((n) => n.props['data-done']),
    ).toEqual([true, true, undefined]);
    expect(text(line)).toContain(zh('sessions.composeDock.agents'));
    expect(text(line)).toContain('2 / 3');
  });

  it('names what the waiting approval would do', () => {
    const line = text(
      statusLine(
        mount({
          running: turn([
            {
              kind: 'request',
              id: 'request-a',
              tool: 'Bash',
              input: { command: 'pnpm db:migrate' },
              questions: [],
            },
          ]),
          waiting: 'approval',
        }),
      ),
    );
    expect(line).toContain(
      t({ id: 'sessions.composeDock.askRun', defaultMessage: '' }, { command: 'pnpm db:migrate' }),
    );
  });
});

describe('add menu', () => {
  it('offers the skills with their count and opens them in the box', async () => {
    session = { ...running, state: 'open' };
    const h = mount();
    await h.flush();
    const item = find(
      h.value,
      (n) => n.type === Menu.Item && text(n).startsWith(zh('sessions.composeDock.skills')),
    );
    expect(text(find(item, (n) => n.props.className === 'cp-ct'))).toBe('2');
    item.props.onClick();
    h.render();
    expect(box(h).props.value).toBe('/');
  });

  it('switches plan mode on and off and shows it as a chip in the row', async () => {
    session = { ...running, state: 'open' };
    const h = mount();
    const plan = () =>
      find(
        h.value,
        (n) => n.type === Menu.CheckboxItem && text(n) === zh('sessions.composeDock.planMode'),
      );
    expect(plan().props.checked).toBe(false);
    plan().props.onCheckedChange(true);
    await h.flush();
    expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
      ['session.setPermissionMode', { session_id: 'session-a', permission_mode: 'plan' }],
    ]);
    const on = mount({ listed: { ...listed, permission_mode: 'plan' } });
    expect(text(find(on.value, (n) => n.props.className === 'chip cp-chip'))).toBe(
      zh('sessions.composeDock.planMode'),
    );
  });
});

describe('queue fold', () => {
  it('folds the older messages into a row with the queued ring and a down arrow', () => {
    const message = (text: string): QueuedMessage => ({ text, attachments: [], skills: [] });
    useQueued.setState({
      queued: { 'session-a': ['m1', 'm2', 'm3', 'm4', 'm5'].map(message) },
    });
    const h = host(() => QueueDock({ session }));
    const more = find(h.value, (n) => n.type === 'button');
    expect(glyph(more).props['data-kind']).toBe('queued');
    expect(text(more)).toBe(
      t({ id: 'sessions.composer.queuedMore', defaultMessage: '' }, { count: 2 }),
    );
    expect(
      nodes(more).some((n) => typeof n.type !== 'string' && n.props.className === 'cp-qmi'),
    ).toBe(true);
  });
});
