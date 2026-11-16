import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { inputSchemas } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ send: vi.fn(), rounds: 5 }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'iv' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/data/app-settings', () => ({
  useAppSettings: () => ({ settings: { baseline_rounds: mock.rounds } }),
}));
vi.mock('@/screens/projects/parts', async (actual) => ({
  ...(await actual<object>()),
  useSend: () => ({ busy: false, error: null, receipt: null, send: mock.send }),
}));
import { QuestionCard } from '@/components/QuestionCard';
import { useDrafts } from '@/data/drafts';
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zh, zhf } from './i18n-setup.js';

beforeEach(() => {
  useDrafts.setState({ answers: {} });
  mock.send.mockReset();
  mock.rounds = 5;
});
afterEach(unmountAll);

const graph = (...labels: string[]) => ({
  kind: 'graph' as const,
  spec: {
    nodes: labels.map((label) => ({ id: label, label })),
    edges: labels.slice(1).map((label) => ({ from: labels[0]!, to: label })),
  },
});
const direction = {
  id: 'direction',
  header: 'Direction',
  question: 'Which direction should the next milestone take?',
  kind: 'direction' as const,
  options: [
    {
      label: 'Battery first',
      description: 'Ship 1.2 with power-aware playback',
      preview: graph('Cap frame rate', 'Release 1.2'),
    },
    {
      label: 'Multiple displays',
      description: 'A wallpaper per display',
      preview: graph('Display model', 'Hot-plug'),
    },
    {
      label: 'Direct distribution',
      description: 'Notarized builds outside the App Store',
      preview: graph('Signing certificate', 'Sparkle feed'),
    },
  ],
  multiSelect: false,
  recommended: 'Battery first',
};
const store = {
  id: 'store',
  header: 'Store',
  question: 'Should the Mac App Store build stay?',
  options: [
    { label: 'Keep both builds', description: 'Sandboxed build plus a direct download' },
    { label: 'Direct download only', description: 'Drop the sandbox entitlements' },
  ],
  multiSelect: false,
};
const checks = {
  id: 'checks',
  header: 'Checks',
  question: 'Which checks must pass before a merge?',
  options: [
    { label: 'swift build', description: 'About 40s' },
    { label: 'xcodebuild test', description: 'About 3m' },
    { label: 'swiftlint', description: 'About 6s' },
  ],
  multiSelect: true,
};
const baseline = (questions: unknown[], rounds?: unknown[]): any => ({
  id: 'b1',
  revision: 1,
  project_id: 'p1',
  state: 'submitted',
  runtime: 'claude',
  dropped: 0,
  facts_id: 'f1',
  created_at: 1,
  result: {
    folders: [],
    workstreams: [],
    contradictions: [],
    findings: [],
    brief: { goal: 'Ship', goals: [], non_goals: [], sources: [] },
    questions,
  },
  ...(rounds && { rounds }),
});

const render = (element: ReactElement<any>) =>
  (element.type as (props: unknown) => ReactNode)(element.props);
const card = (h: { value: ReactNode }) =>
  mount(() => QuestionCard(named(h.value, 'QuestionCard').props));
const nth = (tree: ReactNode, n: number, count: number) =>
  find(tree, (x) => x.props['aria-label'] === zhf('components.questionCard.nth', { n, count }));
const option = (tree: ReactNode, label: string) =>
  find(
    tree,
    (x) => x.type === 'button' && /radio|checkbox/.test(x.props.role) && text(x).includes(label),
  );
const decide = (tree: ReactNode) =>
  find(tree, (x) => x.type === 'button' && text(x) === zh('components.questionCard.decide'));
const askMore = (tree: ReactNode) =>
  find(tree, (x) => x.type === 'button' && text(x) === zh('projects.baseline.askMore'));
const confirmed = (tree: ReactNode) => {
  find(tree, (x) => x.props?.tone === 'pri').props.onPress();
  return mock.send.mock.lastCall![0].input.answers;
};

it('sends a question left to the model with the recommended label, and joins picked labels with "; "', () => {
  const h = mount(() => ReviewBaseline({ baseline: baseline([direction, store, checks]) }));
  const c = card(h);
  decide(nth(c.value, 1, 3)).props.onClick();
  option(c.value, 'Keep both builds').props.onClick();
  option(c.value, 'xcodebuild test').props.onClick();
  option(c.value, 'swift build').props.onClick();
  c.render();
  h.render();
  expect(decide(nth(c.value, 1, 3)).props['aria-pressed']).toBe(true);
  expect(decide(nth(c.value, 2, 3)).props['aria-pressed']).toBe(false);
  expect(text(h.value)).toContain(zhf('projects.baseline.answered', { answered: 3, total: 3 }));
  expect(confirmed(h.value)).toEqual([
    {
      question_id: 'direction',
      question: direction.question,
      answer: 'Battery first',
      by: 'model',
    },
    { question_id: 'store', question: store.question, answer: 'Keep both builds', by: 'user' },
    {
      question_id: 'checks',
      question: checks.question,
      answer: 'swift build; xcodebuild test',
      by: 'user',
    },
  ]);
});

it('sends an empty answer for a question left to the model without a recommendation', () => {
  const h = mount(() => ReviewBaseline({ baseline: baseline([store]) }));
  const c = card(h);
  decide(c.value).props.onClick();
  h.render();
  expect(confirmed(h.value)).toEqual([
    { question_id: 'store', question: store.question, answer: '', by: 'model' },
  ]);
});

it("asks for another round with this round's answers", () => {
  const h = mount(() => ReviewBaseline({ baseline: baseline([direction, store]) }));
  const c = card(h);
  option(c.value, 'Multiple displays').props.onClick();
  h.render();
  askMore(h.value).props.onClick();
  const req = mock.send.mock.lastCall![0];
  expect(req).toEqual({
    ok: true,
    type: 'project.baseline.continue',
    input: {
      baseline_id: 'b1',
      answers: [
        {
          question_id: 'direction',
          question: direction.question,
          answer: 'Multiple displays',
          by: 'user',
        },
      ],
    },
    expected_revision: 1,
  });
  expect(inputSchemas['project.baseline.continue'].safeParse(req.input).success).toBe(true);
});

it('does not ask for another round at the round limit', () => {
  mock.rounds = 2;
  const answered = { questions: [store], answers: [], at: 1 };
  const h = mount(() => ReviewBaseline({ baseline: baseline([checks], [answered]) }));
  const button = askMore(h.value);
  expect(button.props['aria-disabled']).toBe(true);
  const why = find(h.value, (x) => x.props.id === button.props['aria-describedby']);
  expect(text(why)).toBe(zhf('projects.baseline.roundLimit', { round: 2, limit: 2 }));
  button.props.onClick();
  expect(mock.send).not.toHaveBeenCalled();
});

it('opens an answered round to its questions and answers', async () => {
  const answered = {
    questions: [store, checks],
    answers: [
      { question_id: 'store', question: store.question, answer: 'Keep both builds', by: 'model' },
      { question_id: 'checks', question: checks.question, answer: 'swiftlint', by: 'user' },
    ],
    at: 1,
  };
  const h = mount(() => ReviewBaseline({ baseline: baseline([direction], [answered]) }));
  expect(text(h.value)).toContain(zhf('projects.baseline.round', { round: 2, limit: 5 }));
  const round = nodes(h.value).find(
    (x) => typeof x.type === 'function' && x.type.name === 'AnsweredRound',
  )!;
  const r = mount(() => render(round));
  const toggle = find(r.value, (x) => x.type === 'button' && 'aria-expanded' in x.props);
  expect(toggle.props['aria-expanded']).toBe(false);
  expect(text(r.value)).not.toContain(store.question);
  toggle.props.onClick();
  await r.flush();
  expect(text(r.value)).toContain(store.question);
  expect(text(r.value)).toContain('Keep both builds');
  expect(text(r.value)).toContain(checks.question);
  expect(
    nodes(r.value).filter((x) => text(x) === zh('projects.baseline.decidedForYou')),
  ).toHaveLength(1);
});
