import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApprovalQuestion } from '@pantheon/domain';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector({ events: [], status: {} }), {
    getState: () => ({}),
  }),
}));
vi.mock('@/components/Clip', async (actual) => {
  const { Clip } = (await actual()) as typeof import('@/components/Clip');
  return { Clip: vi.fn(Clip) };
});
import { Clip } from '@/components/Clip';
import { Markdown } from '@/components/Markdown';
import { QuestionCard } from '@/components/QuestionCard';
import { useDrafts } from '@/data/drafts';
import { jumpToQuestion, PendingQuestions } from '@/screens/sessions/RequestCards';
import { zh, zhf } from './i18n-setup.js';

beforeEach(() => {
  useDrafts.setState({ answers: {} });
});

const smoke: ApprovalQuestion = {
  question: 'Which packages must pass a device smoke test?',
  header: 'Smoke',
  multiSelect: true,
  options: [
    { label: 'macOS arm64', description: 'Signed dmg' },
    { label: 'Linux x64', description: 'deb and AppImage' },
  ],
} as ApprovalQuestion;
const track: ApprovalQuestion = {
  question: 'Where should open work be tracked?',
  header: 'Track',
  multiSelect: false,
  options: [
    { label: 'Pantheon board', description: 'The lead plan' },
    { label: 'GitHub issues', description: 'The issue tracker' },
  ],
} as ApprovalQuestion;

const answerable = { reason: null, busy: false, error: null, onSend: () => {} };
const card = (questions: ApprovalQuestion[]) =>
  renderToStaticMarkup(
    createElement(QuestionCard, { ...answerable, draft: 'd', questions, label: 'Open questions' }),
  );
/** The markup of the element whose opening tag carries `attr`, up to the next `until`. */
const slice = (html: string, attr: string, until: string) => {
  const start = html.indexOf(attr);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(until, start + attr.length));
};

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

const LONG = Array.from({ length: 40 }, (_, n) => `Step ${n + 1} of the release checklist.`).join(
  ' ',
);
it('cuts the description of an option to six lines outside the option, which it describes', () => {
  const q = { ...track, options: [{ label: 'Pantheon board', description: LONG }] };
  const html = card([q]);
  const option = slice(html, 'role="radio"', '</button>');
  expect(option).not.toContain('<button');
  expect(option).not.toContain(LONG);
  const name = option
    .slice(option.indexOf('>') + 1)
    .replace(/<span[^>]*aria-hidden="true"[^>]*>.*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '');
  expect(name).toBe(q.options[0]!.label);
  const about = option.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(about).toBeTruthy();
  expect(slice(html, `id="${about}"`, '</')).toContain(LONG);
  expect(vi.mocked(Clip).mock.calls.map(([props]) => props)).toContainEqual(
    expect.objectContaining({ id: about, text: LONG, lines: 6 }),
  );
});

it('gives each of two copies of a question its own description ids, each option pointing into its copy', () => {
  const props = { ...answerable, draft: 'd', questions: [track], label: 'Open questions' };
  const html = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(QuestionCard, props),
      createElement(QuestionCard, props),
    ),
  );
  const copies = html.split('aria-label="Open questions"').slice(1);
  expect(copies).toHaveLength(2);
  const ids = copies.map((copy) => [...copy.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  expect(ids.map((own) => own.length)).toEqual([2, 2]);
  expect(ids[0]!.filter((id) => ids[1]!.includes(id))).toEqual([]);
  for (const [n, copy] of copies.entries())
    expect([...copy.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1])).toEqual(ids[n]);
});

const pending = (questions: ApprovalQuestion[]) => [
  { id: 'approval-1', tool: 'AskUserQuestion', revision: 1, questions } as any,
];
const jump = (props: any) =>
  renderToStaticMarkup(
    createElement(PendingQuestions, { scroller: { current: null }, pending: [], ...props }),
  );

it('offers a jump to the questions a pending request still waits on, until all are answered', () => {
  useDrafts.getState().answer('approval-1', { picked: [[], ['GitHub issues']], typed: ['', ''] });
  const html = jump({ pending: pending([smoke, track]) });
  expect(html).toContain('<button');
  expect(html).toContain(zhf('sessions.card.pendingQuestions', { count: 1 }));

  useDrafts
    .getState()
    .answer('approval-1', { picked: [['Linux x64'], ['GitHub issues']], typed: ['', ''] });
  expect(jump({ pending: pending([smoke, track]) })).toBe('');
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
