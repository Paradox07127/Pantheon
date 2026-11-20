import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '@pantheon/domain';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog/index.mjs';
import { toastManager } from '@/components/Toast';
import {
  EntryActions,
  retractedToast,
  type EntryActionsProps,
} from '@/screens/memory/EntryActions';
import { PendingCard, type PendingCardProps } from '@/screens/memory/PendingCard';
import { find, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const hour = 3_600_000;
// Noon today, so a minute earlier is still today whenever the test runs.
const now = new Date().setHours(12, 0, 0, 0);
const record = (id: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  revision: 1,
  project_id: 'pay',
  key: 'idempotency-store',
  title: `Title ${id}`,
  kind: 'decision',
  state: 'archived',
  reason: 'superseded',
  authority: 'user',
  author: 'user',
  body_hash: 'h',
  dependencies: [],
  based_on: 'b'.repeat(64),
  created_at: now - 50 * hour,
  committed_at: now - 50 * hour,
  text: 'old body',
  ...extra,
});
const first = record('v1', {
  committed_at: now - 72 * hour,
  superseded_by: 'v2',
  archived_at: now - 60_000,
});
const second = record('v2', {
  state: 'active',
  reason: undefined,
  committed_at: now - 48 * hour,
  text: 'Store keys in Redis.\nKeep them 24 hours.\nWrite with SET NX.',
});
const draft = record('d1', {
  state: 'draft',
  reason: undefined,
  committed_at: undefined,
  authority: 'agent_reported',
  author_session_id: 'sess',
  created_at: now - 60_000,
  based_on: '3f9a1c2e'.padEnd(64, '0'),
  text: 'Store keys in Redis.\nKeep them 72 hours.\nWrite with SET NX.',
});

const plain = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const actionProps = (extra: Partial<EntryActionsProps> = {}): EntryActionsProps => ({
  item: second,
  versions: [first, second, draft],
  onCommit: vi.fn(),
  onDiscard: vi.fn(),
  onRewrite: vi.fn(),
  onRetract: vi.fn(),
  onRestore: vi.fn(),
  onOpen: vi.fn(),
  ...extra,
});
const actionsHtml = (p: EntryActionsProps) => renderToStaticMarkup(createElement(EntryActions, p));
const button = (tree: ReturnType<typeof EntryActions>, label: string) =>
  find(tree, (n) => n.type === 'button' && plain(renderToStaticMarkup(n)).trim() === label);

describe('memory entry actions', () => {
  it('offers to confirm or discard a draft', () => {
    const p = actionProps({ item: draft });
    const out = actionsHtml(p);
    expect(plain(out).trim()).toBe(
      `${zh('memory.actions.commit')} ${zh('memory.actions.discard')}`,
    );
    expect(out).toMatch(/class="btn pri"[^>]*>(?:<svg[\s\S]*?<\/svg>)?确认生效/);
    expect(out).toMatch(/class="btn ghost dng"[^>]*>丢弃/);
    const tree = EntryActions(p);
    button(tree, zh('memory.actions.commit')).props.onClick();
    expect(p.onCommit).toHaveBeenCalled();
  });

  it('asks in an alert dialog before discarding a draft', () => {
    const p = actionProps({ item: draft });
    const tree = EntryActions(p);
    const root = find(tree, (n) => n.type === AlertDialog.Root);
    const opener = find(root, (n) => n.type === AlertDialog.Trigger);
    expect(text(opener)).toBe(zh('memory.actions.discard'));
    expect(text(find(root, (n) => n.type === AlertDialog.Title))).toBe(
      zh('overlays.confirm.discardTitle').replace('{title}', draft.title!),
    );
    expect(p.onDiscard).not.toHaveBeenCalled();
    find(
      root,
      (n) => n.type === AlertDialog.Close && n.props.className === 'btn dng',
    ).props.onClick();
    expect(p.onDiscard).toHaveBeenCalled();
  });

  it('offers to rewrite or retract the current version', () => {
    const p = actionProps();
    const out = actionsHtml(p);
    expect(plain(out).trim()).toBe(
      `${zh('memory.actions.rewrite')} ${zh('memory.actions.retract')}`,
    );
    expect(out).toMatch(/class="btn"[^>]*>改写/);
    expect(out).toMatch(/class="btn ghost"[^>]*>撤回/);
    const tree = EntryActions(p);
    button(tree, zh('memory.actions.rewrite')).props.onClick();
    button(tree, zh('memory.actions.retract')).props.onClick();
    expect(p.onRewrite).toHaveBeenCalled();
    expect(p.onRetract).toHaveBeenCalled();
  });

  it('says which version replaced an archived one and offers to restore it as a draft', () => {
    const p = actionProps({ item: first });
    const out = actionsHtml(p);
    expect(plain(out)).toMatch(/被第 2 版替代 \d\d:\d\d/);
    expect(plain(out)).toMatch(/恢复为草稿 要再确认一次才生效 *$/);
    const tree = EntryActions(p);
    button(tree, '被第 2 版替代').props.onClick();
    button(tree, zh('memory.actions.restore')).props.onClick();
    expect(p.onOpen).toHaveBeenCalledWith('v2');
    expect(p.onRestore).toHaveBeenCalled();
  });

  it('names the other reasons an entry was archived', () => {
    const reason = (r: MemoryItem['reason']) =>
      plain(actionsHtml(actionProps({ item: record('x', { reason: r, archived_at: now }) })));
    expect(reason('retracted')).toContain(zh('memory.actions.byYou'));
    expect(reason('expired')).toContain(zh('memory.actions.expired'));
    expect(reason('stale')).toContain(zh('memory.actions.stale'));
  });

  it('disables every action while one runs', () => {
    const out = actionsHtml(actionProps({ busy: true }));
    expect(out.match(/<button/g)).toHaveLength(2);
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe('retract notice', () => {
  afterEach(() => toastManager.close());

  it('names the retracted entry and offers to undo', () => {
    const add = vi.spyOn(toastManager, 'add');
    const undo = vi.fn();
    retractedToast('Keep keys 72 hours', 0, undo);
    const notice = add.mock.calls[0]![0];
    expect(notice.title).toBe('已撤回「Keep keys 72 hours」');
    expect(notice.actionProps!.children).toBe(zh('memory.actions.undo'));
    (notice.actionProps!.onClick as () => void)();
    expect(undo).toHaveBeenCalledOnce();
    add.mockRestore();
  });

  it('counts the entries archived with the retracted one', () => {
    const add = vi.spyOn(toastManager, 'add');
    retractedToast('Keep keys 72 hours', 2, vi.fn());
    expect(add.mock.calls[0]![0].title).toBe('已撤回「Keep keys 72 hours」和依据它的 2 条');
    add.mockRestore();
  });
});

const cardProps = (extra: Partial<PendingCardProps> = {}): PendingCardProps => ({
  item: draft,
  versions: [first, second, draft],
  signature: '3f9a1c2e'.padEnd(64, '0'),
  author: { title: 'Refund idempotency', runtime: 'codex' },
  onCommit: vi.fn(),
  onDiscard: vi.fn(),
  onOpen: vi.fn(),
  onRewrite: vi.fn(),
  onOpenSession: vi.fn(),
  ...extra,
});
const cardHtml = (p: PendingCardProps) => renderToStaticMarkup(createElement(PendingCard, p));
// A runtime glyph's title comes before the label.
const cardButton = (tree: ReturnType<typeof PendingCard>, label: string) =>
  find(
    tree,
    (n) =>
      n.type === 'button' &&
      plain(renderToStaticMarkup(n))
        .trim()
        .replace(/^Codex /, '') === label,
  );

describe('pending memory card', () => {
  it('heads the draft with its kind, title, key and pending state', () => {
    const out = cardHtml(cardProps());
    expect(out).toContain(`aria-label="${zh('memory.pending.kind.decision')}"`);
    expect(plain(out)).toMatch(/^ Title d1 idempotency-store 待确认 /);
  });

  it('says who proposed it, which version it rests on and whether that is still the latest', () => {
    const text = plain(cardHtml(cardProps()));
    expect(text).toMatch(/Refund idempotency \d\d:\d\d 基于第 2 版 3f9a1c2e 仍是最新/);
    const stale = plain(cardHtml(cardProps({ signature: '8b07d4e1'.padEnd(64, '0') })));
    expect(stale).toContain(zh('memory.pending.notLatest'));
  });

  it('shows the line diff against the current version', () => {
    const out = cardHtml(cardProps());
    expect(plain(out)).toMatch(
      /Store keys in Redis\. − Keep them 24 hours\. \+ Keep them 72 hours\. Write with SET NX\./,
    );
    expect(out).toContain('data-kind="del"');
    expect(out).toContain('data-kind="add"');
  });

  it('confirms, discards or opens the details', () => {
    const p = cardProps();
    expect(plain(cardHtml(p))).toMatch(/确认生效 丢弃 打开详情 $/);
    const tree = PendingCard(p);
    cardButton(tree, zh('memory.pending.commit')).props.onClick();
    cardButton(tree, zh('memory.pending.open')).props.onClick();
    expect(p.onCommit).toHaveBeenCalled();
    expect(p.onOpen).toHaveBeenCalled();
  });

  it.each([
    ['a draft', {}],
    ['a draft whose sources changed', { rejected: true }],
    ['a draft over the budget', { overBudget: { largest_records: [] } }],
  ] as [string, Partial<PendingCardProps>][])(
    'asks in an alert dialog before discarding %s',
    (_name, extra) => {
      const p = cardProps(extra);
      const root = find(PendingCard(p), (n) => n.type === AlertDialog.Root);
      const opener = find(root, (n) => n.type === AlertDialog.Trigger);
      expect(text(opener)).toBe(zh('memory.pending.discard'));
      expect(text(find(root, (n) => n.type === AlertDialog.Title))).toBe(
        zh('overlays.confirm.discardTitle').replace('{title}', draft.title!),
      );
      expect(p.onDiscard).not.toHaveBeenCalled();
      find(
        root,
        (n) => n.type === AlertDialog.Close && n.props.className === 'btn dng',
      ).props.onClick();
      expect(p.onDiscard).toHaveBeenCalled();
    },
  );

  it('explains a commit refused because the sources changed and offers to open the proposing session', () => {
    const p = cardProps({ rejected: true, signature: '8b07d4e1'.padEnd(64, '0') });
    const out = cardHtml(p);
    expect(out).toContain('role="alert"');
    const text = plain(out);
    expect(text).toContain(zh('memory.pending.sourcesChanged'));
    expect(text).toMatch(/3f9a1c2e .*8b07d4e1/);
    expect(text).toMatch(/打开Refund idempotency 自己改写 丢弃 $/);
    expect(text).not.toContain(zh('memory.pending.commit'));
    const tree = PendingCard(p);
    cardButton(tree, '打开Refund idempotency').props.onClick();
    cardButton(tree, zh('memory.pending.rewrite')).props.onClick();
    expect(p.onOpenSession).toHaveBeenCalled();
    expect(p.onRewrite).toHaveBeenCalled();
  });

  it('leaves out the session button when no session proposed the draft', () => {
    const text = plain(cardHtml(cardProps({ rejected: true, author: undefined })));
    expect(text).not.toContain('打开');
    expect(text).toMatch(/自己改写 丢弃 $/);
  });
});
