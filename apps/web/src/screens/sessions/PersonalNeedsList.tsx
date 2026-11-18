import { Fragment, memo } from 'react';
import { Route } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { needsGlyph } from '../../components/NeedsPopover';
import { ProjectMonogram } from '../../components/ProjectMonogram';
import { blocksText, decisionText } from '../../data/attention';
import { useBoard } from '../../data/board';
import { focusRequest } from '../../data/focus-request';
import { ageText, needReasonText, type NeedsYouItem } from '../../data/needs-you';
import { needsKey } from '../../data/notice-tiers';
import { crossProjectWaiting, type PersonalCall } from '../../data/personal-agent';
import { visibleProjects } from '../../data/projects';
import { sessionTitle } from '../../data/transcript';
import { t } from '../../i18n';
import { clockText } from '../../lib/time-text';
import { useShell } from '../../store';
import { noVerdictKind, type NeedItem } from '../board/frame-model';

const SHOWN = 5;

/** Opens the item where the needs-you popover opens it: its card, its board, its session or its project. */
function openNeed(item: NeedsYouItem) {
  const shell = useShell.getState();
  const card = item.kind === 'lead.question' ? needsKey(item) : null;
  const sessionId = item.session_id ?? (item.source.table === 'sessions' ? item.source.id : null);
  if (card) shell.openProjectNeed(item.project_id, card);
  else if (item.kind === 'board.lane.approval') shell.openProjectBoard(item.project_id);
  else if (sessionId) {
    if (item.kind === 'agent.proposal' && item.agent_proposal) focusRequest(item.agent_proposal.id);
    shell.openProjectSession(item.project_id, sessionId);
  } else shell.openProject(item.project_id);
}

/** What waited across the projects when the personal agent read it, by project; it holds that read. */
function NeedsList({ items: read, at }: { items: readonly NeedsYouItem[]; at: number }) {
  const board = useBoard((s) => s.board);
  const projects = board ? visibleProjects(board.projects) : [];
  const items = crossProjectWaiting(
    read,
    projects.map((p) => p.id),
  );
  // Projects and their rows in the order of their first row: most blocks, then oldest.
  const groups = new Map<string, NeedsYouItem[]>();
  for (const item of [...items].sort(
    (a, b) => (b.blocks ?? 0) - (a.blocks ?? 0) || a.created_at - b.created_at,
  ))
    groups.set(item.project_id, [...(groups.get(item.project_id) ?? []), item]);
  return (
    <div
      className="pn"
      role="group"
      aria-label={t(
        {
          id: 'sessions.personalAgent.needs.label',
          defaultMessage:
            'Needs you, {count, plural, other {#}} in {projects, plural, one {# project} other {# projects}}',
        },
        { count: items.length, projects: groups.size },
      )}
    >
      <div className="pn-h">
        {groups.size === 0 && (
          <span>
            {t({ id: 'sessions.personalAgent.needs.none', defaultMessage: 'Nothing needs you' })}
          </span>
        )}
        <time dateTime={new Date(at).toISOString()}>
          {t(
            { id: 'sessions.personalAgent.needs.asOf', defaultMessage: 'As of {time}' },
            { time: clockText(at) },
          )}
        </time>
      </div>
      {[...groups].map(([projectId, rows], i) => {
        const name = projects.find((p) => p.id === projectId)?.name ?? '';
        return (
          <Fragment key={projectId}>
            {i > 0 && <hr className="pn-sep" />}
            <div role="group" aria-label={name}>
              <div className="pn-g">
                <ProjectMonogram id={projectId} name={name} />
                <b>{name}</b>
                <span className="pn-n">{rows.length}</span>
              </div>
              {rows.slice(0, SHOWN).map((item) => {
                const session = board?.sessions.find((s) => s.id === item.session_id);
                const named =
                  item.lane_title ?? (session && board ? sessionTitle(session, board) : undefined);
                const reason = needReasonText(item);
                const kind = noVerdictKind(item as NeedItem) ?? decisionText(item.decision);
                return (
                  <button
                    key={`${item.source.table}:${item.source.id}:${item.reason}:${item.request_id ?? ''}`}
                    type="button"
                    className="pn-r"
                    onClick={() => openNeed(item)}
                  >
                    <span className="pn-k">{needsGlyph(item)}</span>
                    <Clip className="pn-kd" text={kind ?? reason} />
                    <Clip text={item.question?.question ?? named ?? (kind ? reason : '')} />
                    <span className="pn-n">{blocksText(item.blocks)}</span>
                    <span className="pn-n">{ageText(item.created_at, at)}</span>
                  </button>
                );
              })}
              {rows.length > SHOWN && (
                <button
                  type="button"
                  className="pn-r"
                  onClick={() => useShell.getState().openProject(projectId)}
                >
                  <span className="pn-more">
                    {t(
                      {
                        id: 'sessions.personalAgent.needs.more',
                        defaultMessage: '{count, plural, other {# more}}',
                      },
                      { count: rows.length - SHOWN },
                    )}
                  </span>
                </button>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

// The thread draws a streaming turn on every frame; the read list does not change after it lands.
export const PersonalNeedsList = memo(NeedsList);

/** The one line of a request the personal agent sent: to which agent, in which project. */
export function PersonalSentLine({
  call,
  at,
}: {
  call: Extract<PersonalCall, { kind: 'sent' }>;
  at: number | undefined;
}) {
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === call.project_id)?.name);
  const target = useBoard((s) =>
    call.assistant ? undefined : s.board?.sessions.find((k) => k.id === call.session_id),
  );
  const agent = call.assistant
    ? t({ id: 'sessions.personalAgent.assistant', defaultMessage: 'Assistant' })
    : (target?.title ?? '');
  const sent = (values: { agent: string; project: string }) =>
    t(
      { id: 'sessions.personalAgent.sentTo', defaultMessage: 'Sent to {agent} in {project}' },
      values,
    );
  // The names are links where the placeholders stood.
  const parts = sent({ agent: '\u0000', project: '\u0001' }).split(/(\u0000|\u0001)/);
  const shell = useShell.getState;
  return (
    <div className="pn-sent" role="group" aria-label={sent({ agent, project: project ?? '' })}>
      <Route className="ic-sm" aria-hidden="true" />
      <span>
        {parts.map((part, i) =>
          part === '\u0000' ? (
            <button
              key={i}
              type="button"
              className="pn-ref"
              onClick={() =>
                call.session_id
                  ? shell().openProjectSession(call.project_id, call.session_id)
                  : shell().openProject(call.project_id)
              }
            >
              {agent}
            </button>
          ) : part === '\u0001' ? (
            <button
              key={i}
              type="button"
              className="pn-ref"
              onClick={() => shell().openProject(call.project_id)}
            >
              {project}
            </button>
          ) : (
            part
          ),
        )}
      </span>
      {at !== undefined && <span className="pn-n">{clockText(at)}</span>}
    </div>
  );
}
