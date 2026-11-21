import { expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectFactsRead } from '@pantheon/protocol';
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zh } from './i18n-setup.js';

const importer = {
  id: 'importer',
  title: 'Importer',
  status: 'done' as const,
  reason: 'CSV and JSON parse',
  items: [],
  commits: ['commit:6e9b7a3f00'],
  next: [],
  blockers: [],
};
const exporter = {
  id: 'exporter',
  title: 'Exporter',
  status: 'running' as const,
  reason: 'The writer is half done',
  items: [],
  commits: [],
  next: ['Write the JSON exporter'],
  blockers: ['The export format is not chosen'],
  modules: ['src/export', 'src/cli.ts'],
  depends_on: ['importer'],
  risks: ['Large files run out of memory'],
};
const baseline: any = {
  id: 'b1',
  revision: 1,
  project_id: 'p1',
  state: 'submitted',
  dropped: 0,
  facts_id: 'f1',
  created_at: 1,
  result: {
    folders: [],
    workstreams: [importer, exporter],
    contradictions: [{ text: 'The README calls the exporter done', refs: ['file:README.md:4'] }],
    findings: [
      { text: 'Exports load the whole file', refs: ['file:src/export/write.ts'], severity: 'risk' },
    ],
    questions: [],
  },
};

const group = (html: string, label: string) => {
  const start = html.indexOf(`aria-label="${label}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
};

it('shows each workstream with its modules, dependencies, risks, next steps and blockers', () => {
  const html = renderToStaticMarkup(createElement(ReviewBaseline, { baseline }));
  const structure = group(html, zh('projects.baseline.structure'));
  const stream = group(structure, 'Exporter');
  for (const text of [
    'src/export',
    'src/cli.ts',
    'Importer',
    'Large files run out of memory',
    'Write the JSON exporter',
    'The export format is not chosen',
  ])
    expect(stream).toContain(text);
  expect(structure).toContain(zh('projects.baseline.structure.modules'));
  expect(structure).toContain(zh('projects.baseline.structure.dependsOn'));
  expect(structure).toContain(zh('projects.baseline.structure.risks'));
});

it('shows the findings and the contradictions the baseline handed back', () => {
  const html = renderToStaticMarkup(createElement(ReviewBaseline, { baseline }));
  expect(group(html, zh('projects.baseline.findings'))).toContain('Exports load the whole file');
  expect(group(html, zh('projects.baseline.contradictions'))).toContain(
    'The README calls the exporter done',
  );
});
