import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

it('accepts GitHub item queries and user pull request creation', () => {
  expect(querySchemas['github.items'].parse({ project_id: 'project', kind: 'pr' })).toEqual({
    project_id: 'project',
    kind: 'pr',
  });
  expect(
    querySchemas['github.items'].safeParse({ project_id: 'project', kind: 'discussion' }).success,
  ).toBe(false);
  expect(inputSchemas['github.pr.create'].parse({ session_id: 'session', draft: true })).toEqual({
    session_id: 'session',
    draft: true,
  });
});

it('narrows GitHub item queries to the signed-in user only with assigned me', () => {
  expect(
    querySchemas['github.items'].parse({ project_id: 'project', kind: 'issue', assigned: 'me' }),
  ).toEqual({ project_id: 'project', kind: 'issue', assigned: 'me' });
  expect(
    querySchemas['github.items'].safeParse({
      project_id: 'project',
      kind: 'issue',
      assigned: 'octo',
    }).success,
  ).toBe(false);
});

it('accepts mixed session, issue and pull request references with a shared limit of eight', () => {
  const refs = [
    { kind: 'session', id: 'earlier' },
    { kind: 'pr', number: 12 },
    { kind: 'issue', number: 19 },
  ];
  for (const type of ['session.create', 'session.send'] as const) {
    const input =
      type === 'session.create'
        ? { project_id: 'project', runtime: 'fixture', input: 'Read these', refs }
        : { session_id: 'session', input: 'Read these', refs };
    expect(inputSchemas[type].parse(input)).toMatchObject({ refs });
    expect(inputSchemas[type].safeParse({ ...input, refs: Array(9).fill(refs[1]) }).success).toBe(
      false,
    );
    expect(
      inputSchemas[type].safeParse({ ...input, refs: [{ kind: 'issue', number: 1.5 }] }).success,
    ).toBe(false);
  }
});
