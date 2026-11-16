import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DaemonEvent } from '@/data/sync';

const history = vi.hoisted(() => ({
  events: [] as DaemonEvent[],
  keys: [] as (string | null)[],
  error: null as string | null,
  reload: () => undefined,
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: (options: { key: string | null; keep: (e: DaemonEvent) => boolean }) => {
    history.keys.push(options.key);
    return {
      events: options.key === null || history.error ? null : history.events.filter(options.keep),
      error: options.key === null ? null : history.error,
      reload: history.reload,
    };
  },
}));
import { CallDetail } from '@/screens/runtime/CallDetail';
import type { RunCall } from '@/screens/runtime/run-tree';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 6, 12);

const call = (id: string, extra: Partial<RunCall> = {}): RunCall => ({
  id,
  kind: 'tool',
  name: `tool ${id}`,
  status: 'ok',
  start: NOW - 4_000,
  end: NOW - 1_000,
  tokens: 0,
  ...extra,
});

const event = (kind: string, payload: object, session = 'session-1'): DaemonEvent => ({
  sequence: 1,
  event_id: `${kind}-${JSON.stringify(payload)}`,
  kind,
  aggregate_id: session,
  aggregate_revision: 1,
  project_id: 'project-1',
  causation_id: 'cause',
  created_at: NOW,
  payload,
});

const detail = (props: { call: RunCall; events: boolean }) =>
  renderToStaticMarkup(
    createElement(CallDetail, {
      ...props,
      session: 'session-1',
      title: 'session session-1',
      turn: null,
      projectId: 'project-1',
      now: NOW,
      onClose: () => undefined,
    }),
  );

describe('call detail', () => {
  it('shows input and output of the call from its session events, an error output as an error', () => {
    history.events = [
      event('agent.tool.started', { tool_call_id: 'a', name: 'Bash', input: { command: 'ls' } }),
      event('agent.tool.completed', { tool_call_id: 'a', ok: false, output: 'no such file' }),
      event('agent.tool.started', { tool_call_id: 'other', input: { command: 'pwd' } }),
    ];
    const html = detail({ call: call('a', { status: 'error', tokens: 1200 }), events: true });
    expect(history.keys.at(-1)).toBe('session-1');
    expect(html).toContain(`<span class="cap">${zh('runtime.call.input')}</span>`);
    expect(html).toContain('<pre class="cd-code">ls</pre>');
    expect(html).not.toContain('pwd');
    expect(html).toContain('<pre class="cd-code cd-term">no such file</pre>');
    expect(html).toContain(`${zh('runtime.callStatus.error')}</span>`);
    expect(html).toContain(zh('runs.detail.showInThread'));
  });

  it('reads the input of the call from its own session, not a project sibling with the same call id', () => {
    history.events = [
      event('agent.tool.started', { tool_call_id: 'a', input: { command: 'other' } }, 'session-2'),
      event('agent.tool.started', { tool_call_id: 'a', input: { command: 'mine' } }),
    ];
    const html = detail({ call: call('a'), events: true });
    expect(html).toContain('<pre class="cd-code">mine</pre>');
    expect(html).not.toContain('other');
  });

  it('says the events could not be read and offers a retry', () => {
    history.error = 'history read failed';
    try {
      const html = detail({ call: call('a'), events: true });
      expect(html).toMatch(/role="alert"[^>]*>.*history read failed/);
      expect(html).toContain(zh('runtime.retry'));
      expect(html).not.toContain('cd-code');
    } finally {
      history.error = null;
    }
  });

  it('shows only the trace facts for a session without its events', () => {
    const html = detail({ call: call('a'), events: false });
    expect(history.keys.at(-1)).toBeNull();
    expect(html).not.toContain('cd-code');
    expect(html).toContain(`${zh('runtime.callStatus.ok')}</span>`);
    expect(html).toContain(zh('runs.detail.showInThread'));
  });
});
