import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryGraph } from '@pantheon/domain';
import type { EntryItem } from '@/screens/memory/EntryDetail';
import {
  GraphDetailView,
  graphRelations,
  type GraphDetailViewProps,
} from '@/screens/memory/GraphDetail';
import { find, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

// Noon today, so a minute earlier is still today whenever the test runs.
const now = new Date().setHours(12, 0, 0, 0);

const nodes: MemoryGraph['nodes'] = [
  { id: 'center', label: 'Dedupe by request key', kind: 'decision', state: 'active' },
  { id: 'basis', label: 'Incident review', kind: 'report', state: 'active' },
  { id: 'old', label: 'Dedupe by order', kind: 'decision', state: 'archived' },
  { id: 'load', label: 'Load test', kind: 'report', state: 'active' },
  { id: 'replay', label: 'Replay test', kind: 'report', state: 'draft' },
  { id: 'loose', label: 'Unrelated note', kind: 'note', state: 'active' },
  {
    id: 'source:file',
    label: 'dedupe.ts',
    kind: 'source',
    source_kind: 'file',
    uri: 'packages/pay/src/dedupe.ts',
  },
  {
    id: 'source:url',
    label: 'Key guide',
    kind: 'source',
    source_kind: 'url',
    uri: 'https://docs.example.com/keys',
  },
  {
    id: 'session:s1',
    label: 'Review session',
    kind: 'source',
    source_kind: 'session',
    uri: 'session:s1',
  },
];
const edge = (from: string, to: string, kind: MemoryGraph['edges'][number]['kind']) => ({
  id: `${from}-${kind}-${to}`,
  from,
  to,
  kind,
});
const edges: MemoryGraph['edges'] = [
  edge('center', 'basis', 'depends_on'),
  edge('load', 'center', 'depends_on'),
  edge('replay', 'center', 'depends_on'),
  edge('center', 'old', 'supersedes'),
  edge('center', 'source:file', 'source'),
  edge('center', 'source:url', 'source'),
  edge('center', 'session:s1', 'source'),
  edge('loose', 'basis', 'depends_on'),
  edge('loose', 'source:file', 'source'),
];

const item = {
  id: 'center',
  revision: 2,
  project_id: 'pay',
  key: 'refund.dedupe',
  title: 'Dedupe by request key',
  summary: 'One refund per request key.',
  kind: 'decision',
  state: 'active',
  authority: 'user',
  author: 'user',
  body_hash: 'h',
  dependencies: ['basis'],
  based_on: 'b'.repeat(64),
  created_at: now - 3_600_000,
  committed_at: now - 60_000,
  version: 2,
  text: 'body',
  reference_status: [
    { kind: 'file', uri: 'packages/pay/src/dedupe.ts', status: 'unchanged' },
    { kind: 'url', uri: 'https://docs.example.com/keys', status: 'unverified' },
  ],
} as EntryItem;

const props = (extra: Partial<GraphDetailViewProps> = {}): GraphDetailViewProps => ({
  memoryId: 'center',
  nodes,
  edges,
  item,
  error: null,
  onRetry: () => {},
  onFocus: () => {},
  onOpenEntry: () => {},
  onClose: () => {},
  ...extra,
});
const html = (p: GraphDetailViewProps) => renderToStaticMarkup(createElement(GraphDetailView, p));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('memory graph relations', () => {
  it('reads what the memory rests on, what rests on it, what it replaced and its sources', () => {
    const r = graphRelations('center', nodes, edges);
    expect(r.dependencies.map((n) => n.id)).toEqual(['basis']);
    expect(r.dependents.map((n) => n.id)).toEqual(['load', 'replay']);
    expect(r.replaced.map((n) => n.id)).toEqual(['old']);
    expect(r.sources.map((n) => n.id)).toEqual(['source:file', 'source:url', 'session:s1']);
  });
});

describe('memory graph detail', () => {
  it('heads the memory with its kind, state, confirmation, summary, key, version and time', () => {
    const out = html(props());
    expect(out).toContain(`aria-label="${zh('memory.graphSide.label')}"`);
    expect(out).toContain(`aria-label="${zh('memory.graphSide.close')}"`);
    const text = plain(out);
    expect(text).toContain('Dedupe by request key');
    expect(text).toMatch(/决定 当前 用户确认/);
    expect(text).toContain('One refund per request key.');
    expect(text).toMatch(/键 refund\.dedupe 版本 2 确认 今天 \d\d:\d\d/);
  });

  it('shows the version the memory carries, not its revision', () => {
    const edited = { ...item, revision: 9, version: 5 } as EntryItem;
    expect(plain(html(props({ item: edited })))).toMatch(/键 refund\.dedupe 版本 5 确认/);
  });

  it('leaves the version out for a memory that carries none', () => {
    const draft = { ...item, state: 'draft', committed_at: undefined, version: undefined };
    expect(plain(html(props({ item: draft as EntryItem })))).not.toContain(
      zh('memory.graphSide.version'),
    );
  });

  it('groups the relations with their counts, and marks a replaced memory archived', () => {
    const text = plain(html(props()));
    expect(text).toMatch(/它依据的 1 Incident review /);
    expect(text).toMatch(/依据它的 2 Load test Replay test /);
    expect(text).toMatch(/它替代的 1 Dedupe by order 已归档 /);
    expect(text).not.toContain('Unrelated note');
  });

  it('lists sources by full path with their checked state', () => {
    const text = plain(html(props()));
    expect(text).toMatch(
      /来源 3 packages\/pay\/src\/dedupe\.ts 未变 docs\.example\.com\/keys 未核实 Review session /,
    );
    for (const [status, word] of [
      ['changed', zh('memory.graphSide.source.changed')],
      ['unversioned', zh('memory.graphSide.source.unversioned')],
      ['unavailable', zh('memory.graphSide.source.unavailable')],
    ]) {
      const changed = {
        ...item,
        reference_status: [{ kind: 'file', uri: 'packages/pay/src/dedupe.ts', status }],
      } as EntryItem;
      expect(plain(html(props({ item: changed })))).toContain(`dedupe.ts ${word}`);
    }
  });

  it('focuses a related node, opens the entry and closes from the head', () => {
    const onFocus = vi.fn();
    const onOpenEntry = vi.fn();
    const onClose = vi.fn();
    const tree = GraphDetailView(props({ onFocus, onOpenEntry, onClose }));
    for (const id of ['basis', 'replay', 'old', 'source:file'])
      find(tree, (n) => n.props['data-id'] === id).props.onClick();
    expect(onFocus.mock.calls).toEqual([['basis'], ['replay'], ['old'], ['source:file']]);
    find(tree, (n) => n.props['aria-label'] === zh('memory.graphSide.close')).props.onClick();
    expect(onClose).toHaveBeenCalled();
    find(
      tree,
      (n) => n.type === 'button' && text(n) === zh('memory.graphSide.open'),
    ).props.onClick();
    expect(onOpenEntry).toHaveBeenCalledWith('center');
  });

  it('puts the open entry button in the footer at the end of the panel', () => {
    expect(html(props())).toMatch(/打开条目<\/button><\/div><\/aside>$/);
  });

  it('shows skeletons in place of the head facts while the memory reads', () => {
    const out = html(props({ item: null }));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('class="skel');
    expect(plain(out)).toContain('Dedupe by request key');
    expect(plain(out)).not.toContain('refund.dedupe');
  });

  it('shows a read failure in the panel with a retry', () => {
    const onRetry = vi.fn();
    const p = props({ item: null, error: 'daemon offline', onRetry });
    const out = html(p);
    expect(out).toContain('role="alert"');
    expect(plain(out)).toMatch(/读不到这条记忆 daemon offline 重试/);
    expect(out).not.toContain('aria-busy');
    find(
      GraphDetailView(p),
      (n) => n.type === 'button' && text(n).includes(zh('memory.graphSide.retry')),
    ).props.onClick();
    expect(onRetry).toHaveBeenCalled();
  });
});
