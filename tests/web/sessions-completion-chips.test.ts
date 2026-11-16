import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
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
const mock = vi.hoisted(() => ({ board: {} as any, toast: (() => '') as (o: any) => string }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: any) => mock.toast(options),
}));
import { KeyHint } from '@/components/Shortcuts';
import { t } from '@/i18n';
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { DEFAULT_LOOK, setLook } from '@/data/layout';
import { keyText } from '@/lib/shortcuts';
import { removeCompletion } from '@/screens/sessions/completion';
import { AttachmentStrip, CompletionPopup, SendButton, useQueued } from '@/screens/sessions/parts';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';

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
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const open: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const inventory = (runtime: string) => ({
  runtime,
  mcp_servers: [],
  plugins: [],
  skills: [
    { id: 'review', name: 'review', enabled: true },
    { id: 'lint', name: 'lint', enabled: true },
  ],
  apps: false,
  connectors: [],
  hooks: [],
});

describe('removing a completed token', () => {
  it('drops the whole token and one space after it, the caret where the token was', () => {
    const at = { kind: '@', query: 'ap', start: 2 } as const;
    expect(removeCompletion('看 @ap', 5, at)).toEqual({ text: '看 ', caret: 2 });
    expect(removeCompletion('看 @apps 了', 5, at)).toEqual({ text: '看 了', caret: 2 });
    const slash = { kind: '/', query: 're', start: 0 } as const;
    expect(removeCompletion('/re', 3, slash)).toEqual({ text: '', caret: 0 });
  });
});

describe('completion menu and reference chips', () => {
  let session: Session;
  let command: ReturnType<typeof vi.fn>;
  let toasts: any[];
  const mount = async () => {
    const h = host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
    await h.flush();
    return h;
  };
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const popup = (h: HookHost<any>) => named(h.value, 'CompletionPopup').props;
  const menu = (h: HookHost<any>) => CompletionPopup(popup(h))!;
  const labels = (h: HookHost<any>) => popup(h).items.map((i: { label: string }) => i.label);
  const press = (h: HookHost<any>, key: string) => {
    box(h).props.onKeyDown({
      key,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    h.render();
  };
  const type = (h: HookHost<any>, value: string) => {
    box(h).props.onChange({ target: { value } });
    h.render();
  };
  const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);
  const mountNew = async () => {
    const h = host(() =>
      NewSession({
        projectId: 'project-a',
        defaults: undefined,
        focus: 0,
        onCreated() {},
        recent: [],
        onOpen() {},
        onClose() {},
      }),
    );
    await h.flush();
    return h;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    session = open;
    toasts = [];
    mock.toast = (options) => (toasts.push(options), 'toast');
    useQueued.setState({ queued: {} });
    useFeedback.setState({ items: {} });
    useDrafts.setState({ drafts: {} });
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-a', name: 'Project A' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    command = vi.fn(async () => ({ ok: true, value: { review_id: 'review-a' } }));
    const query = vi.fn(async (method: string, params: Record<string, string>) =>
      method === 'files.search'
        ? { ok: true, value: ['apps/a.ts', 'apps/b.ts'] }
        : method === 'extensions.inventory'
          ? { ok: true, value: inventory(params.runtime!) }
          : { ok: true, value: [] },
    );
    vi.stubGlobal('window', {
      pantheon: { command, query },
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('puts a picked path on the box as a removable chip and sends it after the typed text', async () => {
    const h = await mount();
    type(h, '看 @ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    press(h, 'ArrowDown');
    press(h, 'Enter');
    await h.flush();
    expect(box(h).props.value).toBe('看 ');
    const strip = AttachmentStrip(named(h.value, 'AttachmentStrip').props)!;
    const chip = find(strip, (n) => n.props.role === 'listitem');
    expect(text(chip)).toContain('apps/b.ts');
    const remove = find(chip, (n) => n.type === 'button');
    expect(remove.props['aria-label']).toBe(
      t({ id: 'sessions.completion.removeReference', defaultMessage: '' }, { path: 'apps/b.ts' }),
    );
    type(h, '看这个');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      ['session.send', { session_id: 'session-a', input: '看这个\n\n@apps/b.ts' }],
    ]);
    expect(useDrafts.getState().drafts[draftKey('project-a', 'session-a')]?.mentions ?? []).toEqual(
      [],
    );
  });

  it('takes a chip off the next message with its remove button', async () => {
    const h = await mount();
    type(h, '@ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    press(h, 'Enter');
    const strip = AttachmentStrip(named(h.value, 'AttachmentStrip').props)!;
    find(
      find(strip, (n) => n.props.role === 'listitem'),
      (n) => n.type === 'button',
    ).props.onClick();
    expect(useDrafts.getState().drafts[draftKey('project-a', 'session-a')]?.mentions ?? []).toEqual(
      [],
    );
  });

  it('still inserts a picked path as text in the new-session composer', async () => {
    const h = await mountNew();
    type(h, '@ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    press(h, 'Tab');
    expect(box(h).props.value).toBe('@apps/a.ts ');
    expect(labels(h)).toEqual([]);
  });

  it('groups commands and skills under a bare slash, leaves out a skill named like a command, and flattens them once a query is typed', async () => {
    const h = await mount();
    type(h, '/');
    expect(labels(h)).toEqual(['/review', '/lint']);
    const groups = nodes(menu(h)).filter((n) => n.props.role === 'group');
    expect(
      groups.map((g) => text(find(g, (n) => n.props.id === g.props['aria-labelledby']))),
    ).toEqual([zh('sessions.completion.commands'), zh('sessions.completion.skills')]);
    const options = nodes(menu(h)).filter((n) => n.props.role === 'option');
    expect(options.map((n) => n.props.id)).toEqual([`${popup(h).id}-0`, `${popup(h).id}-1`]);
    type(h, '/re');
    expect(labels(h)).toEqual(['/review']);
    expect(nodes(menu(h)).filter((n) => n.props.role === 'group')).toEqual([]);
    expect(nodes(menu(h)).filter((n) => n.props.role === 'option')).toHaveLength(1);
  });

  it('asks the other vendor to review the session when /review is picked, sending nothing', async () => {
    const h = await mount();
    type(h, '/rev');
    press(h, 'Enter');
    await h.flush();
    expect(box(h).props.value).toBe('');
    expect(sent()).toEqual([['review.request', { session_id: 'session-a', runtimes: ['codex'] }]]);
    expect(toasts).toEqual([
      {
        title: t(
          { id: 'sessions.completion.reviewAsked', defaultMessage: '' },
          { runtime: 'Codex' },
        ),
      },
    ]);
  });

  it('tells why a review could not be asked for', async () => {
    command.mockImplementation(async () => ({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'codex is not installed' },
    }));
    const h = await mount();
    type(h, '/review');
    press(h, 'Enter');
    await h.flush();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('failure');
    expect(toasts[0].title).toContain('codex is not installed');
  });

  it('offers no review in the new-session composer', async () => {
    const h = await mountNew();
    type(h, '/re');
    expect(labels(h)).toEqual(['/review']);
    press(h, 'Enter');
    expect(box(h).props.value).toBe('/review ');
    expect(command).not.toHaveBeenCalled();
  });

  it('caps the send key of a running turn with the key that does the other action', async () => {
    session = { ...open, state: 'running' };
    const h = await mount();
    type(h, 'later');
    const props = named(h.value, 'SendButton').props;
    expect(props.steers).toBe(true);
    const button = find(SendButton(props), (n) => n.type === 'button');
    expect(find(button, (n) => n.type === KeyHint).props.id).toBe('steer');
    expect(button.props['aria-label']).toBe(
      t(
        { id: 'sessions.completion.sendOther', defaultMessage: '' },
        { action: zh('sessions.composer.queue'), keys: keyText('Meta+Enter'), then: 'steer' },
      ),
    );
  });

  it('caps no send key of a running turn when ⌘Enter is the send key', async () => {
    setLook({ send_key: 'meta-enter' });
    session = { ...open, state: 'running' };
    const h = await mount();
    type(h, 'later');
    const button = find(SendButton(named(h.value, 'SendButton').props), (n) => n.type === 'button');
    setLook(DEFAULT_LOOK);
    expect(nodes(button).some((n) => n.type === KeyHint)).toBe(false);
    expect(button.props['aria-label']).toBe(zh('sessions.composer.queue'));
  });

  it('caps no send key while no turn runs', async () => {
    const h = await mount();
    type(h, 'now');
    const button = find(SendButton(named(h.value, 'SendButton').props), (n) => n.type === 'button');
    expect(nodes(button).some((n) => n.type === KeyHint)).toBe(false);
    expect(button.props['aria-label']).toBe(zh('sessions.composer.send'));
  });
});

describe('completion menu styles', () => {
  it('opens, closes and moves the selection without motion', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/sessions/completion.css', import.meta.url),
      'utf8',
    );
    expect(css).not.toMatch(/transition|animation/);
  });
});
