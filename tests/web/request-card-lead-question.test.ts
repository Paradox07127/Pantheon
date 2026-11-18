import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'card' }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { QuestionCard } from '../../apps/web/src/components/QuestionCard.js';
import { RequestCard } from '../../apps/web/src/components/RequestCard.js';
import { useDrafts } from '../../apps/web/src/data/drafts.js';
import type { NeedItem } from '../../apps/web/src/screens/board/frame-model.js';
import type { RunBoardCommand } from '../../apps/web/src/screens/board/panels-model.js';

const NOW = Date.UTC(2026, 10, 1, 12);

const asked: NeedItem = {
  source: { table: 'board_plans', id: 'lead-1', revision: 6 },
  kind: 'lead.question',
  project_id: 'project-a',
  session_id: 'lead-1',
  request_id: 'question-1',
  status: 'pending',
  created_at: NOW - 60_000,
  reason: 'lead_question',
  decision: 'question',
  blocks: 0,
  question: {
    id: 'question-1',
    at: NOW - 60_000,
    question: 'Where do sessions live?',
    options: ['SQLite', 'Files', 'Memory'],
    recommended: 'Files',
    assumption: 'sessions stay in SQLite',
    blocks: ['store'],
  },
  actions: [{ command: 'lead.question.answer', allowed: true }],
};

const blocked: NeedItem = {
  source: { table: 'sessions', id: 'worker-1', revision: 7 },
  kind: 'session.failed',
  project_id: 'project-a',
  session_id: 'lead-1',
  task_id: 'lead-1:exports',
  status: 'waiting',
  created_at: NOW - 60_000,
  reason: 'task_blocked',
  decision: 'other',
  blocks: 0,
  blocked: {
    at: NOW - 60_000,
    session_id: 'worker-1',
    task_id: 'exports',
    kind: 'blocked',
    reason: 'missing_permission',
    text: 'The export key is not in the environment',
  },
  actions: [],
};

type Props = Parameters<typeof RequestCard>[0];

function mount(props: Partial<Props> & Pick<Props, 'item'>) {
  const run = vi.fn<RunBoardCommand>(async () => null);
  const h = new HookHost(() =>
    RequestCard({
      size: 'full',
      who: 'Plan sessions',
      now: NOW,
      run,
      onOpenSession: () => {},
      ...props,
    } as Props),
  );
  h.render();
  // A list row opens its question card from its one action.
  if (props.size === 'compact' && props.item.kind === 'lead.question') {
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('board.needs.actions.reply'),
    ).props.onClick();
    h.render();
  }
  return { h, run };
}

/** The question card a request card shows, rendered in a host of its own. */
const card = (tree: ReactNode) => {
  const el = find(tree, (n) => typeof n.type === 'function' && n.type.name === 'QuestionCard');
  const h = new HookHost(() => QuestionCard(el.props));
  h.render();
  return h;
};
const options = (tree: ReactNode) => nodes(tree).filter((n) => n.props.role === 'radio');
const send = (tree: ReactNode) =>
  find(tree, (n) => n.type === 'button' && text(n) === zh('components.questionCard.send'));
const other = (tree: ReactNode) =>
  find(tree, (n) => n.props['aria-label'] === zh('components.questionCard.otherAnswer'));

beforeEach(() => useDrafts.setState({ answers: {} }));

describe('request card for a lead question', () => {
  it.each(['full', 'compact'] as const)(
    'shows the question, the options in the lead order with the recommended one marked, and the assumption in the %s card',
    (size) => {
      const { h } = mount({ item: asked, size });
      const shown = card(h.value).value;
      expect(text(shown)).toContain('Where do sessions live?');
      expect(options(shown).map((n) => text(n))).toEqual([
        'ASQLite',
        `BFiles${zh('components.questionCard.recommended')}`,
        'CMemory',
      ]);
      expect(text(shown)).toContain('在此期间 lead 假定：sessions stay in SQLite');
    },
  );

  it.each(['full', 'compact'] as const)(
    'cuts a long question to six lines with its whole text behind Show more in the %s card',
    (size) => {
      const long = `${'Where do the sessions of every project live once the store moves? '.repeat(12)}${'x'.repeat(300)}`;
      const item = { ...asked, question: { ...asked.question!, question: long } } as NeedItem;
      const shown = card(mount({ item, size }).h.value).value;
      const clipped = find(
        shown,
        (n) => typeof n.type === 'function' && n.type.name === 'Clip' && n.props.text === long,
      );
      expect(clipped.props.lines).toBe(6);
      expect(find(shown, (n) => n.props.role === 'radiogroup').props['aria-label']).toBe(long);
    },
  );

  it('answers with the picked option, or with typed words that replace the pick', async () => {
    const picked = mount({ item: asked });
    const choosing = card(picked.h.value);
    find(options(choosing.value), (n) => text(n).includes('Memory')).props.onClick();
    choosing.render();
    send(choosing.value).props.onClick();
    await picked.h.flush();
    expect(picked.run).toHaveBeenCalledWith(
      'lead.question.answer',
      {
        project_id: 'project-a',
        lead_session_id: 'lead-1',
        question_id: 'question-1',
        answer: 'Memory',
      },
      null,
    );
    expect(send(card(picked.h.value).value).props['aria-disabled']).toBe(true);
    useDrafts.setState({ answers: {} });
    const typed = mount({ item: asked });
    const writing = card(typed.h.value);
    find(options(writing.value), (n) => text(n).includes('SQLite')).props.onClick();
    writing.render();
    other(writing.value).props.onChange({ target: { value: 'Keep them in Postgres' } });
    writing.render();
    send(writing.value).props.onClick();
    await typed.h.flush();
    expect(typed.run).toHaveBeenCalledWith(
      'lead.question.answer',
      expect.objectContaining({ answer: 'Keep them in Postgres' }),
      null,
    );
  });

  it('checks the spelling of a typed answer', () => {
    const { h } = mount({ item: asked });
    expect(other(card(h.value).value).props.spellCheck).toBe(true);
  });

  it.each(['full', 'compact'] as const)(
    'sends nothing, not even the recommended answer, before the user picks and sends in the %s card',
    async (size) => {
      const { h, run } = mount({ item: asked, size });
      const shown = card(h.value).value;
      expect(options(shown).every((n) => n.props['aria-checked'] === false)).toBe(true);
      expect(send(shown).props['aria-disabled']).toBe(true);
      send(shown).props.onClick();
      await h.flush();
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe('request card for a blocked task report', () => {
  it('shows the reason category and the report text', () => {
    for (const size of ['full', 'compact'] as const) {
      const { h } = mount({ item: blocked, size });
      expect(text(h.value)).toContain(zh('data.blockedReason.missingPermission'));
      const what = find(h.value, (n) => n.props.className === 'rq-what');
      expect(text(what)).toContain('The export key is not in the environment');
    }
  });
});
