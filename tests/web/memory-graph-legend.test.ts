import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemoryGraph } from '@pantheon/domain';
import { GraphLegend, legendKinds, type GraphLegendProps } from '@/screens/memory/GraphLegend';
import { zh } from './i18n-setup.js';

const props = (extra: Partial<GraphLegendProps> = {}): GraphLegendProps => ({
  kinds: ['decision', 'report', 'note', 'file', 'url', 'session', 'tag'],
  focused: null,
  shown: 25,
  total: 25,
  truncated: false,
  ...extra,
});
const html = (p: GraphLegendProps) => renderToStaticMarkup(createElement(GraphLegend, p));
const plain = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('memory graph legend', () => {
  it('names the kinds, states and links in rows under a label', () => {
    const out = html(props());
    expect(out).toContain(`aria-label="${zh('memory.graphSide.legend')}"`);
    const text = plain(out);
    expect(text).toMatch(/种类 决定 报告 笔记 文件 网址 会话 标签 /);
    expect(text).toMatch(/状态 当前 待确认 已归档 /);
    expect(text).toMatch(/联系 依据 替代旧版本 恢复自 来源 /);
    expect(text).toContain('显示 25 / 共 25');
  });

  it('lists only the kinds the graph has, in a fixed order', () => {
    const text = plain(html(props({ kinds: ['tag', 'decision', 'file'] })));
    expect(text).toMatch(/种类 决定 文件 标签 状态/);
  });

  it('draws each link sample with the line style of its kind', () => {
    const out = html(props());
    for (const kind of ['depends_on', 'supersedes', 'restored_from', 'source'])
      expect(out).toContain(`data-kind="${kind}"`);
    expect(out).not.toContain('data-out');
  });

  it('adds the outside sample and the focused count while a node is focused', () => {
    const text = plain(html(props({ focused: 9 })));
    expect(text).toMatch(/来源 邻域外 /);
    expect(text).toMatch(/聚焦 9 显示 25 \/ 共 25/);
    expect(plain(html(props()))).not.toContain('聚焦');
  });

  it('says on its first row how many nodes were drawn when the graph was cut', () => {
    const out = html(props({ shown: 80, total: 126, truncated: true }));
    const text = plain(out);
    expect(text).toMatch(/^ ?只画了 80 个，缩小筛选能看到其余 种类/);
    expect(text).toContain('显示 80 / 共 126');
    expect(plain(html(props()))).not.toContain('只画了');
  });

  it('reads the kinds from graph nodes, sources by what they point at', () => {
    const nodes: MemoryGraph['nodes'] = [
      { id: 'a', label: 'a', kind: 'note' },
      { id: 'b', label: 'b', kind: 'source', source_kind: 'url' },
      { id: 'c', label: 'c', kind: 'decision' },
      { id: 'd', label: 'd', kind: 'note' },
      { id: 'e', label: 'e', kind: 'tag' },
    ];
    expect(legendKinds(nodes)).toEqual(['decision', 'note', 'url', 'tag']);
  });
});
