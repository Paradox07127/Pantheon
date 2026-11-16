import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ModelMark,
  RuntimeGlyph,
  runtimeName,
} from '../../apps/web/src/components/RuntimeGlyph.js';
import {
  DEFAULT_SESSION_DISPLAY,
  setSessionDisplay,
} from '../../apps/web/src/data/session-display.js';

const glyph = (runtime: string, size?: number) =>
  renderToStaticMarkup(createElement(RuntimeGlyph, { runtime, size }));
const mark = (model: string | null, beside?: string) =>
  renderToStaticMarkup(createElement(ModelMark, { model, beside }));
const attr = (html: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(html)?.[1];
/** The hover name of the mark, the svg's first child. */
const title = (html: string) => /^<svg[^>]*><title>([^<]*)<\/title>/.exec(html)?.[1];

describe('runtime glyph', () => {
  it.each([
    ['claude', 'Claude Code', 'M20.998 10.949H24v3.102h-3'],
    ['codex', 'Codex', 'M9.064 3.344a4.578 4.578 0 012.285-.312'],
    ['agy', 'Antigravity', 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508'],
    ['grok', 'Grok', 'M9.27 15.29l7.978-5.897'],
    ['dsh', 'DeepSeek', 'M23.748 4.482c-.254-.124-.364.113-.512.234'],
    ['muse', 'Meta', 'M6.897 4h-.024l-.031 2.615h.022'],
    ['opencode', 'OpenCode', 'M16 6H8v12h8V6zm4 16H4V2h16v20z'],
    ['cursor', 'Cursor', 'M22.106 5.68L12.5.135a.998.998 0 00-.998 0'],
    ['copilot', 'GitHub Copilot', 'M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817'],
    ['gemini', 'Gemini', 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001'],
    ['kilo', 'Kilo Code', 'M0 0v24h24V0H0zm22.222 22.222H1.778V1.778'],
    ['cline', 'Cline', 'M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003'],
    ['qwen', 'Qwen', 'M19.713 2.825h-5.907c0-.251-.066-.503-.196-.728'],
    ['kimi', 'Kimi', 'M21.846 0a1.923 1.923 0 110 3.846H20.15'],
    ['goose', 'Goose', 'M21.595 23.61c1.167-.254 2.405-.944 2.405-.944'],
    ['openhands', 'OpenHands', 'M4.75 6.313c.743 0 1.083.357 1.083 1.94'],
    ['kiro', 'Kiro', 'M18.8 0H5.2A5.2 5.2 0 000 5.2v13.6'],
    ['junie', 'Junie', 'M24 9.333C24 18.666 20 24 9.333 24H8v-8'],
    ['devin', 'Devin', 'M2.033 9.867l2.554 1.483a.589.589 0 00.592 0'],
    ['vibe', 'Mistral', 'M3.428 3.4h3.429v3.428H3.428V3.4z'],
    ['hermes', 'Hermes Agent', 'M5.938 12.835c.127-.039.285.02.373.143'],
    ['codebuddy', 'CodeBuddy', 'M18.777 1.647c.28-.02.536.114.972.51'],
    ['qoder', 'Qoder', 'M23.376 14.458v-4.056c0-2.304-1.003-4.154-2.748-5.075'],
  ])('draws %s with the mark of %s, named for it on hover', (runtime, name, path) => {
    const html = glyph(runtime, 16);
    expect(title(html)).toBe(name);
    expect(attr(html, 'aria-hidden')).toBe('true');
    expect(attr(html, 'width')).toBe('16');
    expect(attr(html, 'height')).toBe('16');
    expect(html).toContain(`d="${path}`);
  });

  it('fills the one-colour Grok mark with the grok identity colour', () => {
    expect(glyph('grok')).toContain('fill="var(--rt-grok)"');
  });

  it.each([
    ['fixture', 'fixture'],
    ['auggie', 'Augment'],
    ['omp', 'omp'],
    ['droid', 'Factory Droid'],
  ])('keeps the generic square in the muted colour for %s, named %s', (runtime, name) => {
    expect(runtimeName(runtime)).toBe(name);
    const html = glyph(runtime);
    expect(attr(html, 'aria-hidden')).toBe('true');
    expect(attr(html, 'stroke')).toBe('var(--mu)');
    expect(attr(html, 'width')).toBe('16');
    expect([...html.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1])).toEqual(['M3.5 3.5h7v7h-7Z']);
  });

  it('gives each repeated mark gradient, mask and filter ids of its own', () => {
    const html = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(RuntimeGlyph, { runtime: 'codex' }),
        createElement(RuntimeGlyph, { runtime: 'codex' }),
        createElement(RuntimeGlyph, { runtime: 'agy' }),
        createElement(RuntimeGlyph, { runtime: 'agy' }),
        createElement(ModelMark, { model: 'gemini-3-pro' }),
        createElement(ModelMark, { model: 'gemini-3-pro' }),
      ),
    );
    const ids = [...html.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(6);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = [...html.matchAll(/url\(#([^)]*)\)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(6);
    for (const ref of refs) expect(ids).toContain(ref);
  });
});

describe('model mark', () => {
  it.each([
    ['claude-opus-5-5', 'Claude'],
    ['opus', 'Claude'],
    ['sonnet', 'Claude'],
    ['haiku', 'Claude'],
    ['gpt-6.1-sol', 'OpenAI'],
    ['o3', 'OpenAI'],
    ['codex-mini', 'OpenAI'],
    ['gemini-3-pro', 'Gemini'],
    ['grok-4', 'Grok'],
    ['deepseek-v3', 'DeepSeek'],
    ['muse-spark-1.3', 'Meta'],
    ['qwen3-coder-plus', 'Qwen'],
    ['kimi-k2-0905', 'Kimi'],
    ['devstral-medium', 'Mistral'],
    ['codestral-2508', 'Mistral'],
    ['mistral-large-3', 'Mistral'],
  ])('marks %s with the mark of %s', (model, name) => {
    const html = mark(model);
    expect(title(html)).toBe(name);
    expect(attr(html, 'aria-hidden')).toBe('true');
  });

  it('draws nothing for a model of a maker it does not know', () => {
    for (const model of ['flash', 'llama-4', 'pro', 'opusculum', null])
      expect(mark(model)).toBe('');
  });

  it('draws the one-colour OpenAI and Grok marks in the text colour', () => {
    expect(mark('gpt-5')).toContain('fill="currentColor"');
    expect(mark('grok-4')).toContain('fill="currentColor"');
  });

  it('leaves the mark out beside a runtime of the same maker and keeps it beside another', () => {
    expect(mark('claude-opus-5-5', 'claude')).toBe('');
    expect(mark('gpt-5', 'codex')).toBe('');
    expect(mark('gemini-3-pro', 'agy')).toBe('');
    expect(mark('grok-4', 'grok')).toBe('');
    expect(mark('qwen3-coder-plus', 'qwen')).toBe('');
    expect(mark('kimi-k2-0905', 'kimi')).toBe('');
    expect(mark('devstral-medium', 'vibe')).toBe('');
    expect(title(mark('qwen3-coder-plus', 'opencode'))).toBe('Qwen');
    expect(title(mark('claude-sonnet-4-5', 'agy'))).toBe('Claude');
    expect(title(mark('gpt-5', 'claude'))).toBe('OpenAI');
    expect(title(mark('claude-opus-5-5', 'fixture'))).toBe('Claude');
  });
});

describe('one-colour vendor marks', () => {
  afterEach(() => setSessionDisplay(DEFAULT_SESSION_DISPLAY));
  const css = () =>
    readFileSync(
      fileURLToPath(new URL('../../apps/web/src/components/runtime-glyph.css', import.meta.url)),
      'utf8',
    );

  it('draws the runtime and model marks in the text colour when set to one colour', () => {
    expect(glyph('claude')).not.toContain('data-mono');
    expect(glyph('grok')).toContain('fill="var(--rt-grok)"');
    setSessionDisplay({ vendor_marks: 'mono' });
    for (const runtime of ['claude', 'codex', 'agy', 'grok'])
      expect(attr(glyph(runtime), 'data-mono'), runtime).toBe('true');
    expect(glyph('grok')).toContain('fill="currentColor"');
    expect(attr(mark('gemini-3-pro'), 'data-mono')).toBe('true');
  });

  it("paints every shape of a one-colour mark in the text colour and drops Codex's tile", () => {
    expect(css()).toMatch(
      /^\.rtg \[data-mono\] :is\(path, rect, circle\):not\(mask > \*\) \{\s*fill: currentColor;/m,
    );
    expect(css()).toMatch(/^\.rtg \[data-mono\] \.rtg-bg \{\s*display: none;/m);
    setSessionDisplay({ vendor_marks: 'mono' });
    expect(glyph('codex')).toContain('class="rtg-bg"');
  });
});
