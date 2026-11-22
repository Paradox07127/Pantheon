import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryDirectory, MemoryItem } from '@pantheon/domain';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  directory: null as any,
  read: {} as Record<string, unknown>,
  refresh: () => {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ status: { state: 'live' }, events: [] }), {
    getState: () => ({ refresh: mock.refresh }),
  }),
}));
vi.mock('@/data/memory', () => ({
  useMemoryQuery: () => ({
    data: mock.directory,
    loading: false,
    error: null,
    reload() {},
    ...mock.read,
  }),
}));
import { Menu } from '@/components/Menu';
import {
  NewMemoryDialog,
  saveMemory,
  type MemoryProposal,
  type SaveOptions,
} from '@/screens/memory/NewMemoryDialog';
import { zh } from './i18n-setup.js';

const SIGNATURE = 'a'.repeat(64);
const directory = (): Partial<MemoryDirectory> => ({
  signature: SIGNATURE,
  records: [
    {
      id: 'memory-store',
      revision: 1,
      key: 'store',
      title: 'Keys live in the store',
      summary: '',
      tags: [],
      kind: 'decision',
      state: 'active',
      authority: 'user',
      created_at: 1,
      indexed: true,
      bytes: 10,
    },
    {
      id: 'memory-rewritten',
      revision: 1,
      key: 'retry',
      title: 'Retry with backoff',
      summary: '',
      tags: [],
      kind: 'note',
      state: 'active',
      authority: 'user',
      created_at: 1,
      indexed: true,
      bytes: 10,
    },
  ],
  facets: { tags: [] },
});

beforeEach(() => {
  mock.directory = directory();
  mock.read = {};
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** The form inside the open dialog, mounted on its own host. */
function open(props: Partial<Parameters<typeof NewMemoryDialog>[0]> = {}) {
  const onSubmit = vi.fn(
    async (_input: MemoryProposal, _confirm: boolean, _options: SaveOptions) => ({
      ok: true as const,
      id: 'memory-new',
    }),
  );
  const onOpenChange = vi.fn();
  const dialog = mount(() =>
    NewMemoryDialog({ open: true, projectId: 'project-a', onOpenChange, onSubmit, ...props }),
  );
  const form = named(dialog.value, 'MemoryForm');
  const h = mount(() => (form.type as (p: object) => ReactElement<any>)(form.props));
  return { dialog, h, onSubmit: (props.onSubmit as typeof onSubmit) ?? onSubmit, onOpenChange };
}
const labelled = (h: HookHost<any>, label: string) =>
  find(h.value, (n) => n.props['aria-label'] === label);
const button = (h: HookHost<any>, label: string) =>
  find(
    h.value,
    (n) =>
      (n.type === 'button' || /\bbtn\b/.test(n.props.className ?? '')) &&
      text(n.props.children).includes(label),
  );
const menu = (h: HookHost<any>, label: string) =>
  find(h.value, (n) => n.type === Menu && n.props.label === label);
function type(h: HookHost<any>, label: string, value: string) {
  labelled(h, label).props.onChange({ target: { value } });
  h.render();
}
function press(h: HookHost<any>, label: string) {
  button(h, label).props.onClick();
  h.render();
}
function enter(h: HookHost<any>, label: string, value: string) {
  type(h, label, value);
  labelled(h, label).props.onKeyDown({
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {},
    nativeEvent: {},
  });
  h.render();
}

describe('the new memory dialog', () => {
  it('checks the spelling of the body', () => {
    expect(labelled(open().h, zh('memory.new.text')).props.spellCheck).toBe(true);
  });

  it('records a decision with its tags and sources and confirms it', async () => {
    const { h, onSubmit, onOpenChange } = open();
    expect(labelled(h, zh('memory.new.kind')).props.value).toBe('decision');
    type(h, zh('memory.new.title'), 'Retry with backoff');
    type(h, zh('memory.new.summary'), 'Six tries');
    type(h, zh('memory.new.text'), 'Double the wait each time.');
    type(h, zh('memory.new.key'), 'webhook-retry');
    press(h, zh('memory.new.addTag'));
    enter(h, zh('memory.new.tagInput'), 'refunds');
    press(h, zh('memory.new.addSource'));
    enter(h, zh('memory.new.sourceInput'), 'src/webhooks/retry.ts');
    press(h, zh('memory.new.addSource'));
    enter(h, zh('memory.new.sourceInput'), 'https://docs.example.com/retries');
    expect(text(labelled(h, '去掉标签 refunds').props.children)).toBe('refunds');
    expect(labelled(h, '去掉来源 src/webhooks/retry.ts').type).toBe('button');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).toHaveBeenCalledWith(
      {
        project_id: 'project-a',
        key: 'webhook-retry',
        kind: 'decision',
        title: 'Retry with backoff',
        summary: 'Six tries',
        tags: ['refunds'],
        references: [
          { kind: 'file', uri: 'src/webhooks/retry.ts' },
          { kind: 'url', uri: 'https://docs.example.com/retries' },
        ],
        text: 'Double the wait each time.',
        dependencies: [],
        based_on: SIGNATURE,
      },
      true,
      {},
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('saves a report as a draft with the memory it rests on, and leaves that out of a decision', async () => {
    const { h, onSubmit } = open();
    labelled(h, zh('memory.new.kind')).props.onValueChange('report');
    h.render();
    type(h, zh('memory.new.text'), 'Two requests 40ms apart both write.');
    type(h, zh('memory.new.key'), 'race');
    const pick = find(
      menu(h, zh('memory.new.dependencies')).props.children,
      (n) => text(n.props.children) === 'Keys live in the store',
    );
    pick.props.onChange(true);
    h.render();
    expect(labelled(h, '去掉依据 Keys live in the store').type).toBe('button');
    press(h, zh('memory.new.saveDraft'));
    await h.flush();
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'report', dependencies: ['memory-store'] }),
      false,
      {},
    );
    labelled(h, zh('memory.new.kind')).props.onValueChange('decision');
    h.render();
    expect(button(h, zh('memory.new.dependencies')).props['aria-disabled']).toBe(true);
    expect(nodes(h.value).some((n) => n.props['aria-label']?.startsWith?.('去掉依据'))).toBe(false);
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'decision', dependencies: [] }),
      true,
      {},
    );
  });

  it('rewrites an entry with its text, sources and expiry carried over', async () => {
    const original: MemoryItem = {
      id: 'memory-rewritten',
      revision: 2,
      project_id: 'project-a',
      key: 'retry',
      title: 'Retry with backoff',
      summary: 'Six tries',
      tags: ['refunds'],
      references: [{ kind: 'file', uri: 'src/retry.ts', root: 0, content_hash: 'f'.repeat(64) }],
      kind: 'note',
      state: 'active',
      authority: 'user',
      author: 'user',
      body_hash: 'b'.repeat(64),
      dependencies: ['memory-store'],
      based_on: SIGNATURE,
      created_at: 1,
      expires_at: new Date(2026, 11, 2).getTime(),
      text: 'Double the wait each time.',
    };
    const { dialog, h, onSubmit } = open({ original });
    expect(
      find(dialog.value, (n) => n.props['aria-label'] === zh('memory.new.rewrite')),
    ).toBeTruthy();
    expect(labelled(h, zh('memory.new.title')).props.value).toBe('Retry with backoff');
    expect(labelled(h, zh('memory.new.key')).props.value).toBe('retry');
    expect(text(button(h, '到期').props.children)).toContain('12月1日');
    // The version being replaced is no candidate for what the new one rests on.
    expect(
      nodes(menu(h, zh('memory.new.dependencies')).props.children).some(
        (n) => text(n.props.children) === 'Retry with backoff',
      ),
    ).toBe(false);
    type(h, zh('memory.new.text'), 'Double the wait, at most six times.');
    press(h, zh('memory.new.saveDraft'));
    await h.flush();
    expect(onSubmit).toHaveBeenCalledWith(
      {
        project_id: 'project-a',
        key: 'retry',
        kind: 'note',
        title: 'Retry with backoff',
        summary: 'Six tries',
        tags: ['refunds'],
        references: [{ kind: 'file', uri: 'src/retry.ts', root: 0 }],
        text: 'Double the wait, at most six times.',
        dependencies: ['memory-store'],
        expires_at: new Date(2026, 11, 2).getTime(),
        based_on: SIGNATURE,
      },
      false,
      {},
    );
  });

  it('locks the kind to the active original while the key still matches it', async () => {
    const original: MemoryItem = {
      id: 'memory-rewritten',
      revision: 2,
      project_id: 'project-a',
      key: 'retry',
      kind: 'note',
      state: 'active',
      authority: 'user',
      author: 'user',
      body_hash: 'b'.repeat(64),
      dependencies: [],
      based_on: SIGNATURE,
      created_at: 1,
      text: 'Double the wait each time.',
    };
    const { h, onSubmit } = open({ original });
    expect(labelled(h, zh('memory.new.kind')).props.disabled).toBe(true);
    type(h, zh('memory.new.key'), 'retry-policy');
    expect(labelled(h, zh('memory.new.kind')).props.disabled).toBe(false);
    labelled(h, zh('memory.new.kind')).props.onValueChange('decision');
    h.render();
    expect(labelled(h, zh('memory.new.kind')).props.value).toBe('decision');
    type(h, zh('memory.new.key'), 'retry');
    expect(labelled(h, zh('memory.new.kind')).props.value).toBe('note');
    expect(labelled(h, zh('memory.new.kind')).props.disabled).toBe(true);
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'retry', kind: 'note' }),
      true,
      {},
    );
  });

  it('sets and clears an expiry date', async () => {
    const { h, onSubmit } = open();
    expect(text(button(h, zh('memory.new.noExpiry')).props.children)).toContain(
      zh('memory.new.noExpiry'),
    );
    type(h, zh('memory.new.expiry'), '2026-12-24');
    expect(text(button(h, '到期').props.children)).toContain('12月24日');
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({ expires_at: new Date(2026, 11, 25).getTime() }),
      true,
      {},
    );
    find(
      h.value,
      (n) =>
        n.props.className === 'btn ghost sm' &&
        text(n.props.children) === zh('memory.new.noExpiry'),
    ).props.onClick();
    h.render();
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit.mock.calls.at(-1)![0]).not.toHaveProperty('expires_at');
  });

  it('keeps the dialog open and marks the field when the key or body is missing or saving fails', async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, error: 'Read current memory' }));
    const { h, onOpenChange } = open({ onSubmit });
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(labelled(h, zh('memory.new.text')).props['aria-invalid']).toBe(true);
    type(h, zh('memory.new.text'), 'Body');
    press(h, zh('memory.new.confirm'));
    expect(labelled(h, zh('memory.new.key')).props['aria-invalid']).toBe(true);
    type(h, zh('memory.new.key'), 'k');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toBe('Read current memory');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('confirms on ⌘↵', async () => {
    const { h, onSubmit } = open();
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    find(
      h.value,
      (n) => typeof n.props.onKeyDown === 'function' && n.type === 'div',
    ).props.onKeyDown({
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      preventDefault() {},
      nativeEvent: {},
    });
    await h.flush();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ key: 'k' }), true, {});
  });

  it('confirms on ⌘↵ in the tag field with the tag just typed', async () => {
    const { h, onSubmit } = open();
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    press(h, zh('memory.new.addTag'));
    type(h, zh('memory.new.tagInput'), 'refunds');
    let stopped = false;
    const event = {
      key: 'Enter',
      metaKey: true,
      ctrlKey: false,
      preventDefault() {},
      stopPropagation() {
        stopped = true;
      },
      nativeEvent: {},
    };
    labelled(h, zh('memory.new.tagInput')).props.onKeyDown(event);
    if (!stopped)
      find(
        h.value,
        (n) => typeof n.props.onKeyDown === 'function' && n.type === 'div',
      ).props.onKeyDown(event);
    await h.flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ tags: ['refunds'] }), true, {});
  });

  it('signs a proposal saved while the directory is read again with the signature it shows', async () => {
    mock.read = { refreshing: true };
    const { h, onSubmit } = open();
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ based_on: SIGNATURE }),
      true,
      {},
    );
  });

  it('saves nothing until the directory has been read', async () => {
    mock.directory = null;
    mock.read = { loading: true };
    const { h, onSubmit } = open();
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    expect(button(h, zh('memory.new.confirm')).props.disabled).toBe(true);
    press(h, zh('memory.new.confirm'));
    press(h, zh('memory.new.saveDraft'));
    await h.flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('commits the draft it already saved when confirming again, and replaces it once edited', async () => {
    const onSubmit = vi.fn(
      async (_input: MemoryProposal, _confirm: boolean, _options: SaveOptions) => ({
        ok: false as const,
        error: 'Proposal expired',
        id: 'memory-new',
        revision: 1,
      }),
    );
    const { h } = open({ onSubmit });
    type(h, zh('memory.new.text'), 'Body');
    type(h, zh('memory.new.key'), 'k');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit.mock.calls[0]![2]).toEqual({});
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit.mock.calls[1]![2]).toEqual({ draft: { id: 'memory-new', revision: 1 } });
    press(h, zh('memory.new.saveDraft'));
    await h.flush();
    expect(onSubmit.mock.calls[2]![2]).toEqual({ draft: { id: 'memory-new', revision: 1 } });
    type(h, zh('memory.new.text'), 'Body, edited');
    press(h, zh('memory.new.confirm'));
    await h.flush();
    expect(onSubmit.mock.calls[3]![2]).toEqual({ replaces: { id: 'memory-new', revision: 1 } });
  });

  it('replaces the draft it rewrites', async () => {
    const original: MemoryItem = {
      id: 'memory-draft',
      revision: 1,
      project_id: 'project-a',
      key: 'retry',
      kind: 'note',
      state: 'draft',
      authority: 'user',
      author: 'user',
      body_hash: 'b'.repeat(64),
      dependencies: [],
      based_on: SIGNATURE,
      created_at: 1,
      text: 'Double the wait each time.',
    };
    const { h, onSubmit } = open({ original });
    type(h, zh('memory.new.text'), 'Double the wait, at most six times.');
    press(h, zh('memory.new.saveDraft'));
    await h.flush();
    expect(onSubmit.mock.calls[0]![2]).toEqual({ replaces: { id: 'memory-draft', revision: 1 } });
  });

  it('offers every active memory to rest on, past the first page of the directory', async () => {
    mock.directory = { ...directory(), next_cursor: 'page-2' };
    const query = vi.fn(async (_method: string, params: Record<string, string>) => ({
      ok: true,
      value:
        params.cursor === 'page-2'
          ? {
              ...directory(),
              records: [{ ...directory().records![0]!, id: 'memory-old', title: 'Old rule' }],
              next_cursor: 'page-3',
            }
          : {
              ...directory(),
              records: [{ ...directory().records![0]!, id: 'memory-oldest', title: 'Oldest rule' }],
            },
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const { h } = open();
    labelled(h, zh('memory.new.kind')).props.onValueChange('note');
    h.render();
    await h.flush();
    expect(query.mock.calls.map(([, p]) => p.cursor)).toEqual(['page-2', 'page-3']);
    expect(query.mock.calls[0]![1]).toMatchObject({ project_id: 'project-a', state: 'active' });
    const titles = nodes(menu(h, zh('memory.new.dependencies')).props.children).map((n) =>
      text(n.props.children),
    );
    expect(titles).toEqual(expect.arrayContaining(['Old rule', 'Oldest rule']));
  });
});

describe('saving a memory', () => {
  const input = {
    project_id: 'project-a',
    key: 'k',
    kind: 'decision' as const,
    text: 'Body',
    dependencies: [],
  };
  it('proposes a draft, and commits it when confirming', async () => {
    const command = vi.fn(async (c: any) =>
      c.type === 'memory.propose'
        ? { ok: true, value: { id: 'memory-new', revision: 1 } }
        : { ok: true, value: { id: 'memory-new', revision: 2 } },
    );
    vi.stubGlobal('window', { pantheon: { command } });
    expect(await saveMemory(input, false)).toEqual({ ok: true, id: 'memory-new' });
    expect(command.mock.calls.map(([c]) => c.type)).toEqual(['memory.propose']);
    command.mockClear();
    expect(await saveMemory(input, true)).toEqual({ ok: true, id: 'memory-new' });
    expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
      ['memory.propose', input, null],
      ['memory.commit', { memory_id: 'memory-new' }, 1],
    ]);
  });

  it('reports a commit that fails after the draft was saved', async () => {
    const command = vi.fn(async (c: any) =>
      c.type === 'memory.propose'
        ? { ok: true, value: { id: 'memory-new', revision: 1 } }
        : { ok: false, error: { code: 'invalid_state', message: 'Proposal expired' } },
    );
    vi.stubGlobal('window', { pantheon: { command } });
    const outcome = await saveMemory(input, true);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ id: 'memory-new', revision: 1 });
  });

  it('commits a draft already saved without proposing it again', async () => {
    const command = vi.fn(async () => ({ ok: true, value: { id: 'memory-new', revision: 2 } }));
    vi.stubGlobal('window', { pantheon: { command } });
    const draft = { id: 'memory-new', revision: 1 };
    expect(await saveMemory(input, false, { draft })).toEqual({ ok: true, id: 'memory-new' });
    expect(command).not.toHaveBeenCalled();
    expect(await saveMemory(input, true, { draft })).toEqual({ ok: true, id: 'memory-new' });
    expect(command.mock.calls.map(([c]: any) => [c.type, c.input, c.expected_revision])).toEqual([
      ['memory.commit', { memory_id: 'memory-new' }, 1],
    ]);
  });

  it('discards the draft it replaces once the new draft is saved', async () => {
    const command = vi.fn(async (c: any) =>
      c.type === 'memory.propose'
        ? { ok: true, value: { id: 'memory-new', revision: 1 } }
        : c.type === 'memory.archive'
          ? { ok: false, error: { code: 'revision_conflict', message: 'Moved on' } }
          : { ok: true, value: { id: 'memory-new', revision: 2 } },
    );
    vi.stubGlobal('window', { pantheon: { command } });
    const replaces = { id: 'memory-draft', revision: 3 };
    expect(await saveMemory(input, true, { replaces })).toEqual({ ok: true, id: 'memory-new' });
    expect(command.mock.calls.map(([c]) => [c.type, c.input, c.expected_revision])).toEqual([
      ['memory.propose', input, null],
      ['memory.archive', { memory_id: 'memory-draft' }, 3],
      ['memory.commit', { memory_id: 'memory-new' }, 1],
    ]);
  });
});
