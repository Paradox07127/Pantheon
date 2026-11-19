import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import {
  closeNotice,
  noticeNeeds,
  noticeResult,
  toast,
  toastManager,
} from '../../apps/web/src/components/Toast.js';
import { useShell } from '../../apps/web/src/store.js';
import { Clip } from '../../apps/web/src/components/Clip.js';
import { zh } from './i18n-setup.js';
import { mount, named, nodes, text } from './web-hook-host.js';
import { mountToastStore } from './web-toast-store.js';

const NOW = Date.UTC(2026, 10, 13, 9);
const openLabel = zh('components.noticeCard.open');

// The stylesheet with the space around its punctuation taken out.
const css = () =>
  readFileSync(
    path.resolve(import.meta.dirname, '../../apps/web/src/components/notice-card.css'),
    'utf8',
  )
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/\s+/g, ' ');

let mounted: ReturnType<typeof mountToastStore>;
const shell = useShell.getState();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('document', { activeElement: null });
  mounted = mountToastStore();
});
afterEach(() => {
  toastManager.close();
  mounted.stop();
  useShell.setState(shell);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const byClass = (name: string) =>
  mounted.items().filter((n) => String(n.props.className ?? '').split(' ')[0] === name);
const buttons = () =>
  mounted
    .items()
    .filter((n) => n.type === 'button')
    .map((n) => [text(n), n.props.className]);

describe('notice cards', () => {
  it('draws a card that needs the user with the session, what it waits for, the command and its buttons', () => {
    noticeNeeds({
      heading: 'payments-webhook',
      event: 'waiting for approval',
      command: 'pnpm db:migrate --env staging',
      actions: [
        { label: 'Allow once', run() {}, primary: true },
        { label: 'Reject', run() {} },
      ],
      open() {},
    });
    expect(byClass('nc-mark').map((n) => n.props['data-mark'])).toEqual(['wait']);
    expect(byClass('nc-name').map(text)).toEqual(['payments-webhook']);
    expect(byClass('nc-event').map(text)).toEqual(['waiting for approval']);
    expect(byClass('nc-cmd').map(text)).toEqual(['pnpm db:migrate --env staging']);
    expect(buttons()).toEqual([
      ['Allow once', 'btn sm pri'],
      ['Reject', 'btn sm'],
      [openLabel, 'btn sm ghost nc-open'],
    ]);
    expect(byClass('nc-hit')).toEqual([]);
  });

  it('keeps the whole session, what it waits for and the command of a card behind one-line clips', () => {
    noticeNeeds({
      heading: 'payments-webhook',
      event: 'waiting for approval',
      command: 'pnpm db:migrate --env staging',
      open() {},
    });
    const clips = mounted.items().filter((n) => n.type === Clip);
    expect(clips.map((n) => [n.props.text, n.props.lines ?? 1])).toEqual([
      ['payments-webhook', 1],
      ['waiting for approval', 1],
      ['pnpm db:migrate --env staging', 1],
    ]);
  });

  it('keeps the whole summary of a card and the command of a result behind one-line clips', () => {
    noticeNeeds({ heading: 'lead', event: 'asks you', summary: 'Should refunds be partial?' });
    noticeResult({
      heading: 'ledger-report',
      event: 'checks failed',
      tone: 'failed',
      command: 'pnpm test:integration',
      summary: '2 failing',
    });
    const clips = mounted.items().filter((n) => n.type === Clip);
    expect(clips.map((n) => [n.props.text, n.props.lines ?? 1])).toEqual([
      ['ledger-report', 1],
      ['checks failed', 1],
      ['pnpm test:integration', 1],
      ['lead', 1],
      ['asks you', 1],
      ['Should refunds be partial?', 1],
    ]);
  });

  it('keeps a card that needs the user, without a countdown, until it is closed by its id', () => {
    const id = noticeNeeds({
      id: 'approval-7',
      heading: 'lead',
      event: 'asks you',
      summary: 'Should partial refunds get their own endpoint?',
      open() {},
    });
    expect(id).toBe('approval-7');
    expect(byClass('nc-text').map(text)).toEqual([
      'Should partial refunds get their own endpoint?',
    ]);
    expect(buttons()).toEqual([[openLabel, 'btn sm']]);
    vi.advanceTimersByTime(60 * 60_000);
    expect(mounted.shown()).toEqual(['lead']);
    expect(byClass('toast-life')).toEqual([]);
    closeNotice(id);
    expect(mounted.shown()).toEqual([]);
  });

  it('runs a button on a card and closes the card', () => {
    const allow = vi.fn();
    noticeNeeds({
      heading: 'payments-webhook',
      event: 'waiting for approval',
      actions: [{ label: 'Allow once', run: allow, primary: true }],
    });
    const [button] = mounted.items().filter((n) => n.type === 'button');
    button!.props.onClick();
    expect(allow).toHaveBeenCalledOnce();
    expect(mounted.shown()).toEqual([]);
  });

  it('shows how long a card has waited, in whole minutes, as time goes on', () => {
    noticeNeeds({ heading: 'lead', event: 'asks you', since: NOW - 2 * 60_000 });
    const waited = named(mounted.tree(), 'NoticeWaited');
    const h = mount(() => (waited.type as (props: object) => unknown)(waited.props));
    expect(text(h.value as never)).toBe('等了 2 分');
    vi.advanceTimersByTime(60_000);
    h.render();
    expect(text(h.value as never)).toBe('等了 3 分');
    h.unmount();
  });

  it('puts how long a card has waited after what it waits for, as separate elements', () => {
    noticeNeeds({ heading: 'lead', event: 'waiting for approval', since: NOW - 19 * 60_000 });
    const items = mounted.items();
    const event = items.findIndex((n) => n.type === Clip && text(n) === 'waiting for approval');
    const waited = items.findIndex(
      (n) => typeof n.type === 'function' && n.type.name === 'NoticeWaited',
    );
    expect(event).toBeGreaterThan(-1);
    expect(waited).toBeGreaterThan(event);
    expect(nodes(items[event]).map((n) => n.type)).toEqual([Clip]);
  });

  it('opens where a result card points when the card is pressed', () => {
    const open = vi.fn();
    noticeResult({
      heading: 'refund-list',
      event: 'ready for review',
      tone: 'review',
      diff: { additions: 184, deletions: 0 },
      open,
    });
    expect(byClass('nc-mark').map((n) => n.props['data-mark'])).toEqual(['review']);
    const counts = named(mounted.tree(), 'DiffCounts');
    expect(counts.props).toEqual({ additions: 184, deletions: 0 });
    expect(text(counts)).toBe('+184 −0');
    const [hit] = byClass('nc-hit');
    expect(hit?.props['aria-label']).toBe('打开refund-list');
    hit!.props.onClick();
    expect(open).toHaveBeenCalledOnce();
    expect(mounted.shown()).toEqual([]);
  });

  it('closes a result after five seconds and a failure after ten, each over a countdown line', () => {
    noticeResult({ heading: 'refund-api', event: 'turn finished', tone: 'done' });
    noticeResult({
      heading: 'ledger-report',
      event: 'checks failed',
      tone: 'failed',
      command: 'pnpm test:integration',
      summary: '2 failing',
      actions: [{ label: 'See failures', run() {} }],
    });
    expect(byClass('nc-mark').map((n) => n.props['data-mark'])).toEqual(['failed', 'done']);
    expect(byClass('nc-code').map(text)).toEqual(['pnpm test:integration']);
    expect(byClass('nc-note').map(text)).toEqual(['2 failing']);
    expect(byClass('toast-life').map((n) => n.props.style)).toEqual([
      { animationDuration: '10000ms' },
      { animationDuration: '5000ms' },
    ]);
    vi.advanceTimersByTime(5000);
    expect(mounted.shown()).toEqual(['ledger-report']);
    vi.advanceTimersByTime(5000);
    expect(mounted.shown()).toEqual([]);
  });

  it('folds the notices past three into a button that opens the needs-you queue', () => {
    const openSessionGroup = vi.fn();
    useShell.setState({ openSessionGroup });
    for (const title of ['one', 'two', 'three', 'four', 'five']) toast({ title });
    const more = mounted.items().find((n) => n.type === 'button' && text(n) === '还有 2 条');
    expect(more?.props.className).toBe('btn sm toast-more');
    more!.props.onClick();
    expect(openSessionGroup).toHaveBeenCalledWith('inbox');
  });

  it('hides the cards that need the user while a dialog scrim is open, and keeps the results over it', () => {
    noticeNeeds({ id: 'approval-7', heading: 'lead', event: 'asks you' });
    noticeResult({ heading: 'refund-api', event: 'turn finished', tone: 'done' });
    noticeResult({ heading: 'ledger-report', event: 'checks failed', tone: 'failed' });
    const roots = mounted.items().filter((n) => n.props.toast);
    expect(roots.map((n) => [n.props.toast.title, n.props.toast.type])).toEqual([
      ['ledger-report', 'failure'],
      ['refund-api', 'result'],
      ['lead', 'needs'],
    ]);
    const toastCss = readFileSync(
      path.resolve(import.meta.dirname, '../../apps/web/src/components/toast.css'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(toastCss).toMatch(
      /:root\[data-scrim-open\] \.toast\[data-type='needs'\] \{ display: none; \}/,
    );
    // Every modal dialog's backdrop is a scrim the rule above sees.
    const src = path.resolve(import.meta.dirname, '../../apps/web/src');
    const backdrops = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        [
          ...readFileSync(path.join(src, file), 'utf8').matchAll(/Backdrop className="([^"]*)"/g),
        ].map((m) => m[1]!),
      );
    expect(backdrops.length).toBeGreaterThan(0);
    expect(backdrops.filter((name) => !name.endsWith('-scrim'))).toEqual([]);
  });

  it('lays a card out as its mark beside its lines, filled under the pointer only where the whole card opens', () => {
    expect(css()).toMatch(/\.nc\{[^}]*grid-template-columns:14px minmax\(0,1fr\)/);
    expect(css()).toMatch(/\.nc\{[^}]*padding:var\(--sp-3\)/);
    expect(css()).toMatch(/\.nc:has\(\.nc-hit:hover\)\{background:var\(--sf2\);?\}/);
    expect(css()).not.toContain('shadow');
  });
});
