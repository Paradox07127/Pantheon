import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'ap' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/data/app-settings', () => ({ useAppSettings: () => ({ settings: null }) }));
vi.mock('@/screens/projects/parts', async (actual) => ({
  ...(await actual<object>()),
  useSend: () => ({ busy: false, error: null, receipt: null, send: mock.send }),
}));
import { QuestionCard } from '@/components/QuestionCard';
import { useDrafts } from '@/data/drafts';
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zh } from './i18n-setup.js';

beforeEach(() => useDrafts.setState({ answers: {} }));
afterEach(unmountAll);

const question = 'Ship the App Store edition or the review follow-ups first?';
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
    brief: { goal: 'Ship', goals: [], non_goals: [], sources: [] },
    questions: [
      {
        id: 'order',
        header: 'Order',
        question,
        options: [
          { label: 'App Store', description: 'Ship the App Store edition' },
          { label: 'Follow-ups', description: 'Fix the review follow-ups' },
        ],
        multiSelect: false,
      },
    ],
  },
};
const card = (tree: ReactNode) => mount(() => QuestionCard(named(tree, 'QuestionCard').props));
const other = (tree: ReactNode) =>
  find(tree, (n) => n.props?.['aria-label'] === zh('components.questionCard.otherAnswer'));
const option = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.type === 'button' && n.props.role === 'radio' && text(n).includes(label));
const checked = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => n.type === 'button' && n.props['aria-checked'])
    .map((n) => n.props.children);
const confirmed = (tree: ReactNode) => {
  find(tree, (n) => n.props?.tone === 'pri').props.onPress();
  return mock.send.mock.lastCall![0].input.answers;
};

it('sends an answer the user wrote in place of the offered options', () => {
  const h = mount(() => ReviewBaseline({ baseline }));
  const c = card(h.value);
  option(c.value, 'App Store').props.onClick();
  c.render();
  other(c.value).props.onChange({ target: { value: 'Neither: fix the crash reports' } });
  c.render();
  h.render();
  expect(other(c.value).props.value).toBe('Neither: fix the crash reports');
  expect(checked(c.value)).toEqual([]);
  expect(confirmed(h.value)).toEqual([
    { question_id: 'order', question, answer: 'Neither: fix the crash reports', by: 'user' },
  ]);
  option(c.value, 'Follow-ups').props.onClick();
  c.render();
  h.render();
  expect(other(c.value).props.value).toBe('');
  expect(confirmed(h.value)).toEqual([
    { question_id: 'order', question, answer: 'Follow-ups', by: 'user' },
  ]);
});
