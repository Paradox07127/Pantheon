import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@/data/sync';
import {
  buildTranscript,
  foldTurn,
  groupToolCalls,
  type SessionTurn,
  type ToolItem,
} from '@/data/transcript';

const turn = (id: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});

const event = (
  sequence: number,
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});

const RESULT = { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { temp: 21 } };

describe('interface tool calls in the transcript', () => {
  it('keeps the interface of a started call and the result its completion carries', () => {
    const view = buildTranscript(
      [turn('turn-weather')],
      [
        event(1, 'agent.tool.started', 'session-main', {
          turn_id: 'turn-weather',
          tool_call_id: 'call-weather',
          name: 'mcp__weather__show_weather',
          input: { city: 'London' },
          app: { server: 'weather', resource_uri: 'ui://weather/view' },
        }),
        event(2, 'agent.tool.completed', 'session-main', {
          turn_id: 'turn-weather',
          tool_call_id: 'call-weather',
          ok: true,
          output: 'Sunny',
          app_result: RESULT,
        }),
      ],
    );
    const call = view.turns[0]!.items[0] as ToolItem;
    expect(call.app).toEqual({ server: 'weather', resource_uri: 'ui://weather/view' });
    expect(call.app_result).toEqual(RESULT);
  });

  it('marks a message an interface sent with its server', () => {
    const sent = turn('turn-from-app');
    const view = buildTranscript(
      [sent, turn('turn-typed')],
      [
        event(1, 'turn.queued', 'turn-from-app', { ...sent, app: { server: 'weather' } }),
        event(2, 'turn.queued', 'turn-typed', turn('turn-typed')),
      ],
    );
    expect(view.turns[0]!.app).toEqual({ server: 'weather' });
    expect(view.turns[1]!.app).toBeUndefined();
  });

  it('keeps a call with an interface out of folded runs and folded work', () => {
    const read: ToolItem = { kind: 'tool', id: 'call-read', name: 'Read', input: {}, ok: true };
    const shown: ToolItem = {
      kind: 'tool',
      id: 'call-weather',
      name: 'mcp__weather__show_weather',
      input: {},
      ok: true,
      app: { server: 'weather', resource_uri: 'ui://weather/view' },
    };
    const edit: ToolItem = { kind: 'tool', id: 'call-edit', name: 'Edit', input: {}, ok: true };
    expect(groupToolCalls([read, shown, edit])).toEqual([read, shown, edit]);
    const fold = foldTurn([read, shown, edit, { kind: 'text', text: 'Done' }]);
    expect(fold?.work).toEqual([read, edit]);
    expect(fold?.kept).toEqual([shown]);
  });
});
