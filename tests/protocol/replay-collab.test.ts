import { expect, it } from 'vitest';
import { querySchemas } from '@pantheon/protocol';

it('validates step identity and an inclusive collaboration time range', () => {
  expect(
    querySchemas['session.step_diff'].parse({
      session_id: 'writer',
      turn_id: 'turn',
      span_id: 'edit',
    }),
  ).toEqual({ session_id: 'writer', turn_id: 'turn', span_id: 'edit' });
  expect(
    querySchemas['session.step_diff'].safeParse({ session_id: 'writer', turn_id: 'turn' }).success,
  ).toBe(false);
  expect(
    querySchemas['project.collab'].parse({
      project_id: 'project',
      since: '1000',
      until: '2000',
    }),
  ).toEqual({ project_id: 'project', since: 1000, until: 2000 });
  expect(
    querySchemas['project.collab'].safeParse({ project_id: 'project', since: 2000, until: 1000 })
      .success,
  ).toBe(false);
});
