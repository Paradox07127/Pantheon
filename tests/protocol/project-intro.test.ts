import { expect, it } from 'vitest';
import { inputSchemas, querySchemas } from '@pantheon/protocol';

const input = {
  summary: 'A library that reads notes.',
  sources: ['file:README.md'],
  features: [
    { title: 'Read notes', text: 'Reads Markdown notes.', sources: ['file:src/index.ts'] },
  ],
  modules: [{ path: 'src', role: 'Reads notes.', entry: 'src/index.ts' }],
};

it('declares the introduction commands and keeps measured fields and project identity out of submission', () => {
  const schema = inputSchemas['project.intro.submit'];
  expect(schema).toBeDefined();
  expect(schema.parse(input)).toEqual(input);
  expect(inputSchemas['project.intro.start'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
  });
  expect(querySchemas['project.intro.read'].parse({ project_id: 'project' })).toEqual({
    project_id: 'project',
  });
  for (const field of ['project_id', 'languages', 'weeks', 'heads', 'written_at', 'session_id'])
    expect(schema.safeParse({ ...input, [field]: 'invented' }).success, field).toBe(false);
});

it.each([
  ['summary', { summary: 'x'.repeat(281) }],
  ['title', { features: [{ ...input.features[0], title: 'x'.repeat(81) }] }],
  ['text', { features: [{ ...input.features[0], text: 'x'.repeat(401) }] }],
  ['features', { features: Array(13).fill(input.features[0]) }],
  ['modules', { modules: Array(41).fill(input.modules[0]) }],
  ['path', { modules: [input.modules[0], input.modules[0]] }],
  ['role', { modules: [{ ...input.modules[0], role: 'x'.repeat(401) }] }],
  ['lines', { modules: [{ ...input.modules[0], lines: 10 }] }],
  ['commits_30d', { modules: [{ ...input.modules[0], commits_30d: 10 }] }],
  [
    'architecture',
    {
      architecture: {
        nodes: [{ id: 'app', label: 'App' }],
        edges: [{ from: 'app', to: 'missing' }],
      },
    },
  ],
  ['body', { body: 'x'.repeat(20001) }],
  ['sources', { sources: ['https://example.invalid'] }],
])('names the invalid %s field', (field, patch) => {
  expect(inputSchemas['project.intro.submit']).toBeDefined();
  expect(() => inputSchemas['project.intro.submit'].parse({ ...input, ...patch })).toThrow(field);
});
