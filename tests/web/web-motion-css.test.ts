import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../../apps/web/src', import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

interface Rule {
  where: string;
  selector: string;
  atRules: string[];
  decls: { prop: string; value: string }[];
  body: string;
}

// Splits on a separator outside parentheses, so `cubic-bezier(0.2,0,0,1)` stays whole.
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && separator.test(c)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseRules(file: string, text: string): Rule[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      open.push(css.slice(start, i).split(';').pop()!.trim());
      start = i + 1;
    } else if (css[i] === '}') {
      const body = css.slice(start, i);
      const selector = open.pop()!;
      if (body.trim())
        rules.push({
          where: `${path.relative(src, file)}: ${selector}`,
          selector,
          atRules: [...open],
          body,
          decls: body
            .split(';')
            .map((decl) => decl.trim())
            .filter((decl) => decl.includes(':'))
            .map((decl) => {
              const colon = decl.indexOf(':');
              return {
                prop: decl.slice(0, colon).trim(),
                value: decl
                  .slice(colon + 1)
                  .replace(/!important$/, '')
                  .trim(),
              };
            }),
        });
      start = i + 1;
    }
  }
  return rules;
}

const rules = cssFiles(src).flatMap((file) => parseRules(file, readFileSync(file, 'utf8')));

const notProperty =
  /^(?:[\d.]+m?s|ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|normal|allow-discrete)$/;

// The property each item of a transition declaration animates; a shorthand item naming none means all.
function transitioned(prop: string, value: string): string[] {
  return splitTop(value, /,/).map((item) => {
    if (prop === 'transition-property') return item;
    const named = splitTop(item, /\s/).filter((t) => !t.includes('(') && !notProperty.test(t));
    return named[0] ?? 'all';
  });
}

const allowed = new Set([
  'none',
  'transform',
  'opacity',
  'color',
  'background-color',
  'border-color',
  'fill',
  'stroke',
  'stroke-dashoffset',
  'background-position',
]);

it('draws no shadows in any stylesheet', () => {
  const found = rules.flatMap((rule) =>
    rule.decls
      .filter(
        ({ prop, value }) =>
          (prop === 'box-shadow' && value !== 'none') || value.includes('drop-shadow('),
      )
      .map(({ prop, value }) => `${rule.where} { ${prop}: ${value} }`),
  );
  expect(found).toEqual([]);
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

// Tailwind ring utilities draw with box-shadow too.
const tsxShadow =
  /boxShadow|drop-?shadow|<filter\b|(?<![\w-])(?:[\w-]+:)*(?:shadow|drop-shadow|ring)-[\w[\]/.-]+/gi;

it('draws no shadows from any component', () => {
  const found = tsxFiles(src).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) =>
        [...line.matchAll(tsxShadow)]
          // The Antigravity mark blurs its own colour fields; it casts no shadow.
          .filter(
            (m) => m[0] !== '<filter' || file !== path.join(src, 'components', 'BrandMark.tsx'),
          )
          // Turning Mermaid's own node shadow off names it.
          .filter((m) => m[0] !== 'dropShadow' || !line.includes("dropShadow: 'none'"))
          .map((m) => `${path.relative(src, file)}:${i + 1}: ${m[0]}`),
      ),
  );
  expect(found).toEqual([]);
});

it('transitions only compositor-friendly and colour properties', () => {
  const found = rules.flatMap((rule) =>
    rule.decls
      .filter(({ prop }) => prop === 'transition' || prop === 'transition-property')
      .flatMap(({ prop, value }) => transitioned(prop, value))
      .filter((name) => {
        if (allowed.has(name)) return false;
        if (name === 'height') return !rule.body.includes('--collapsible-panel-height');
        if (name === 'width')
          return (
            !/\.[\w-]+-bar(?![\w-])/.test(rule.selector) &&
            !rule.body.includes('--active-tab-width')
          );
        if (name === 'grid-template-rows') return !/\.[\w-]+-grow(?![\w-])/.test(rule.selector);
        if (name === 'filter') return !/\.[\w-]+-in(?![\w-])/.test(rule.selector);
        return true;
      })
      .map((name) => `${rule.where} transitions ${name}`),
  );
  expect(found).toEqual([]);
});

// Selectors spaced alike and without quotes, so minified and formatted stylesheets compare.
const spaced = (selector: string) =>
  selector
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([>,])\s*/g, '$1')
    .trim();

it('follows the motion choice in Appearance, with no rule left to the system setting alone', () => {
  expect(
    rules
      .filter((rule) => rule.atRules.some((at) => /prefers-reduced-motion/.test(at)))
      .map((rule) => rule.where),
  ).toEqual([]);
});

it('keeps fades under reduced motion instead of switching every transition off', () => {
  const reduced = rules.filter((rule) => spaced(rule.selector).includes('[data-motion=reduced]'));
  expect(reduced).not.toEqual([]);
  const off = reduced.flatMap((rule) =>
    rule.decls
      .filter(({ prop, value }) => prop === 'transition' && value === 'none')
      .map(() => `${rule.where} { transition: none }`),
  );
  expect(off).toEqual([]);
});

it('holds every transition in the main area while a screen switch is marked', () => {
  const hold = rules.find((rule) => rule.selector.includes('.app-main[data-switching] *'));
  expect(hold?.body).toBe('transition:none!important');
  // A keyframe animation would start again when the mark is removed; the status pop is a transition.
  const animated = rules
    .filter((rule) => /\.bd-pop(?![\w-])/.test(rule.selector))
    .flatMap((rule) => rule.decls.filter(({ prop }) => prop.startsWith('animation')));
  expect(animated).toEqual([]);
});

it('enters a maximized panel by a transition, so showing the screen again does not replay it', () => {
  const max = rules.filter((rule) => rule.selector === '.ss.ss-max>.ss-panel');
  expect(
    max.flatMap((rule) => rule.decls.filter(({ prop }) => prop.startsWith('animation'))),
  ).toEqual([]);
  expect(max.some((rule) => rule.atRules.includes('@starting-style'))).toBe(true);
});

it('hides a skeleton bar until the Skeleton component marks it shown after its wait', () => {
  const component = readFileSync(path.join(src, 'components', 'Skeleton.tsx'), 'utf8');
  expect(component).toContain('useDelayed(true)');
  const hidden = rules.find((rule) => rule.selector === '.skel:not([data-shown])');
  expect(hidden?.decls).toEqual([{ prop: 'visibility', value: 'hidden' }]);
  expect(rules.filter((rule) => /\.sk(?![\w-])/.test(rule.selector))).toEqual([]);
});

const keyframeAllowed = new Set([
  'transform',
  'opacity',
  'color',
  'background-color',
  'border-color',
  'fill',
  'stroke',
]);

// Loops left on a property the compositor cannot animate, because moving a layer would change how they look.
const keyframeExceptions: Record<string, string> = {
  'tr-shine':
    'the light is clipped to the letters by background-clip: text; a moving layer would carry the letters',
  'ct-sweep':
    'the light is clipped to the letters by background-clip: text; a moving layer would carry the letters',
  'mef-sweep':
    'the light is clipped to the letters by background-clip: text; a moving layer would carry the letters',
  'bd-flow': 'the dashes run along a curved edge path, which only stroke-dashoffset can follow',
};

it('animates keyframes only on compositor-friendly and colour properties', () => {
  const found = rules.flatMap((rule) => {
    const name = rule.atRules.map((at) => /^@keyframes\s+([\w-]+)/.exec(at)?.[1]).find(Boolean);
    if (!name) return [];
    return rule.decls
      .filter(({ prop }) => !keyframeAllowed.has(prop))
      .map(({ prop }) => ({ name, at: `${rule.where} in @keyframes ${name} animates ${prop}` }));
  });
  expect(found.filter(({ name }) => !(name in keyframeExceptions)).map(({ at }) => at)).toEqual([]);
  // An exception whose loop now moves a layer leaves the table.
  expect(
    Object.keys(keyframeExceptions).filter((name) => !found.some((f) => f.name === name)),
  ).toEqual([]);
});

// The elements whose animation stops under a status animation setting.
function stoppedUnder(setting: 'waiting' | 'off'): Set<string> {
  const prefixes = ['.pt:is([data-state-motion=waiting],[data-state-motion=off]) '];
  if (setting === 'off') prefixes.push('.pt[data-state-motion=off] ');
  const stopped = new Set<string>();
  for (const rule of rules) {
    if (!rule.decls.some(({ prop, value }) => prop === 'animation' && value === 'none')) continue;
    for (const selector of splitTop(spaced(rule.selector), /,/)) {
      const prefix = prefixes.find((p) => selector.startsWith(p));
      if (!prefix) continue;
      const rest = selector.slice(prefix.length);
      const is = /^:is\((.*)\)([^()]*)$/.exec(rest);
      for (const target of is ? splitTop(is[1]!, /,/).map((s) => s + is[2]) : [rest])
        stopped.add(target);
    }
  }
  return stopped;
}

const animates = (selector: string, keyframe: string) =>
  rules.some(
    (rule) =>
      splitTop(spaced(rule.selector), /,/).some(
        (s) => s === selector || s.startsWith(`${selector}:nth-child(`),
      ) &&
      rule.decls.some(
        ({ prop, value }) =>
          (prop === 'animation' || prop === 'animation-name') &&
          value.split(/\s+/).includes(keyframe),
      ),
  );

it.each([
  ['.si-breathe', 'si-breathe', 'waiting'],
  ['.si-spin', 'si-spin', 'waiting'],
  ['.ss-badge[data-badge=running]', 'ss-breathe', 'waiting'],
  ['.ss-badge[data-badge=starting]', 'ss-breathe', 'waiting'],
  ['.ss-badge[data-badge=stopping]', 'ss-breathe', 'waiting'],
  ['.ss-badge[data-badge=merging]', 'ss-breathe', 'waiting'],
  ['.sh-pip', 'ss-breathe', 'waiting'],
  ['.eq>i', 'eq-1', 'waiting'],
  ['.tr-shine', 'tr-shine', 'waiting'],
  ['.ct-working', 'ct-sweep', 'waiting'],
  ['.rn-turn.rn-k-run::before', 'rn-stripe', 'waiting'],
  ['.rq-wait::after', 'rq-breathe', 'off'],
  ['.ss-gwait::after', 'ss-breathe', 'off'],
  ['.ct-st[data-state=wait]::after', 'ct-breathe', 'off'],
] as const)('stops %s (%s) from the %s status animation setting on', (selector, keyframe, from) => {
  expect(animates(selector, keyframe)).toBe(true);
  expect(stoppedUnder('off').has(selector)).toBe(true);
  expect(stoppedUnder('waiting').has(selector)).toBe(from === 'waiting');
});
