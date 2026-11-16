import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

const comment = {
  session_id: 'session',
  path: 'src/answer.ts',
  line: 12,
  side: 'new',
  text: 'Explain this change',
};

it('accepts strict diff comment inputs and bounds text at ten thousand code points', () => {
  const schema = inputSchemas['session.comment.add'];
  expect(schema.parse(comment)).toEqual(comment);
  expect(schema.parse({ ...comment, side: 'old' }).side).toBe('old');
  for (const text of ['', '   ', 'x'.repeat(10_001), '😀'.repeat(10_001)])
    expect(schema.safeParse({ ...comment, text }).success).toBe(false);
  expect(schema.safeParse({ ...comment, text: '😀'.repeat(10_000) }).success).toBe(true);
  expect(schema.safeParse({ ...comment, extra: true }).success).toBe(false);
});

it("takes the commented line's text and the turn of the diff it was made on", () => {
  const schema = inputSchemas['session.comment.add'];
  const placed = { ...comment, line_text: '  return readToken();', turn_id: 'turn' };
  expect(schema.parse(placed)).toEqual(placed);
  expect(schema.parse({ ...comment, line_text: '' }).line_text).toBe('');
  expect(schema.safeParse({ ...comment, line_text: 'x'.repeat(10_001) }).success).toBe(false);
  expect(schema.safeParse({ ...comment, turn_id: '' }).success).toBe(false);
});

it('accepts only sent or kept as a comment resolution and a strict deletion input', () => {
  const resolve = inputSchemas['session.comment.resolve'];
  for (const state of ['sent', 'kept'])
    expect(resolve.parse({ comment_id: 'comment', state })).toEqual({
      comment_id: 'comment',
      state,
    });
  for (const state of ['open', 'deleted'])
    expect(resolve.safeParse({ comment_id: 'comment', state }).success).toBe(false);
  expect(resolve.safeParse({ comment_id: 'comment', state: 'sent', extra: true }).success).toBe(
    false,
  );
  const remove = inputSchemas['session.comment.delete'];
  expect(remove.parse({ comment_id: 'comment' })).toEqual({ comment_id: 'comment' });
  expect(remove.safeParse({ comment_id: 'comment', extra: true }).success).toBe(false);
});

it('lists comments with only a session identifier', () => {
  const schema = querySchemas['session.comments'];
  expect(schema.parse({ session_id: 'session' })).toEqual({ session_id: 'session' });
  expect(schema.safeParse({}).success).toBe(false);
  expect(schema.safeParse({ session_id: 'session', extra: true }).success).toBe(false);
});
