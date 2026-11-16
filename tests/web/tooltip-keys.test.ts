import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { find, text } from './web-hook-host.js';
import { Tip } from '@/components/Tip';
import { keyText } from '@/lib/shortcuts';

// The stylesheet with the space around its punctuation taken out.
const css = () =>
  readFileSync(path.resolve(import.meta.dirname, '../../apps/web/src/components/tip.css'), 'utf8')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/\s+/g, ' ');

describe('tooltip', () => {
  it('shows the shortcut in a key cap after the text', () => {
    const tree = Tip({
      content: '新会话',
      keys: 'Meta+N',
      children: createElement('button', { type: 'button' }),
    });
    const popup = find(tree, (n) => n.props.className === 'tooltip');
    const [label, cap] = popup.props.children;
    expect(label).toBe('新会话');
    expect(cap.props.className).toBe('kbd');
    expect(text(cap)).toBe(keyText('Meta+N'));
  });

  it('shows no key cap without keys', () => {
    const tree = Tip({ content: '新会话', children: createElement('button', { type: 'button' }) });
    const popup = find(tree, (n) => n.props.className === 'tooltip');
    expect(text(popup)).toBe('新会话');
  });

  it('draws a 24px ink tip with on-ink text, 7px corners and 12px type', () => {
    const rule = css().match(/(?:^|\})\.tooltip\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('min-height:24px');
    expect(rule).toContain('background:var(--ink)');
    expect(rule).toContain('color:var(--on-ink)');
    expect(rule).toContain('border-radius:var(--r-sm)');
    expect(rule).toContain('font-size:var(--fs-xs)');
    expect(rule).not.toContain('shadow');
  });
});
