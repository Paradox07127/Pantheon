import { useEffect, useRef } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { runCommand } from '../data/commands';
import type { NeedsYouItem } from '../data/needs-you';
import {
  answerFailed,
  answeredInStrip,
  becameReady,
  groupCard,
  liveCards,
  needsCard,
  needsKey,
  reviewCards,
  stoppedWaiting,
  turnEndHold,
  waitInView,
  BOARD_LIST_HOLD_MS,
  WATCH_CHANNEL,
  type Decision,
  type NoticeWatch,
  type ResultCard,
  type WatchWord,
} from '../data/notice-tiers';
import { inQuietHours, withFocus, type NoticeCursor } from '../data/notifications';
import { shownSessionId } from '../screens/sessions/SessionsScreen';
import { useShell } from '../store';
import { closeNotice, noticeNeeds, noticeResult } from './Toast';

// How long a result card stays on screen.
const RESULT_MS = 5000;

/** The result cards of one kind on screen: single ones, or the one they were folded into. */
interface Pile {
  singles: { id: string; at: number; passed: boolean }[];
  folded: { count: number; at: number; passed: boolean } | null;
}

async function answer(item: NeedsYouItem, decision: Decision, heading: string) {
  const result = await runCommand(
    'approval.respond',
    { approval_id: item.source.id, decision },
    item.source.revision,
  );
  if (!result.ok) noticeResult(answerFailed(heading, result.error));
}

/** Shows a result, folding a third of its kind and project on screen into one card. */
function showResult(piles: Map<string, Pile>, card: ResultCard) {
  if (!card.group) {
    noticeResult(card.options);
    return;
  }
  const now = Date.now();
  const key = `${card.project_id}\n${card.group}`;
  const pile = piles.get(key) ?? { singles: [], folded: null };
  pile.singles = pile.singles.filter((s) => now - s.at < RESULT_MS);
  if (pile.folded && now - pile.folded.at >= RESULT_MS) pile.folded = null;
  const passed = !!card.passed;
  if (pile.folded || pile.singles.length >= 2) {
    pile.singles.forEach((s) => closeNotice(s.id));
    pile.folded = {
      count: (pile.folded?.count ?? pile.singles.length) + 1,
      at: now,
      passed: (pile.folded?.passed ?? pile.singles.every((s) => s.passed)) && passed,
    };
    pile.singles = [];
    noticeResult(groupCard(card.group, card.project_id, pile.folded.count, pile.folded.passed));
  } else pile.singles.push({ id: noticeResult(card.options), at: now, passed });
  piles.set(key, pile);
}

/**
 * Shows the in-app cards of every project: approvals and questions until they are answered,
 * and the results and failures that arrive while the app is in front.
 */
export function NoticeFeed({
  projectId,
  sessions,
  allNeeds,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
  allNeeds: readonly NeedsYouItem[] | null;
}) {
  const board = useBoard((s) => s.board);
  const events = useBoard((s) => s.events);
  const resync = useBoard((s) => s.resync);
  const cursor = useRef<NoticeCursor | null>(null);
  const seenNeeds = useRef(new Set<string>());
  // The cards that need the user on screen, by id, with what waitInView asks of them.
  const openNeeds = useRef(
    new Map<
      string,
      { project: string; session: string | null; approval: boolean; strip: boolean }
    >(),
  );
  const before = useRef<{ projectId: string; sessions: readonly WorkbenchSession[] } | null>(null);
  // By project and kind.
  const piles = useRef(new Map<string, Pile>());
  const hold = useRef(turnEndHold());
  const heldNeeds = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Approvals whose hold ran out before the board in front listed its waits; each shows its card if still due.
  const overdueNeeds = useRef(new Map<string, () => void>());
  // The session each session window shows while it has focus, by window.
  const elsewhere = useRef(new Map<string, string>());
  useEffect(
    () => () => {
      hold.current.stop();
      for (const timer of heldNeeds.current.values()) clearTimeout(timer);
    },
    [],
  );
  useEffect(() => {
    const channel = new BroadcastChannel(WATCH_CHANNEL);
    channel.onmessage = ({ data }: MessageEvent<WatchWord>) => {
      if (data.session_id) elsewhere.current.set(data.window, data.session_id);
      else elsewhere.current.delete(data.window);
    };
    return () => channel.close();
  }, []);

  const shell = useShell();
  const watch = (state = useShell.getState()): NoticeWatch => ({
    sessionId:
      state.screen === 'sessions'
        ? shownSessionId(state.sessionId, state.followed, sessions)
        : null,
    queue:
      state.screen === 'trace' && state.traceTab === 'runs' && state.runsView === 'now'
        ? projectId
        : null,
    listed: state.screen === 'board' ? state.boardWaits : null,
    focused: document.hasFocus(),
    elsewhere: new Set(elsewhere.current.values()),
  });
  const boardPending = (state = useShell.getState()) =>
    state.screen === 'board' && state.boardWaits === null;
  const close = (id: string) => {
    closeNotice(id);
    openNeeds.current.delete(id);
  };
  // In the background the system notification tells a result or a failure instead.
  const result = (card: ResultCard) =>
    withFocus((front) => {
      if (front) showResult(piles.current, card);
    });

  useEffect(() => {
    if (!allNeeds || !board) return;
    // Which session the Sessions screen shows can depend on its list.
    if (useShell.getState().screen === 'sessions' && !sessions) return;
    const view = watch();
    const quiet = inQuietHours();
    const present = new Set<string>();
    for (const item of allNeeds) {
      const key = needsKey(item);
      if (!key) continue;
      present.add(key);
      if (seenNeeds.current.has(key)) continue;
      seenNeeds.current.add(key);
      const card = quiet ? null : needsCard(item, board, view, answer);
      if (!card) continue;
      const wait = {
        project: item.project_id,
        session: card.session_id,
        approval: item.kind === 'permission',
        strip: answeredInStrip(item),
      };
      const show = () => {
        noticeNeeds(card.options);
        openNeeds.current.set(key, wait);
      };
      const settle = () => {
        if (!waitInView(watch(), { id: key, ...wait })) show();
      };
      // The board reads its own list, which can land after this one.
      if (
        wait.approval &&
        view.focused &&
        useShell.getState().screen === 'board' &&
        item.project_id === projectId
      )
        heldNeeds.current.set(
          key,
          setTimeout(() => {
            heldNeeds.current.delete(key);
            if (boardPending()) overdueNeeds.current.set(key, settle);
            else settle();
          }, BOARD_LIST_HOLD_MS),
        );
      else show();
    }
    for (const key of [...seenNeeds.current]) if (!present.has(key)) seenNeeds.current.delete(key);
    for (const key of [...openNeeds.current.keys()]) if (!present.has(key)) close(key);
    for (const key of [...overdueNeeds.current.keys()])
      if (!present.has(key)) overdueNeeds.current.delete(key);
    for (const [key, timer] of [...heldNeeds.current]) {
      if (present.has(key)) continue;
      clearTimeout(timer);
      heldNeeds.current.delete(key);
    }
  }, [allNeeds, board, sessions]);

  // Arriving where a wait can be answered takes its card away; a session window coming to the front leaves it.
  useEffect(() => {
    const { elsewhere: _, ...view } = watch(shell);
    for (const [key, wait] of [...openNeeds.current])
      if (waitInView(view, { id: key, ...wait })) close(key);
    if (boardPending(shell)) return;
    for (const [key, settle] of [...overdueNeeds.current]) {
      overdueNeeds.current.delete(key);
      settle();
    }
  }, [shell, projectId, sessions]);

  useEffect(() => {
    if (!projectId || !sessions) return;
    const previous = before.current?.projectId === projectId ? before.current.sessions : null;
    before.current = { projectId, sessions };
    for (const id of stoppedWaiting(previous, sessions))
      for (const [key, wait] of [...openNeeds.current]) if (wait.session === id) close(key);
    for (const ready of becameReady(previous, sessions)) hold.current.ready(ready.id);
    if (inQuietHours()) return;
    for (const card of reviewCards(previous, sessions, projectId, watch())) result(card);
  }, [projectId, sessions]);

  useEffect(() => {
    const next = liveCards(cursor.current, { board, events, resync }, watch());
    cursor.current = next.cursor;
    if (inQuietHours()) return;
    for (const card of next.cards)
      if (card.group === 'done') hold.current.ended(card.session_id, () => result(card));
      else result(card);
  }, [board, events, resync, sessions]);

  return null;
}
