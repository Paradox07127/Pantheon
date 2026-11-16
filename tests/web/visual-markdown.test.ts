import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../apps/web/src/components/Markdown.js';
import { zh } from './i18n-setup.js';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
const fence = (lang: string, body: string) => `Here:\n\n\`\`\`${lang}\n${body}\n\`\`\`\n`;

const vegaSpec = { mark: 'bar', data: { values: [{ a: 1, b: 2 }] } };
const klineSpec = { candles: [{ time: '2026-01-02', open: 1, high: 2, low: 0.5, close: 1.5 }] };

describe('drawn code blocks in markdown', () => {
  it.each([
    ['mermaid', 'graph LR\na-->b', zh('visual.kind.mermaid')],
    ['vega-lite', JSON.stringify(vegaSpec), zh('visual.kind.vegaLite')],
    ['kline', JSON.stringify(klineSpec), zh('visual.kind.kline')],
  ])('draws a %s block in a card instead of the code', (lang, body, kind) => {
    const html = render(fence(lang, body));
    expect(html).toContain('role="group"');
    expect(html).toContain(`role="group" aria-label="${kind}"`);
    expect(html).not.toContain('<pre');
    expect(html).toContain(`aria-label="${zh('visual.markdown.source')}"`);
    expect(html).not.toContain(`aria-label="${zh('visual.card.pin')}"`);
  });

  it.each([
    ['vega-lite', '{"mark": "bar", "data": {"values": [{"a"'],
    ['kline', '{"candles": [{"time": "2026-01-02", "open": 1'],
  ])('keeps a %s block that is still streaming as code', (lang, body) => {
    const html = render(fence(lang, body));
    expect(html).toContain('<pre>');
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain('role="alert"');
  });

  it('refuses a Vega-Lite spec that fetches data at any depth and says why', () => {
    const spec = { layer: [{ mark: 'line', data: { url: 'https://example.com/rates.csv' } }] };
    const html = render(fence('vega-lite', JSON.stringify(spec)));
    expect(html).toContain('<pre>');
    expect(html).not.toContain('role="group"');
    expect(html).toContain(zh('visual.markdown.dataUrl'));
  });

  it('draws a Vega-Lite spec whose inline rows have a url field', () => {
    const spec = {
      mark: 'bar',
      data: { values: [{ url: 'https://example.com', count: 1, data: { url: 'https://a.b' } }] },
      encoding: { x: { field: 'url', type: 'nominal' } },
    };
    const html = render(fence('vega-lite', JSON.stringify(spec)));
    expect(html).toContain(`role="group" aria-label="${zh('visual.kind.vegaLite')}"`);
    expect(html).not.toContain('data.url');
  });

  it('keeps a kline block without a candles array as code and says why', () => {
    const html = render(fence('kline', JSON.stringify({ rows: [] })));
    expect(html).toContain('<pre>');
    expect(html).not.toContain('role="group"');
    expect(html).toContain(zh('visual.markdown.noCandles'));
  });

  it('leaves code blocks in other languages as they were', () => {
    const html = render(fence('ts', 'const a = 1;'));
    expect(html).toContain('<pre><code class="hljs language-ts">');
    expect(html).not.toContain('role="group"');
  });
});
