import { isValidElement, useMemo, type ReactElement } from 'react';
import { CircleCheck, OctagonX, Square, type LucideIcon } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { useEventHistory } from '../data/logs';
import { ageText, useNow } from '../data/needs-you';
import { isActivityEvent, recentActivity, type ActivityKind } from '../data/recent-activity';
import type { SessionTurn } from '../data/transcript';
import { t } from '../i18n';
import { sessionRow } from '../screens/sessions/model';
import { LoadError } from './LoadError';
import { MergeBlockedGlyph, StateGlyph } from './SessionStateIcon';
import './recent-activity.css';

const NO_SESSIONS: readonly WorkbenchSession[] = [];
const NO_TURNS: readonly SessionTurn[] = [];

// Merges are drawn with the session list's own glyphs, the rest with lucide icons; labels are getters.
const KINDS: Record<ActivityKind, { icon: LucideIcon | ReactElement; label: string }> = {
  completed: {
    icon: CircleCheck,
    get label() {
      return t({ id: 'components.recentActivity.completed', defaultMessage: 'Completed' });
    },
  },
  failed: {
    icon: OctagonX,
    get label() {
      return t({ id: 'components.recentActivity.failed', defaultMessage: 'Failed' });
    },
  },
  merged: {
    icon: <StateGlyph name="merged" />,
    get label() {
      return t({ id: 'components.recentActivity.merged', defaultMessage: 'Merged' });
    },
  },
  merge_blocked: {
    icon: <MergeBlockedGlyph />,
    get label() {
      return t({ id: 'components.recentActivity.mergeBlocked', defaultMessage: 'Merge blocked' });
    },
  },
  cancelled: {
    icon: Square,
    get label() {
      return t({ id: 'components.recentActivity.cancelled', defaultMessage: 'Cancelled' });
    },
  },
};

interface RecentActivityProps {
  projectId: string | null;
  /** null while the session list is not read. */
  sessions: readonly WorkbenchSession[] | null;
}

/** What happened in the project's sessions lately, newest first; a row opens its session. */
export function RecentActivity({
  projectId,
  sessions,
  onOpen,
}: RecentActivityProps & { onOpen: (sessionId: string) => void }) {
  const live = useBoard((s) => s.events);
  const turns = useBoard((s) => s.board?.session_turns) ?? NO_TURNS;
  // The live stream holds only events since it connected; earlier merges and turns come from here.
  const history = useEventHistory({
    key: projectId && `activity:${projectId}`,
    project_id: projectId,
    after: 0,
    keep: isActivityEvent,
  });
  const events = history.events ?? live;
  const listed = sessions ?? NO_SESSIONS;
  const now = useNow(30_000);
  const recent = useMemo(() => recentActivity(events, listed, turns), [events, listed, turns]);
  const byId = new Map(listed.map((s) => [s.id, s]));
  return (
    <>
      {history.error && <LoadError message={history.error} onRetry={history.reload} />}
      <ul className="act-list">
        {recent.map((row) => {
          const kind = KINDS[row.kind];
          const Icon = kind.icon;
          const session = byId.get(row.session_id);
          const title = session ? sessionRow(session).title : row.session_id;
          return (
            <li key={row.id}>
              <button type="button" className="act-row" onClick={() => onOpen(row.session_id)}>
                {isValidElement(Icon) ? (
                  <span className="act-ic" aria-hidden="true">
                    {Icon}
                  </span>
                ) : (
                  <Icon className={`ic-sm act-ic act-${row.kind}`} aria-hidden="true" />
                )}
                <span className="act-t" title={title}>
                  {title}
                </span>
                <span className="act-kind">{kind.label}</span>
                <span className="mu">{ageText(row.at, now)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export const recentActivityTitle = () =>
  t({ id: 'components.recentActivity.title', defaultMessage: 'Recent activity' });
