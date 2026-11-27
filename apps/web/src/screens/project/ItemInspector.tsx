import { useState } from 'react';
import { X } from 'lucide-react';
import type { ProjectOverlap, ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { ContextRing } from '../../components/ContextRing';
import { DiffCounts } from '../../components/DiffCounts';
import { LoadError } from '../../components/LoadError';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { ageText, failureText, useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { tokenText } from '../../lib/number-text';
import { durationText } from '../../lib/time-text';
import { useShell } from '../../store';
import { ChangeDetails, RowMark } from '../changes/ChangesScreen';
import { sessionRow } from '../sessions/model';
import { EvidenceMark } from './EvidenceMark';
import {
  acceptAction,
  dependencyLabel,
  forYouText,
  overlapsOf,
  planGlyph,
  SHOWN_PATHS,
  upstreamOf,
  type ShownPlanItem,
  type Upstream,
} from './project-model';

type Plan = NonNullable<ProjectPlanView['plan']>;

/** The overlap read as the inspector needs it. */
export interface OverlapRead {
  read: ProjectOverlap | null;
  error: string | null;
  reload: () => void;
}

const BOX = 28;
const GAP = 8;
const LINK = 16;

/** The upstream items, then the item, joined by curves; a landed item's box and curve are green. */
function dependencyGraph(item: ShownPlanItem, ups: readonly Upstream[]) {
  const column = ups.length * BOX + (ups.length - 1) * GAP;
  const mid = column / 2;
  return (
    <div className="pj-dg" role="img" aria-label={dependencyLabel(ups)}>
      <div className="pj-dg-c">
        {ups.map((up) => (
          <span key={up.id} className="pj-dg-n" data-landed={up.landed || undefined}>
            <Clip text={up.title} />
          </span>
        ))}
      </div>
      <svg width={LINK} height={column} viewBox={`0 0 ${LINK} ${column}`} aria-hidden="true">
        {ups.map((up, i) => {
          const y = i * (BOX + GAP) + BOX / 2;
          return (
            <path
              key={up.id}
              data-landed={up.landed || undefined}
              d={`M0 ${y} C${LINK / 2} ${y} ${LINK / 2} ${mid} ${LINK} ${mid}`}
            />
          );
        })}
      </svg>
      <span className="pj-dg-n" data-landed={item.stage === 'landed' || undefined}>
        <Clip text={item.title} />
      </span>
    </div>
  );
}

/**
 * One plan item beside the plan: its state and what backs it, its failure, its acceptance, its
 * change, the use of its session and what it depends on; it opens the session and accepts the item.
 */
export function ItemInspector({
  item,
  plan,
  projectId,
  sessions,
  overlap,
  onClose,
}: {
  item: ShownPlanItem;
  plan: Plan;
  projectId: string;
  sessions: readonly WorkbenchSession[] | null;
  overlap?: OverlapRead;
  onClose: () => void;
}) {
  const now = useNow(60_000);
  const sessionId = item.session_id ?? null;
  const session = (sessionId && sessions?.find((s) => s.id === sessionId)) || null;
  const known = useBoard((s) =>
    sessionId ? s.board?.sessions.find((x) => x.id === sessionId) : undefined,
  );
  const [accept, setAccept] = useState<{ busy: boolean; error: string | null }>({
    busy: false,
    error: null,
  });
  const action = acceptAction(item);
  const send = async () => {
    if (action.blocked || accept.busy) return;
    setAccept({ busy: true, error: null });
    const result = await runCommand(
      'project.plan.accept',
      { project_id: projectId, item_id: item.id, accepted: action.accepted },
      plan.revision,
    );
    setAccept({ busy: false, error: result.ok ? null : failureText(result.error) });
  };
  const acceptButton = (
    <button
      type="button"
      className="btn sm"
      aria-disabled={action.blocked ? true : undefined}
      aria-busy={accept.busy || undefined}
      onClick={() => void send()}
    >
      {action.label}
    </button>
  );
  const change = item.change;
  const failure = item.failure;
  const acceptance = item.acceptance ?? [];
  const ups = upstreamOf(item, plan.items);
  const tokens = tokenText((known?.usage?.input_tokens ?? 0) + (known?.usage?.output_tokens ?? 0));
  const context = session?.context;
  const failureName = t({ id: 'project.inspector.failure', defaultMessage: 'Why it failed' });
  const acceptanceName = t({ id: 'project.inspector.acceptance', defaultMessage: 'Acceptance' });
  const usageName = t({ id: 'project.inspector.usage', defaultMessage: 'Context and use' });
  const depsName = t({ id: 'project.inspector.deps', defaultMessage: 'Dependencies' });
  const overlapName = t({
    id: 'project.inspector.overlap',
    defaultMessage: 'Same files changed elsewhere',
  });
  const others = overlap?.error ? [] : overlapsOf(overlap?.read, sessionId);
  return (
    <aside
      className="pj-ins"
      aria-label={t(
        { id: 'project.inspector.label', defaultMessage: 'Details of {title}' },
        { title: item.title },
      )}
    >
      <div className="pj-sec">
        <div className="pj-ins-h">
          <StateGlyph name={planGlyph(item)} />
          <h2 className="pj-ins-t">
            <Clip text={item.title} />
          </h2>
          <button
            type="button"
            className="ib"
            aria-label={t({ id: 'project.inspector.close', defaultMessage: 'Close details' })}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {(change || session || item.diff || item.evidence) && (
          <div className="pj-line">
            {change ? (
              <RowMark row={change} />
            ) : (
              session && (
                <span className="chg-glyph" role="img" aria-label={runtimeName(session.runtime)}>
                  <RuntimeGlyph runtime={session.runtime} />
                </span>
              )
            )}
            {change?.branch && <Clip text={change.branch} className="mono" />}
            {item.diff && (
              <span className="pj-diff">
                <DiffCounts additions={item.diff.additions} deletions={item.diff.deletions} />
              </span>
            )}
            {item.evidence && <EvidenceMark evidence={item.evidence} />}
          </div>
        )}
        <div className="pj-line">
          {sessionId && (
            <button
              type="button"
              className="btn sm"
              onClick={() => useShell.getState().openSession(sessionId)}
            >
              {t({ id: 'project.inspector.openSession', defaultMessage: 'Open session' })}
            </button>
          )}
          {action.blocked ? <Tip content={action.blocked}>{acceptButton}</Tip> : acceptButton}
        </div>
        {accept.error && (
          <span className="pj-cerr" role="alert">
            {accept.error}
          </span>
        )}
      </div>
      {failure && (
        <section className="pj-sec" aria-label={failureName}>
          <div className="pj-ch">
            <h3 className="pj-h2">{failureName}</h3>
            <span className="pj-n">{ageText(Date.parse(failure.at), now)}</span>
          </div>
          <div className="pj-line">
            <StateGlyph name="failed" />
            <span className="pj-txt">{failure.reason}</span>
          </div>
          <div className="pj-line pj-sub">
            <span>
              {failure.handled_by === 'main_agent'
                ? t({ id: 'project.plan.mainAgentKnows', defaultMessage: 'Main agent knows' })
                : forYouText()}
            </span>
            {item.stuck_since && (
              <span className="chip pj-stuck">
                {t(
                  { id: 'project.plan.stuck', defaultMessage: 'Stuck {duration}' },
                  { duration: durationText(now - Date.parse(item.stuck_since)) },
                )}
              </span>
            )}
          </div>
        </section>
      )}
      {acceptance.length > 0 && (
        <section className="pj-sec" aria-label={acceptanceName}>
          <h3 className="pj-h2">{acceptanceName}</h3>
          <ul className="pj-acc">
            {acceptance.map((line, k) => (
              <li key={k}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      {change && (
        <div className="pj-cd">
          <ChangeDetails key={change.id} row={change} sessions={sessions} />
        </div>
      )}
      {session && (
        <section className="pj-sec" aria-label={usageName}>
          <h3 className="pj-h2">{usageName}</h3>
          <div className="pj-line">
            {context && context.window_tokens > 0 && (
              <>
                <ContextRing context={context} />
                <span className="pj-kpi">
                  {Math.min(100, Math.round((context.used_tokens / context.window_tokens) * 100))}%
                </span>
              </>
            )}
            {known && (
              <>
                {known.usage && !known.usage.tokens_unreported && (
                  <span className="pj-sub">
                    {t(
                      { id: 'project.inspector.tokens', defaultMessage: '{tokens} tokens' },
                      { tokens },
                    )}
                  </span>
                )}
                <span className="pj-sub">
                  {t(
                    {
                      id: 'project.inspector.turns',
                      defaultMessage: '{count, plural, one {# turn} other {# turns}}',
                    },
                    { count: known.turn_count ?? 0 },
                  )}
                </span>
              </>
            )}
          </div>
        </section>
      )}
      {sessionId && (overlap?.error || others.length > 0) && (
        <section className="pj-sec" aria-label={overlapName}>
          <h3 className="pj-h2">{overlapName}</h3>
          {overlap?.error ? (
            <LoadError
              message={t(
                {
                  id: 'project.inspector.overlap.failed',
                  defaultMessage: "Couldn't read which sessions changed the same files: {error}",
                },
                { error: overlap.error },
              )}
              onRetry={overlap.reload}
            />
          ) : (
            others.map((other) => {
              const listed = sessions?.find((s) => s.id === other.sessionId);
              return (
                <div key={other.sessionId} className="pj-ov">
                  <button
                    type="button"
                    className="pj-open"
                    onClick={() => useShell.getState().openSession(other.sessionId)}
                  >
                    <Clip text={listed ? sessionRow(listed).title : other.sessionId} />
                  </button>
                  <ul className="pj-ovf">
                    {other.paths.slice(0, SHOWN_PATHS).map((path) => (
                      <li key={path} className="mono">
                        {path}
                      </li>
                    ))}
                    {other.paths.length > SHOWN_PATHS && (
                      <li className="pj-sub">
                        {t(
                          {
                            id: 'project.inspector.overlap.more',
                            defaultMessage:
                              '{count, plural, one {# more file} other {# more files}}',
                          },
                          { count: other.paths.length - SHOWN_PATHS },
                        )}
                      </li>
                    )}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      )}
      {ups.length > 0 && (
        <section className="pj-sec" aria-label={depsName}>
          <h3 className="pj-h2">{depsName}</h3>
          {dependencyGraph(item, ups)}
        </section>
      )}
    </aside>
  );
}
