import { describe, expect, it } from 'vitest';
import { briefRequest } from '@/screens/projects/brief';
import { zh } from './i18n-setup.js';

describe('project facts commands', () => {
  it('sets the brief against the revision shown, null for the first one', () => {
    const draft = { goal: ' Ship ', goals: 'a\n\n b ', non_goals: '' };
    const first = briefRequest('alpha', undefined, draft);
    expect(first).toMatchObject({
      ok: true,
      expected_revision: null,
      input: { project_id: 'alpha', goal: 'Ship', goals: ['a', 'b'], non_goals: [] },
    });
    const brief = { id: 'alpha', revision: 3, goal: 'Ship', goals: ['a', 'b'], non_goals: [] };
    expect(briefRequest('alpha', brief as never, draft)).toEqual({
      ok: false,
      errors: [zh('projects.brief.unchanged')],
    });
    expect(briefRequest('alpha', brief as never, { ...draft, goal: 'Other' })).toMatchObject({
      expected_revision: 3,
    });
  });
});
