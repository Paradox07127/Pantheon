import { afterEach, expect, it, vi } from 'vitest';
import { find, mount, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'ap' }),
);
vi.mock('@/data/facts-read', () => ({ useFactsRead: () => ({ read: null }) }));
vi.mock('@/data/intro-read', () => ({ useIntroRead: () => ({ read: null }) }));
vi.mock('@/screens/projects/parts', async (actual) => ({
  ...(await actual<object>()),
  useSend: () => ({ busy: false, error: null, receipt: null, send: mock.send }),
}));
import { ReviewBaseline } from '@/screens/projects/BaselineBlocks';
import { zhf } from './i18n-setup.js';

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
    questions: [{ question, options: ['App Store', 'Follow-ups'] }],
  },
};
const other = (tree: any) =>
  find(tree, (n) => n.props?.['aria-label'] === zhf('projects.baseline.otherAnswer', { question }));
const pressed = (tree: any) =>
  nodes(tree)
    .filter((n) => n.type === 'button' && n.props['aria-pressed'])
    .map((n) => n.props.children);
const confirmed = (tree: any) => {
  find(tree, (n) => n.props?.tone === 'pri').props.onPress();
  return mock.send.mock.lastCall![0].input.answers;
};

it('sends an answer the user wrote in place of the offered options', async () => {
  const h = mount(() => ReviewBaseline({ baseline }));
  find(h.value, (n) => n.type === 'button' && n.props.children === 'App Store').props.onClick();
  await h.flush();
  other(h.value).props.onChange({ target: { value: 'Neither: fix the crash reports' } });
  await h.flush();
  expect(other(h.value).props.value).toBe('Neither: fix the crash reports');
  expect(pressed(h.value)).toEqual([]);
  expect(confirmed(h.value)).toEqual([{ question, answer: 'Neither: fix the crash reports' }]);
  find(h.value, (n) => n.type === 'button' && n.props.children === 'Follow-ups').props.onClick();
  await h.flush();
  expect(other(h.value).props.value).toBe('');
  expect(confirmed(h.value)).toEqual([{ question, answer: 'Follow-ups' }]);
});
