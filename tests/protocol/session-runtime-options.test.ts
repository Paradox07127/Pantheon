import { expect, it } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';

it('accepts rollback scopes and keeps the omitted scope absent', () => {
  const input = { session_id: 'session', turn_id: 'turn' };
  expect(inputSchemas['session.rollback'].parse(input)).toEqual(input);
  for (const scope of ['files', 'conversation', 'both'])
    expect(inputSchemas['session.rollback'].parse({ ...input, scope })).toEqual({
      ...input,
      scope,
    });
  expect(inputSchemas['session.rollback'].safeParse({ ...input, scope: 'unknown' }).success).toBe(
    false,
  );
});

it('accepts a span fork point exclusively with a turn fork point', () => {
  const input = { session_id: 'session', input: 'Continue', before_span_id: 'tool-call' };
  expect(inputSchemas['session.fork'].parse(input)).toEqual(input);
  expect(inputSchemas['session.fork'].safeParse({ ...input, before_turn_id: 'turn' }).success).toBe(
    false,
  );
});

it('accepts an explicit connector list including an empty override', () => {
  for (const enabled of [[], ['calendar']])
    expect(inputSchemas['session.setConnectors'].parse({ session_id: 'session', enabled })).toEqual(
      { session_id: 'session', enabled },
    );
  expect(
    inputSchemas['session.setConnectors'].safeParse({ session_id: 'session', enabled: [1] })
      .success,
  ).toBe(false);
});
