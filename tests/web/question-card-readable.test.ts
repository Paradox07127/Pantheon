import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const mock = vi.hoisted(() => ({ baseline: null as any }));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
vi.mock('@/store', () => ({ useShell: (selector: any) => selector({ openSession() {} }) }));
vi.mock('@/data/baseline-read', () => ({ useBaselineRead: () => ({ read: mock.baseline }) }));
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/data/app-settings', () => ({
  useAppSettings: () => ({ settings: { baseline_rounds: 3 } }),
}));
import { Markdown } from '@/components/Markdown';
import { QuestionCard, type CardQuestion } from '@/components/QuestionCard';
import { useDrafts } from '@/data/drafts';
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { jumpToQuestion, PendingQuestions } from '@/screens/sessions/RequestCards';
import { zh, zhf } from './i18n-setup.js';

beforeEach(() => {
  useDrafts.setState({ answers: {} });
  mock.baseline = null;
});

const direction: CardQuestion = {
  question: 'Which direction should the next stretch of work take?',
  header: 'Direction',
  multiSelect: false,
  options: [
    {
      label: 'Pass release acceptance',
      description: 'Make the full acceptance pass',
      preview: {
        kind: 'graph',
        spec: {
          nodes: [
            { id: 'fix', label: 'Fix failing acceptance scenarios on every platform' },
            { id: 'run', label: 'Run acceptance on the release candidate' },
            { id: 'sign', label: 'Fix signing docs' },
          ],
          edges: [{ from: 'run', to: 'fix' }],
        },
      },
    },
    { label: 'Stabilize orchestration', description: 'Make dispatch reliable' },
  ],
} as CardQuestion;
const smoke: CardQuestion = {
  question: 'Which packages must pass a device smoke test?',
  header: 'Smoke',
  multiSelect: true,
  options: [
    { label: 'macOS arm64', description: 'Signed dmg' },
    { label: 'Linux x64', description: 'deb and AppImage' },
  ],
} as CardQuestion;
const track: CardQuestion = {
  question: 'Where should open work be tracked?',
  header: 'Track',
  multiSelect: false,
  options: [
    { label: 'Pantheon board', description: 'The lead plan' },
    { label: 'GitHub issues', description: 'The issue tracker' },
  ],
} as CardQuestion;

const card = (questions: CardQuestion[]) =>
  renderToStaticMarkup(
    createElement(QuestionCard, { group: true, draft: 'd', questions, label: 'Open questions' }),
  );
/** The markup of the element whose opening tag carries `attr`, up to the next `until`. */
const slice = (html: string, attr: string, until: string) => {
  const start = html.indexOf(attr);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(until, start + attr.length));
};

it('draws an option preview as a task graph whose every node carries its full name', () => {
  const option = slice(card([direction]), 'Pass release acceptance', 'Stabilize orchestration');
  const picture = slice(option, 'role="img"', '</button>');
  expect(picture.match(/<path /g)).toHaveLength(1);
  const named = [...picture.matchAll(/title="([^"]*)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
  expect(named).toEqual(
    [
      'Fix failing acceptance scenarios on every platform',
      'Run acceptance on the release candidate',
      'Fix signing docs',
    ].map((label) => [label, label]),
  );
});

it('draws a picked option of a multiple choice question as a ticked box, a picked single choice by its letter', () => {
  useDrafts.getState().answer('d', {
    picked: [['macOS arm64'], ['Pantheon board']],
    typed: ['', ''],
  });
  const html = card([smoke, track]);
  const multi = slice(html, `role="group" aria-label="${smoke.question}"`, track.question);
  expect(multi.match(/role="checkbox"/g)).toHaveLength(2);
  const ticked = slice(multi, 'aria-checked="true"', 'macOS arm64');
  expect(ticked).toContain('<svg');
  const single = slice(html, `role="radiogroup" aria-label="${track.question}"`, 'GitHub issues');
  expect(slice(single, 'aria-checked="true"', 'Pantheon board')).not.toContain('<svg');
});

it('marks only the questions still unanswered as open', () => {
  useDrafts.getState().answer('d', { picked: [[], ['GitHub issues']], typed: ['', ''] });
  expect(card([smoke, track]).match(/data-open=/g)).toHaveLength(1);
});

const session = {
  id: 's1',
  project_id: 'p1',
  workspace_id: null,
  baseline: { baseline_id: 'b1' },
} as any;
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
      { id: 'q1', ...smoke },
      { id: 'q2', ...track },
    ],
  },
};
const pending = (questions: CardQuestion[]) => [
  { id: 'approval-1', tool: 'AskUserQuestion', revision: 1, questions } as any,
];
const jump = (props: any) =>
  renderToStaticMarkup(
    createElement(PendingQuestions, { scroller: { current: null }, pending: [], ...props }),
  );

it('offers a jump to the questions a baseline and a pending request still wait on, until all are answered', () => {
  mock.baseline = baseline;
  useDrafts
    .getState()
    .answer('baseline:b1:1', { picked: [[], ['GitHub issues']], typed: ['', ''] });
  const html = jump({ session, pending: pending([track]) });
  expect(html).toContain('<button');
  expect(html).toContain(zhf('sessions.card.pendingQuestions', { count: 2 }));

  useDrafts.getState().answer('baseline:b1:1', { picked: [['Linux x64'], []], typed: ['', 'x'] });
  useDrafts.getState().answer('approval-1', { picked: [['Pantheon board']], typed: [''] });
  expect(jump({ session, pending: pending([track]) })).toBe('');
});

it('does not count a question left to the model as one to answer', () => {
  useDrafts.getState().answer('approval-1', { picked: [[]], typed: [''], decided: [true] });
  expect(jump({ session, pending: pending([track]) })).toBe('');
});

it('does not count a baseline that no longer waits for confirmation', () => {
  mock.baseline = { ...baseline, state: 'confirmed' };
  expect(jump({ session })).toBe('');
});

it('scrolls to the first open question and focuses its first control', () => {
  const control = { focus: vi.fn() };
  const question = { scrollIntoView: vi.fn(), querySelector: vi.fn(() => control) };
  const scroller = { querySelector: vi.fn(() => question) };
  jumpToQuestion(scroller as any);
  expect(scroller.querySelector).toHaveBeenCalledWith('[data-open]');
  expect(question.scrollIntoView).toHaveBeenCalled();
  expect(control.focus).toHaveBeenCalled();
});

it('keeps the answered count and the baseline buttons together in one bar under the questions', () => {
  const html = renderToStaticMarkup(createElement(ReviewBaseline, { baseline }));
  const bar = slice(html, `aria-label="${zh('projects.baseline.answerBar')}"`, '</div>');
  expect(bar).toContain(zh('projects.baseline.askMore'));
  expect(bar).toContain(zh('projects.baseline.confirmBaseline'));
  expect(bar).toContain(zhf('projects.baseline.answered', { answered: 0, total: 2 }));
  expect(html.indexOf(track.question)).toBeLessThan(html.indexOf(bar));
});

it('names a mermaid card by the title in its front matter, else by its kind', () => {
  const titled = renderToStaticMarkup(
    createElement(Markdown, {
      text: '```mermaid\n---\ntitle: Build, check and release\n---\ngraph LR\na-->b\n```\n',
    }),
  );
  expect(titled).toContain('aria-label="Build, check and release"');
  expect(titled).not.toContain(`>${zh('visual.kind.mermaid')}<`);
  const plain = renderToStaticMarkup(
    createElement(Markdown, { text: '```mermaid\ngraph LR\na-->b\n```\n' }),
  );
  expect(plain).toContain(`aria-label="${zh('visual.kind.mermaid')}"`);
});
