import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  fileURLToPath(new URL('../../apps/web/src/index.css', import.meta.url)),
  'utf8',
);

/** Splits a selector list on the commas outside parentheses. */
function selectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => ({ at: m.index, selectors: selectorList(m[1]!), body: m[2]!.replace(/\s/g, '') }),
);

function rulesFor(selector: string) {
  return rules.filter((rule) => rule.selectors.includes(selector));
}

function background(selector: string): string | undefined {
  return rulesFor(selector)
    .flatMap((rule) => [...rule.body.matchAll(/(?:^|;)background:([^;]+)/g)].map((m) => m[1]))
    .pop();
}

const hovered = [
  '.sb-pj:hover',
  '.sb-pj[data-popup-open]',
  '.sb-it:hover',
  '.ss-row:hover',
  '.ps-page:hover',
  'button.ss-gh:hover',
  '.ib:hover',
  '.ps-tab:hover',
];

const selected = ['.ps-page[aria-current=page]'];

const sidebarSelected = [
  '.sb-it[aria-current]',
  '.sb-sh .ib[aria-current]',
  ':is(.sb-rail,.wc) .ib[aria-current]',
  '.ss-row.on',
];

const pressed = [
  ['.sb-it:hover', '.sb-it:active:not(:disabled)'],
  ['.ss-row:hover', '.ss-row:active'],
  ['.ps-page:hover', '.ps-page:active'],
  ['.ib:hover', '.ib:active:not(:disabled)'],
  ['.sb-pj:hover', '.sb-pj:active'],
] as const;

it('defines a hover and a selected state colour in the shared scale', () => {
  const shared = /^:root\s*\{([^}]*--dur-1:[^}]*)\}/m.exec(css)?.[1] ?? '';
  expect(shared).toMatch(/--st-hov:\s*color-mix\(in srgb, var\(--tx\) 6%, transparent\);/);
  expect(shared).toMatch(/--st-on:\s*color-mix\(in srgb, var\(--tx\) 10%, transparent\);/);
});

it('draws no border on a hovered sidebar control', () => {
  const bordered = rules
    .filter((rule) => rule.selectors.some((s) => /^\.sb\b/.test(s) && s.includes(':hover')))
    .filter((rule) => /border(-color)?:/.test(rule.body))
    .map((rule) => rule.selectors.join(','));
  expect(bordered).toEqual([]);
});

it('fills hovered navigation items and controls with the hover colour', () => {
  expect(hovered.map((s) => [s, background(s)])).toEqual(hovered.map((s) => [s, 'var(--st-hov)']));
});

it('fills a hovered ghost button with the selection colour', () => {
  expect(background('.btn.ghost:hover')).toBe('var(--sel)');
});

it('fills selected navigation items with the selected colour', () => {
  expect(selected.map((s) => [s, background(s)])).toEqual(selected.map((s) => [s, 'var(--st-on)']));
});

it('fills the current sidebar row with the selection colour', () => {
  expect(sidebarSelected.map((s) => [s, background(s)])).toEqual(
    sidebarSelected.map((s) => [s, 'var(--sel)']),
  );
});

it('fills a pressed navigation item with the selected colour after its hover rule', () => {
  for (const [hover, active] of pressed) {
    expect(background(active), active).toBe('var(--st-on)');
    const hoverAt = Math.max(...rulesFor(hover).map((rule) => rule.at));
    const activeAt = Math.min(...rulesFor(active).map((rule) => rule.at));
    expect(activeAt, active).toBeGreaterThan(hoverAt);
  }
});

it('keeps interface text unselectable except what the user copies', () => {
  expect(rulesFor('.pt').some((rule) => rule.body.includes('user-select:none'))).toBe(true);
  const selectable = rules
    .filter((rule) => rule.body.includes('user-select:text'))
    .flatMap((rule) =>
      rule.selectors.flatMap((s) => selectorList(/^:is\((.*)\)$/.exec(s)?.[1] ?? s)),
    );
  for (const s of ['.ss-thread', '.md', 'pre', 'code', 'input', 'textarea'])
    expect(selectable, s).toContain(s);
});

it('gives no element a view transition name, so a screen switch never crossfades the main area', () => {
  expect(css).not.toMatch(/view-transition-name/);
  expect(css).not.toMatch(/::view-transition-[a-z-]+\(page\)/);
});
