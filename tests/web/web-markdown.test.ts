import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../../apps/web/node_modules/react-markdown/index.js', async (actual) => {
  const real = await actual<typeof import('../../apps/web/node_modules/react-markdown/index.js')>();
  return { ...real, default: vi.fn(real.default) };
});
import ReactMarkdown from '../../apps/web/node_modules/react-markdown/index.js';
import { Markdown } from '../../apps/web/src/components/Markdown.js';
import { normalizeMathDelimiters } from '../../apps/web/src/components/markdownMath.js';
import { find } from './web-hook-host.js';

const render = (text: string, inline?: boolean) =>
  renderToStaticMarkup(createElement(Markdown, { text, inline }));

describe('Markdown rendering', () => {
  it('renders bold next to CJK punctuation', () => {
    expect(render('这是**“引号”**文字')).toContain('<strong>');
    expect(render('中文**粗体（括号）**中文')).toContain('<strong>');
  });

  it.each<[string, string, string[], string[]]>([
    [
      'never emits raw HTML elements from model output',
      '<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>',
      [],
      ['<img', '<script'],
    ],
    ['drops javascript: link targets', '[x](javascript:alert(1))', ['<a'], ['javascript:']],
    [
      'leaves a path in a link label to the link',
      '[`src/a.ts`](src/b.ts:42)',
      ['href="src/b.ts:42"', '<code>src/a.ts</code>'],
      ['md-path'],
    ],
    ['does not render markdown images', '![a](https://example.com/a.png)', [], ['<img']],
    ['keeps single dollar amounts as text', '价格是$5，折后$3。', ['$5'], ['katex']],
  ])('%s', (_, text, has, hasNot) => {
    const html = render(text);
    for (const part of has) expect(html).toContain(part);
    for (const part of hasNot) expect(html).not.toContain(part);
  });

  it('keeps file and file-with-line link targets', () => {
    expect(render('[a](foo.ts:12)')).toContain('href="foo.ts:12"');
    expect(render('[b](file:///repo/a.ts)')).toContain('href="file:///repo/a.ts"');
    expect(render('[c](vscode:extension/x)')).toContain('href=""');
  });

  it('lets an in-page anchor jump, but not a link it cannot open', () => {
    let tree: ReactNode = null;
    const Grab = () => {
      tree = (Markdown as unknown as { type: (props: object) => ReactNode }).type({
        text: '[x](#user-content-fn-1)',
      });
      return null;
    };
    renderToStaticMarkup(createElement(Grab));
    const link = find(tree, (n) => typeof n.type === 'function' && 'href' in n.props).type as (
      props: object,
    ) => ReactElement<any>;
    const click = (href: string) => {
      const event = { preventDefault: vi.fn() };
      link({ href, children: 'x' }).props.children.props.onClick?.(event);
      return event.preventDefault;
    };
    expect(click('#user-content-fn-1')).not.toHaveBeenCalled();
    expect(click('')).toHaveBeenCalledOnce();
  });

  it('renders double-dollar and backslash math delimiters', () => {
    expect(render('能量 $$E=mc^2$$ 守恒')).toContain('class="katex');
    const block = render('$$\n\\int x\n$$');
    expect(block).toContain('class="katex');
    expect(block).toContain('katex-display');
    expect(render('面积 \\(a^2\\) 平方')).toContain('class="katex');
    const display = render('\\[b^2\\]');
    expect(display).toContain('class="katex');
    expect(display).toContain('katex-display');
  });

  it('highlights fenced code and leaves inline code untouched', () => {
    expect(render('```ts\nconst a = 1;\n```')).toContain('hljs');
    const html = render('写成 `\\(x\\)` 即可');
    expect(html).not.toContain('katex');
    expect(html).toContain('<code>\\(x\\)</code>');
  });

  it('renders GFM tables and task lists', () => {
    expect(render('| a | b |\n| - | - |\n| 1 | 2 |')).toContain('<table>');
    expect(render('- [ ] 待办\n- [x] 完成')).toContain('type="checkbox"');
  });

  it('points each footnote link of messages on one page at one element', () => {
    const note = createElement(Markdown, { text: '正文[^1]\n\n[^1]: 脚注' });
    const html = renderToStaticMarkup(createElement('div', null, note, note));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    const hrefs = [...html.matchAll(/ href="#([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs).toHaveLength(4);
    for (const href of hrefs) expect(ids.filter((id) => id === href)).toHaveLength(1);
  });

  it('keeps only inline formatting in inline mode', () => {
    const html = render('## 标题\n\n- 项', true);
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<ul');
    expect(html).not.toContain('<li');
    expect(render('**粗**', true)).toContain('<strong>粗</strong>');
  });
});

describe('Markdown parse reuse', () => {
  const parses = () => vi.mocked(ReactMarkdown).mock.calls.length;

  it('parses a text shown again only once', () => {
    const before = parses();
    const first = render('reused **once**\n\n```ts\nconst a = 1;\n```');
    expect(render('reused **once**\n\n```ts\nconst a = 1;\n```')).toBe(first);
    expect(parses()).toBe(before + 1);
    render('reused **once**\n\n```ts\nconst a = 1;\n```', true);
    expect(parses()).toBe(before + 2);
  });

  it('drops the least recently shown text past 300 texts', () => {
    render('kept text');
    render('dropped text');
    render('kept text');
    for (let i = 0; i < 299; i++) render(`filler text ${i}`);
    const before = parses();
    render('kept text');
    expect(parses()).toBe(before);
    render('dropped text');
    expect(parses()).toBe(before + 1);
  });
});

describe('normalizeMathDelimiters', () => {
  it('converts backslash delimiters outside code', () => {
    expect(normalizeMathDelimiters('a \\(x\\) b')).toBe('a $$x$$ b');
    expect(normalizeMathDelimiters('\\[x\\]')).toBe('\n$$\nx\n$$\n');
  });

  it('leaves fenced code unchanged', () => {
    const text = '```\n\\[x\\]\n```';
    expect(normalizeMathDelimiters(text)).toBe(text);
  });

  it('leaves indented code unchanged', () => {
    for (const text of ['    a \\(x\\)\n', '段落\n\n    a \\(x\\)\n\n    \\[y\\]\n\n后文'])
      expect(normalizeMathDelimiters(text)).toBe(text);
    expect(normalizeMathDelimiters('段落\n    \\(x\\)')).toBe('段落\n    $$x$$');
  });

  it('leaves delimiters after an escaped backslash as text', () => {
    const text = '写 \\\\(x\\\\) 和 \\\\[y\\\\]';
    expect(normalizeMathDelimiters(text)).toBe(text);
    expect(normalizeMathDelimiters('\\\\\\(x\\)')).toBe('\\\\$$x$$');
  });
});
