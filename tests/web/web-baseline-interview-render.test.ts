import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const mock = vi.hoisted(() => ({ body: undefined as string | undefined }));
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({
  useIntroRead: () => ({ read: mock.body === undefined ? null : { intro: { body: mock.body } } }),
}));
vi.mock('@/data/app-settings', () => ({
  useAppSettings: () => ({ settings: { baseline_rounds: 3 } }),
}));
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zh } from './i18n-setup.js';

beforeEach(() => {
  mock.body = undefined;
});

const question = 'Which direction should the next milestone take?';
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
    workstreams: [],
    contradictions: [],
    findings: [],
    questions: [
      {
        id: 'direction',
        header: 'Direction',
        question,
        kind: 'direction',
        options: [
          {
            label: 'Battery first',
            description: 'Power-aware playback',
            preview: {
              kind: 'graph',
              spec: {
                nodes: [
                  { id: 'cap', label: 'Cap frame rate' },
                  { id: 'release', label: 'Release 1.2' },
                ],
                edges: [{ from: 'cap', to: 'release' }],
              },
            },
          },
          {
            label: 'Multiple displays',
            description: 'A wallpaper per display',
            preview: { kind: 'mermaid', spec: { source: 'graph LR\n  model --> picker' } },
          },
          {
            label: 'Direct distribution',
            description: 'Notarized builds',
            preview: {
              kind: 'graph',
              spec: { nodes: [{ id: 'sign', label: 'Signing certificate' }], edges: [] },
            },
          },
        ],
        multiSelect: false,
        recommended: 'Battery first',
      },
    ],
  },
};

it('draws a direction question as three option cards, each with a picture of where it leads', () => {
  const html = renderToStaticMarkup(createElement(ReviewBaseline, { baseline }));
  const start = html.indexOf(`role="radiogroup" aria-label="${question}"`);
  expect(start).toBeGreaterThan(-1);
  const group = html.slice(start, html.indexOf(zh('components.questionCard.otherAnswer'), start));
  expect(group.match(/role="radio"/g)).toHaveLength(3);
  expect(group.match(/role="img"/g)).toHaveLength(3);
  expect(group).toContain('Cap frame rate');
  const picture = group.slice(group.indexOf('role="img"'), group.indexOf('Multiple displays'));
  expect(picture).toContain('<path ');
  for (const label of ['Cap frame rate', 'Release 1.2'])
    expect(picture).toContain(`title="${label}"`);
});

it('draws a Vega-Lite block of the introduction body in the main flow', () => {
  const spec = { mark: 'bar', data: { values: [{ a: 1, b: 2 }] } };
  mock.body = `How a video becomes the wallpaper.\n\n\`\`\`vega-lite\n${JSON.stringify(spec)}\n\`\`\`\n`;
  const html = renderToStaticMarkup(createElement(ReviewBaseline, { baseline }));
  const flow = html.slice(html.indexOf(`aria-label="${zh('projects.baseline.flow.label')}"`));
  expect(flow).toContain('How a video becomes the wallpaper.');
  expect(flow).toContain(`role="group" aria-label="${zh('visual.kind.vegaLite')}"`);
});

it('offers the baseline conversation only where the card is not already in it', () => {
  const withSession = { ...baseline, session_id: 'baseline-session' };
  const onBoard = renderToStaticMarkup(
    createElement(ReviewBaseline, { baseline: withSession, onOpenSession: () => {} }),
  );
  expect(onBoard).toContain(zh('projects.baseline.viewConversation'));
  const inThread = renderToStaticMarkup(createElement(ReviewBaseline, { baseline: withSession }));
  expect(inThread).not.toContain(zh('projects.baseline.viewConversation'));
});
