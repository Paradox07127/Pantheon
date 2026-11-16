import { useEffect } from 'react';
import type { BoardSnapshot, WaitingSession, WorkbenchSession } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { useFactsRefreshOnOpen } from '../data/facts-read';
import type { NeedsYouItem } from '../data/needs-you';
import { badgeCount, useNotices, waitsForAnswer } from '../data/notifications';
import { sessionTitle } from '../data/transcript';
import { t } from '../i18n';
import { sessionRow } from '../screens/sessions/model';
import { useQueueDispatch } from '../screens/sessions/parts';
import { NoticeFeed } from './NoticeFeed';

/**
 * The first 5 sessions with an item waiting for the user's answer, titled as the sidebar lists
 * them, else as the board names them, else by their project.
 */
function waitingSessions(
  items: readonly NeedsYouItem[] | null,
  sessions: readonly WorkbenchSession[] | null,
  board: BoardSnapshot | null,
): WaitingSession[] {
  const waiting: WaitingSession[] = [];
  for (const { project_id, session_id } of items?.filter(waitsForAnswer) ?? []) {
    if (!session_id || waiting.some((one) => one.session_id === session_id)) continue;
    const listed = sessions?.find((s) => s.id === session_id);
    const known = board?.sessions.find((s) => s.id === session_id);
    const title = listed
      ? sessionRow(listed).title
      : known
        ? sessionTitle(known, board!)
        : (board?.projects.find((p) => p.id === project_id)?.name ?? '');
    if (title) waiting.push({ project_id, session_id, title });
    if (waiting.length === 5) break;
  }
  return waiting;
}

/**
 * The app-wide hooks kept for their effects alone, so the event stream they read renders this
 * and not the whole app. The caller passes the lists it already reads.
 */
export function BackgroundHooks({
  projectId,
  sessions,
  allNeeds,
}: {
  projectId: string | null;
  sessions: readonly WorkbenchSession[] | null;
  allNeeds: readonly NeedsYouItem[] | null;
}) {
  useFactsRefreshOnOpen(projectId);
  // Mounted here so notices keep coming while the sidebar is folded.
  useNotices(projectId, sessions, allNeeds);
  // Mounted here so queued messages go out while their session is not shown.
  useQueueDispatch();
  const attention = badgeCount(allNeeds);
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === projectId)?.name ?? null);
  const waiting = allNeeds?.filter(waitsForAnswer).length ?? 0;
  // A string, so a board change that leaves the list as it was neither renders nor reports again.
  const waitingList = useBoard((s) => JSON.stringify(waitingSessions(allNeeds, sessions, s.board)));

  useEffect(() => {
    if (attention !== null)
      void window.pantheon?.setBadge(attention, JSON.parse(waitingList)).catch(() => {});
  }, [attention, waitingList]);

  useEffect(() => {
    document.title =
      project === null
        ? 'Pantheon'
        : waiting > 0
          ? t(
              {
                id: 'components.backgroundHooks.windowTitle',
                defaultMessage: '{project} · {count} waiting for you',
              },
              { project, count: waiting },
            )
          : project;
  }, [project, waiting]);

  return <NoticeFeed projectId={projectId} sessions={sessions} allNeeds={allNeeds} />;
}
