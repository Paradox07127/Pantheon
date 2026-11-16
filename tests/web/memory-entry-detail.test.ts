import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem, MemorySummary } from '@pantheon/domain';
import { diffLines } from '@/lib/text-diff';
import { EntryDetail, type EntryDetailProps } from '@/screens/memory/EntryDetail';
import { find, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';

describe('line diff', () => {
  it('keeps unchanged lines and puts removed lines before the added ones', () => {
    expect(diffLines('keep\nold\ntail\n', 'keep\nnew one\nnew two\ntail\n')).toEqual([
      { kind: 'same', text: 'keep' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new one' },
      { kind: 'add', text: 'new two' },
      { kind: 'same', text: 'tail' },
    ]);
  });

  it('reads an empty text as no lines', () => {
    expect(diffLines('', 'only')).toEqual([{ kind: 'add', text: 'only' }]);
    expect(diffLines('gone', '')).toEqual([{ kind: 'del', text: 'gone' }]);
  });

  it('shows a change too large to line up as the removed lines, then the added ones', () => {
    const side = (mark: string) =>
      Array.from({ length: 1501 }, (_, i) => (i % 2 ? 'same' : `${mark}${i}`)).join('\n');
    const kinds = diffLines(side('a'), side('b')).map((line) => line.kind);
    expect(kinds).toEqual([...Array(1501).fill('del'), ...Array(1501).fill('add')]);
  });
});

const hour = 3_600_000;
// Noon today, so a minute earlier is still today whenever the test runs.
const now = new Date().setHours(12, 0, 0, 0);
const record = (id: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  revision: 1,
  project_id: 'pay',
  key: 'webhook-signature',
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
const summary = (id: string, extra: Partial<MemorySummary> = {}): MemorySummary => ({
  id,
  revision: 1,
  key: id,
  title: `Summary ${id}`,
  summary: '',
  tags: [],
  kind: 'report',
  state: 'active',
  authority: 'agent_reported',
  created_at: now,
  indexed: true,
  bytes: 10,
  ...extra,
});

const first = record('v1', { committed_at: now - 72 * hour, created_at: now - 72 * hour });
const second = record('v2', { committed_at: now - 48 * hour, created_at: now - 48 * hour });
const third = record('v3', {
  state: 'active',
  reason: undefined,
  committed_at: now - 60_000,
  created_at: now - 2 * hour,
  text: 'Read the **raw** body first.\n\n- keep it',
  reference_status: [
    { kind: 'file', uri: 'src/webhooks/signature.ts', status: 'changed' },
    { kind: 'file', uri: 'src/middleware/body.ts', status: 'unchanged' },
    { kind: 'url', uri: 'https://docs.example.com/signature', status: 'unverified' },
  ],
} as Partial<MemoryItem>);

const props = (extra: Partial<EntryDetailProps> = {}): EntryDetailProps => ({
  item: third,
  versions: [first, third, second],
  dependencies: [summary('review')],
  dependents: [
    summary('tolerance', {
      kind: 'decision',
      task: { lead_session_id: 'l', id: 'task-a', generation: 1 },
    }),
  ],
  tasks: [{ id: 'task-a', lead_session_id: 'l', title: 'Signature checks' }],
  footer: createElement('button', { type: 'button' }, 'footer action'),
  onOpen: () => {},
  onTag: () => {},
  onClose: () => {},
  ...extra,
});
const html = (p: EntryDetailProps) => renderToStaticMarkup(createElement(EntryDetail, p));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('memory entry detail', () => {
  it('heads a current entry with its kind, state, author, scope, key, version and commit time', () => {
    const out = html(props());
    expect(out).toContain(`aria-label="${zh('memory.detail.label')}"`);
    expect(out).toContain(`aria-label="${zh('memory.detail.close')}"`);
    const text = plain(out);
    expect(text).toContain('Title v3');
    for (const chip of [
      zh('memory.detail.kind.decision'),
      zh('memory.detail.state.active'),
      zh('memory.detail.byUser'),
      zh('memory.detail.project'),
    ])
      expect(text).toContain(chip);
    expect(text).toContain('webhook-signature');
    expect(text).toContain('第 3 版');
    expect(text).toMatch(/今天 \d\d:\d\d/);
  });

  it('renders the body as markdown', () => {
    const out = html(props());
    expect(out).toContain('<strong>raw</strong>');
    expect(out).toContain('<li>keep it</li>');
  });

  it('lists sources with their checked state', () => {
    const text = plain(html(props()));
    expect(text).toContain('来源 3');
    expect(text).toMatch(/src\/webhooks\/signature\.ts 已变/);
    expect(text).toMatch(/src\/middleware\/body\.ts 未变/);
    expect(text).toMatch(/docs\.example\.com\/signature 未核实/);
  });

  it('lists what it rests on with the author and what rests on it with the task', () => {
    const text = plain(html(props()));
    expect(text).toMatch(/依据 1 Summary review agent 报告/);
    expect(text).toMatch(/被这些依据 1 Summary tolerance Signature checks/);
  });

  it('numbers committed versions newest first and marks the one being read', () => {
    const out = html(props());
    const text = plain(out);
    expect(text).toMatch(/版本 3 第 3 版 当前 .*第 2 版 被替代 .*第 1 版 被替代/);
    expect(out).toMatch(/aria-current="true"[^>]*>(?:<[^>]+>)*第 3 版/);
    expect(out.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it('opens a related entry or version and closes from the head', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const tree = EntryDetail(props({ onOpen, onClose }));
    find(tree, (n) => n.props['aria-label'] === zh('memory.detail.close')).props.onClick();
    expect(onClose).toHaveBeenCalled();
    find(tree, (n) => n.props['data-id'] === 'tolerance').props.onClick();
    find(tree, (n) => n.props['data-id'] === 'v2').props.onClick();
    expect(onOpen.mock.calls).toEqual([['tolerance'], ['v2']]);
  });

  it('shows the summary and the tags, and a tag sets the list filter to it', () => {
    const onTag = vi.fn();
    const p = props({
      item: { ...third, summary: 'Verify against the raw body', tags: ['webhook', 'safety'] },
      onTag,
    });
    expect(plain(html(p))).toContain('Verify against the raw body');
    const group = find(
      EntryDetail(p),
      (n) => n.props.role === 'group' && n.props['aria-label'] === zh('memory.detail.tags'),
    );
    const chips = nodes(group).filter((n) => n.type === 'button');
    expect(chips.map((n) => text(n.props.children))).toEqual(['webhook', 'safety']);
    expect(chips.map((n) => n.props['aria-label'])).toEqual([
      zhf('memory.detail.filterTag', { tag: 'webhook' }),
      zhf('memory.detail.filterTag', { tag: 'safety' }),
    ]);
    chips[1]!.props.onClick();
    expect(onTag).toHaveBeenCalledWith('safety');
  });

  it('leaves out the summary and tags of an entry that has none', () => {
    const out = html(props({ item: { ...third, summary: '', tags: [] } }));
    expect(out).not.toContain(`aria-label="${zh('memory.detail.tags')}"`);
  });

  it('puts the footer at the end of the panel', () => {
    expect(html(props())).toMatch(/footer action<\/button><\/div><\/aside>$/);
  });

  it('compares a draft with the current version instead of showing its body', () => {
    const current = record('v2', {
      state: 'active',
      reason: undefined,
      text: 'Store keys in Redis.\nKeep them 24 hours.\nWrite with SET NX.',
    });
    const draft = record('d1', {
      state: 'draft',
      reason: undefined,
      authority: 'agent_reported',
      author_session_id: 'sess',
      committed_at: undefined,
      created_at: now - 60_000,
      based_on: '3f9a1c2e'.padEnd(64, '0'),
      text: 'Store keys in Redis.\nKeep them 72 hours.\nWrite with SET NX.',
    });
    const out = html(
      props({
        item: draft,
        versions: [first, current, draft],
        signature: '3f9a1c2e'.padEnd(64, '0'),
        author: { title: 'Refund idempotency', runtime: 'codex' },
      }),
    );
    const text = plain(out);
    expect(text).toContain(zh('memory.detail.state.draft'));
    expect(text).toMatch(/提出 .*Refund idempotency \d\d:\d\d/);
    expect(text).toMatch(/基于 第 2 版 3f9a1c2e .*仍是最新/);
    expect(text).toContain('和第 2 版比');
    expect(text).toMatch(
      /Store keys in Redis\. − Keep them 24 hours\. \+ Keep them 72 hours\. Write with SET NX\./,
    );
    expect(text).toMatch(/版本 3 草稿 待确认 .*第 2 版 当前 .*第 1 版 被替代/);
    expect(out).not.toContain('<div class="md">');
  });

  it('says when the directory moved on since a draft was proposed', () => {
    const draft = record('d1', { state: 'draft', reason: undefined, committed_at: undefined });
    const text = plain(
      html(props({ item: draft, versions: [draft, third], signature: 'c'.repeat(64) })),
    );
    expect(text).toContain(zh('memory.detail.notLatest'));
    expect(text).not.toContain(zh('memory.detail.latest'));
  });
});
