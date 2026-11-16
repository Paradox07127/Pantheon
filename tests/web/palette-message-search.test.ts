import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { SessionSearchHit, SessionSearchResult } from '@pantheon/protocol';
import { HookHost, deferred, find, named, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'palette' }),
);
import { CommandPalette } from '@/components/CommandPalette';
import type { PaletteItem } from '@/components/palette';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

type Props = Parameters<typeof CommandPalette>[0];

const message = (over: Partial<SessionSearchHit> = {}): SessionSearchHit =>
  ({
    session_id: 's1',
    project_id: 'p1',
    title: 'Refund fix',
    archived: false,
    at: '2026-11-01T00:00:00.000Z',
    excerpt: 'the gate fails',
    match: { start: 4, length: 4 },
    kind: 'message',
    turn_id: 't1',
    speaker: 'user',
    ...over,
  }) as SessionSearchHit;

const result = (hits: SessionSearchHit[], indexing_complete = true): SessionSearchResult => ({
  hits,
  indexing_complete,
});

function bridge(answer: (text: string) => Promise<SessionSearchResult> | SessionSearchResult) {
  return {
    query: vi.fn(async (_name: string, input: { text: string }) => ({
      ok: true,
      value: await answer(input.text),
    })),
  };
}

const classed = (n: ReactElement<any>, name: string) =>
  typeof n.props.className === 'string' && n.props.className.split(' ').includes(name);

function mount(pantheon: ReturnType<typeof bridge>, props: Partial<Props> = {}) {
  vi.useFakeTimers();
  vi.stubGlobal('window', { pantheon });
  vi.stubGlobal('document', { getElementById: () => null, activeElement: null });
  const given: Props = { open: true, onOpenChange() {}, items: [], ...props };
  const h = new HookHost(() => {
    const tree = CommandPalette(given);
    const body = named(tree, 'PaletteBody');
    return { tree, body: (body.type as (props: unknown) => ReactNode)(body.props) };
  });
  h.render();
  const input = () => find(h.value.body, (n) => n.type === 'input');
  const type = (value: string) => {
    input().props.onChange({ target: { value } });
    h.render();
  };
  const key = (k: string) => {
    input().props.onKeyDown({ key: k, nativeEvent: { isComposing: false }, preventDefault() {} });
    h.render();
  };
  const search = async (value: string) => {
    type(value);
    vi.advanceTimersByTime(150);
    await h.flush();
  };
  const all = () => nodes(h.value.body);
  const options = () => all().filter((n) => n.props.role === 'option');
  const has = (words: string) => all().some((n) => text(n) === words);
  return { h, type, key, search, all, options, has };
}

const part = (row: ReactElement<any>, name: string) => nodes(row).find((n) => classed(n, name))!;
const subs = (row: ReactElement<any>) => nodes(row).filter((n) => classed(n, 'cmdk-sub'));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('palette message search', () => {
  it('searches every session 150ms after typing stops and lists the messages under their own heading', async () => {
    const pantheon = bridge(() => result([message()]));
    const p = mount(pantheon, { items: [{ id: 'a1', group: 'action', label: 'Open', run() {} }] });
    p.type('gate');
    vi.advanceTimersByTime(149);
    expect(pantheon.query).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pantheon.query).toHaveBeenCalledWith('session.search', { text: 'gate', limit: '8' });
    await p.h.flush();
    expect(
      p
        .all()
        .filter((n) => classed(n, 'cmdk-gh'))
        .map(text),
    ).toEqual([zh('components.commandPalette.groupMessages')]);
    const row = p.options()[0]!;
    expect(text(part(row, 'cmdk-lb'))).toBe('the gate fails');
    expect(text(part(row, 'hit'))).toBe('gate');
    expect(part(row, 'hit').type).toBe('mark');
    expect(subs(row).map(text)).toEqual(['Refund fix']);
    expect(
      nodes(row).find((n) => n.props['aria-label'] === zh('components.commandPalette.byUser')),
    ).toBeDefined();
  });

  it('sends no search for one character or after > and #', () => {
    const pantheon = bridge(() => result([message()]));
    const p = mount(pantheon);
    for (const query of ['g', ' g ', '>gate', '#gate']) {
      p.type(query);
      vi.advanceTimersByTime(500);
    }
    expect(pantheon.query).not.toHaveBeenCalled();
  });

  it('leaves out title matches and shows branch matches with a branch icon', async () => {
    const pantheon = bridge(() =>
      result([
        message({ kind: 'title', excerpt: 'gate title', match: { start: 0, length: 4 } }),
        message({
          session_id: 's2',
          kind: 'branch',
          excerpt: 'fix/gate',
          match: { start: 4, length: 4 },
        }),
        message({ session_id: 's3', speaker: 'agent' }),
      ]),
    );
    const p = mount(pantheon);
    await p.search('gate');
    const rows = p.options();
    expect(rows.map((r) => text(part(r, 'cmdk-lb')))).toEqual(['fix/gate', 'the gate fails']);
    expect(
      nodes(rows[0]!).find((n) => n.props['aria-label'] === zh('components.commandPalette.branch')),
    ).toBeDefined();
    expect(nodes(rows[1]!).find((n) => n.props['aria-label'] === 'Agent')).toBeDefined();
  });

  it('folds line breaks into spaces and starts 16 characters before the match', async () => {
    const before = 'one two\n\nthree   four five six seven ';
    const pantheon = bridge(() =>
      result([
        message({ excerpt: `${before}gate\nfails`, match: { start: before.length, length: 4 } }),
      ]),
    );
    const p = mount(pantheon);
    await p.search('gate');
    const row = p.options()[0]!;
    expect(text(part(row, 'cmdk-lb'))).toBe('… five six seven gate fails');
    expect(text(part(row, 'hit'))).toBe('gate');
  });

  it('marks an archived session at the end of the row, where a shortcut would be', async () => {
    const pantheon = bridge(() =>
      result([message({ archived: true }), message({ session_id: 's2' })]),
    );
    const p = mount(pantheon);
    await p.search('gate');
    const [archived, live] = p.options();
    expect(subs(archived!).map(text)).toEqual(['Refund fix']);
    const cells = nodes(archived!.props.children);
    expect(text(cells.at(-1)!)).toBe(zh('components.commandPalette.archived'));
    expect(classed(cells.at(-1)!, 'cmdk-ht')).toBe(true);
    expect(nodes(live!).some((n) => classed(n, 'cmdk-ht'))).toBe(false);
  });

  it('opens the session of the chosen match and closes', async () => {
    const openProjectSession = vi.fn();
    const keep = useShell.getState().openProjectSession;
    useShell.setState({ openProjectSession });
    try {
      const onOpenChange = vi.fn();
      const pantheon = bridge(() => result([message({ project_id: 'p2', session_id: 's9' })]));
      const p = mount(pantheon, { onOpenChange });
      await p.search('gate');
      p.key('Enter');
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(openProjectSession).toHaveBeenCalledWith('p2', 's9');
    } finally {
      useShell.setState({ openProjectSession: keep });
    }
  });

  it('keeps the newer results when an older search answers later', async () => {
    const older = deferred<SessionSearchResult>();
    const newer = deferred<SessionSearchResult>();
    const pantheon = bridge((q) => (q === 'gat' ? older.promise : newer.promise));
    const p = mount(pantheon);
    p.type('gat');
    vi.advanceTimersByTime(150);
    p.type('gate');
    vi.advanceTimersByTime(150);
    newer.resolve(result([message({ excerpt: 'new gate', match: { start: 4, length: 4 } })]));
    await p.h.flush();
    older.resolve(result([message({ excerpt: 'old gat', match: { start: 4, length: 3 } })]));
    await p.h.flush();
    expect(p.options().map((r) => text(part(r, 'cmdk-lb')))).toEqual(['new gate']);
  });

  it('says the index is still being built in a line the arrow keys pass over', async () => {
    const pantheon = bridge(() => result([message(), message({ session_id: 's2' })], false));
    const items: PaletteItem[] = [{ id: 'a1', group: 'action', label: 'gate open', run() {} }];
    const p = mount(pantheon, { items });
    await p.search('gate');
    const note = zh('components.commandPalette.stillIndexing');
    expect(p.has(note)).toBe(true);
    expect(p.options().some((n) => text(n).includes(note))).toBe(false);
    const picked = () => p.options().findIndex((n) => n.props['aria-selected']);
    for (const expected of [1, 2, 0]) {
      p.key('ArrowDown');
      expect(picked()).toBe(expected);
    }
  });

  it('shows no empty state until the search answers, and shows it when nothing matched', async () => {
    const answer = deferred<SessionSearchResult>();
    const pantheon = bridge(() => answer.promise);
    const p = mount(pantheon, { onNewSession() {} });
    p.type('zzz');
    expect(p.has(zh('components.commandPalette.noResults'))).toBe(false);
    vi.advanceTimersByTime(150);
    await p.h.flush();
    expect(p.has(zh('components.commandPalette.noResults'))).toBe(false);
    answer.resolve(result([]));
    await p.h.flush();
    expect(p.has(zh('components.commandPalette.noResults'))).toBe(true);
  });
});
