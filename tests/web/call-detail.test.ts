import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DaemonEvent } from '@/data/sync';
import { find } from './web-hook-host.js';

const history = vi.hoisted(() => ({ events: [] as DaemonEvent[] }));
const shell = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: (options: { key: string | null; keep: (e: DaemonEvent) => boolean }) => ({
    events: options.key === null ? null : history.events.filter(options.keep),
    error: null,
    reload: () => undefined,
  }),
}));
vi.mock('@/store', () => ({ useShell: { getState: () => shell } }));
import { CallDetail } from '@/screens/runtime/CallDetail';
import type { RunCall } from '@/screens/runtime/run-tree';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 6, 12);

const call = (extra: Partial<RunCall> = {}): RunCall => ({
  id: 'a',
  kind: 'tool',
  name: 'Bash',
  status: 'error',
  start: NOW - 21_400,
  end: NOW,
  tokens: 3300,
  ...extra,
});

const event = (kind: string, payload: object): DaemonEvent => ({
  sequence: 1,
  event_id: `${kind}-${JSON.stringify(payload)}`,
  kind,
  aggregate_id: 'session-1',
  aggregate_revision: 1,
  project_id: 'project-1',
  causation_id: 'cause',
  created_at: NOW,
  payload,
});

const props = (extra: Partial<Parameters<typeof CallDetail>[0]> = {}) => ({
  call: call(),
  session: 'session-1',
  title: 'signature check',
  turn: 14,
  projectId: 'project-1',
  events: true,
  now: NOW,
  onClose: vi.fn(),
  onShowInTimeline: vi.fn(),
  ...extra,
});

const html = (p = props()) => renderToStaticMarkup(createElement(CallDetail, p));
const button = (p: ReturnType<typeof props>, label: string) =>
  find(CallDetail(p), (n) => n.type === 'button' && n.props['aria-label'] === label);
const labelled = (p: ReturnType<typeof props>, label: string) =>
  find(CallDetail(p), (n) => n.type === 'button' && [n.props.children].flat().includes(label));

beforeEach(() => {
  history.events = [
    event('agent.tool.started', {
      tool_call_id: 'a',
      name: 'Bash',
      input: { command: 'pnpm test webhook' },
    }),
    event('agent.tool.completed', {
      tool_call_id: 'a',
      ok: false,
      output: '✗ replay\n    expected 409, got 200\nTests  1 failed',
    }),
  ];
});
afterEach(() => {
  vi.unstubAllGlobals();
  shell.openSession.mockReset();
});

describe('call detail panel', () => {
  it('is a side panel headed by the kind of call, its session and turn, with a close button', () => {
    const p = props();
    const markup = html(p);
    expect(markup).toMatch(/^<aside class="cd" aria-label="调用详情">/);
    expect(markup).toMatch(
      /<div class="cd-h"><svg[^>]*>.*?<\/svg><span class="cd-kind">运行<\/span><span class="cd-ses">signature check<\/span><span class="cd-turn">第 14 轮<\/span><button/,
    );
    button(p, zh('runs.detail.close')).props.onClick();
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('fills a three-column panel with status, start, end, duration, a held retry place and tokens', () => {
    const markup = html();
    expect(markup).toContain('<div class="panel cd-facts">');
    expect(markup.match(/<div class="cell"/g)).toHaveLength(6);
    expect(markup).toContain('<span class="cap">状态</span>');
    expect(markup).toContain('失败</span>');
    expect(markup).toContain('<span class="cap">时长</span><span class="cd-v">21.4 秒</span>');
    expect(markup).toContain('<div class="cell" aria-hidden="true"></div>');
    expect(markup).not.toContain('重试');
    expect(markup).toContain('<span class="cap">tokens</span><span class="cd-v">3k</span>');
  });

  it('shows the input as its one-line command and copies that command', () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const p = props();
    const markup = html(p);
    expect(markup).toContain(
      '<span class="cap">输入</span><pre class="cd-code">pnpm test webhook</pre>',
    );
    expect(markup).not.toContain('&quot;command&quot;');
    button(p, zh('runs.detail.copy')).props.onClick();
    expect(writeText).toHaveBeenCalledWith('pnpm test webhook');
  });

  it('shows the traced input of a call whose session records no events, and copies it', () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const span: NonNullable<Parameters<typeof CallDetail>[0]['span']> = {
      id: 'a',
      parent: 'turn-1',
      turn: 'turn-1',
      kind: 'tool',
      name: 'Bash',
      start: NOW - 21_400,
      end: NOW,
      status: 'error',
      timing: 'native',
      input_summary: 'pnpm test:integration webhook',
    };
    const p = props({ events: false, span });
    expect(html(p)).toContain(
      '<span class="cap">输入</span><pre class="cd-code">pnpm test:integration webhook</pre>',
    );
    button(p, zh('runs.detail.copy')).props.onClick();
    expect(writeText).toHaveBeenCalledWith('pnpm test:integration webhook');
  });

  it('times a running call up to now', () => {
    const markup = html(props({ call: call({ status: 'running', end: null }), now: NOW + 600 }));
    expect(markup).toContain('<span class="cap">时长</span><span class="cd-v">22.0 秒</span>');
  });

  it('shows and copies a multi-line command whole', () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const script = `pnpm lint\npnpm test ${'webhook '.repeat(50)}`;
    history.events = [
      event('agent.tool.started', { tool_call_id: 'a', name: 'Bash', input: { command: script } }),
    ];
    const p = props();
    expect(html(p)).toContain(`<pre class="cd-code">${script}</pre>`);
    button(p, zh('runs.detail.copy')).props.onClick();
    expect(writeText).toHaveBeenCalledWith(script);
  });

  it('offers no command to copy for a call whose input is not a command', () => {
    history.events = [
      event('agent.tool.started', {
        tool_call_id: 'a',
        name: 'Write',
        input: { file_path: 'src/a.ts', content: 'export {};' },
      }),
    ];
    expect(html(props({ call: call({ name: 'Write' }) }))).not.toContain(zh('runs.detail.copy'));
  });

  it('offers no command to copy from a traced input that is a path or may be cut short', () => {
    const span = (name: string, input_summary: string) => ({
      id: 'a',
      parent: 'turn-1',
      turn: 'turn-1',
      kind: 'tool' as const,
      name,
      start: NOW - 21_400,
      end: NOW,
      status: 'error' as const,
      timing: 'native' as const,
      input_summary,
    });
    const path = props({ events: false, call: call({ name: 'Edit' }), span: span('Edit', 'a.ts') });
    expect(html(path)).toContain('<pre class="cd-code">a.ts</pre>');
    expect(html(path)).not.toContain(zh('runs.detail.copy'));
    const cut = props({ events: false, span: span('Bash', 'x'.repeat(200)) });
    expect(html(cut)).not.toContain(zh('runs.detail.copy'));
  });

  it('slides in from the right by a transition, so showing the screen again does not replay it', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../apps/web/src/screens/runtime/call-detail.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\.cd \{[^}]*transition:\s*opacity var\(--dur-4\) var\(--ease-in\),\s*transform var\(--dur-4\) var\(--ease-in\);/,
    );
    expect(css).toMatch(
      /@starting-style \{\s*\.cd \{\s*opacity: 0;\s*transform: translateX\(16px\);\s*\}\s*\}/,
    );
    expect(css).not.toContain('animation');
  });

  it('draws an error on the terminal surface with only its crosses in the error colour', () => {
    expect(html()).toContain(
      '<span class="cap">错误</span><pre class="cd-code cd-term"><span class="cd-bad">✗</span> replay\n    expected 409, got 200\nTests  1 failed</pre>',
    );
  });

  it('opens the call in the timeline or in the conversation from its foot', () => {
    const p = props();
    expect(html(p)).toMatch(/<div class="cd-foot"><button type="button" class="btn">/);
    labelled(p, zh('runs.detail.showInTimeline')).props.onClick();
    expect(p.onShowInTimeline).toHaveBeenCalledOnce();
    labelled(p, zh('runs.detail.showInThread')).props.onClick();
    expect(shell.openSession).toHaveBeenCalledWith('session-1');
  });

  it.each([
    ['leaves the turn out when it is not known', { turn: null }, 'cd-turn'],
    [
      'leaves the conversation button out for an external session lane',
      { session: 'native:claude:abc' },
      zh('runs.detail.showInThread'),
    ],
    [
      'leaves the timeline button out when there is no timeline to show it in',
      { onShowInTimeline: undefined },
      zh('runs.detail.showInTimeline'),
    ],
  ])('%s', (_name, extra, absent) => {
    expect(html(props(extra))).not.toContain(absent);
  });
});
