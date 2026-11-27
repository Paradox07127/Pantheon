import { useState, type ReactNode } from 'react';
import { MessageCircleQuestionMark, X } from 'lucide-react';
import type {
  ProjectOverlap,
  ProjectPlanView,
  SessionThreadEntry,
  WorkbenchSession,
} from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { ContextRing } from '../../components/ContextRing';
import { DiffCounts } from '../../components/DiffCounts';
import { LoadError } from '../../components/LoadError';
import { Skeleton } from '../../components/Skeleton';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { ageText, failureText, reasonText, useNow } from '../../data/needs-you';
import { useSessionThread } from '../../data/session-thread';
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

const SHOWN_ENTRIES = 8;

const stroke = (draw: ReactNode) => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    {draw}
  </svg>
);
const MERGE = (
  <>
    <circle cx="4" cy="3" r="1.5" />
    <path d="M4 4.5V12M4 4.8c0 1.8 1.6 2.2 3.2 2.2h3.3M8.8 5.2 10.6 7 8.8 8.8" />
  </>
);
const SHIELD = 'M7 1.8 11.5 3.5v3.3c0 2.7-1.9 4.6-4.5 5.4-2.6-.8-4.5-2.7-4.5-5.4V3.5z';
const CROSS = 'M4.5 4.5l5 5M9.5 4.5l-5 5';

/** One entry of the session's thread: its glyph and tone, its line, and what opens under it. */
function threadRow(
  entry: SessionThreadEntry,
  open: boolean,
  toggle: () => void,
): { glyph: ReactNode; tone?: 'ok' | 'bad'; line: ReactNode; body?: ReactNode } {
  const name = (label: string) => <span className="pj-th-n">{label}</span>;
  const opener = (label: string) => (
    <button type="button" className="pj-th-n" aria-expanded={open} onClick={toggle}>
      {label}
    </button>
  );
  const said = (value: string | undefined) => value && <p className="pj-th-p">{value}</p>;
  switch (entry.kind) {
    case 'started':
      return entry.by === 'user'
        ? {
            glyph: stroke(<path d="M4.5 2.8v8.4L11 7z" />),
            line: name(
              t({ id: 'project.inspector.thread.startedByUser', defaultMessage: 'You started it' }),
            ),
          }
        : {
            glyph: stroke(<path d="M2 7h7M6.5 4 9.5 7l-3 3M11.8 3v8" />),
            line: name(
              t({
                id: 'project.inspector.thread.startedByMainAgent',
                defaultMessage: 'The main agent started it',
              }),
            ),
            body: said(entry.reason),
          };
    case 'message': {
      const first = entry.text?.split(/\r?\n/, 1)[0];
      const label = t({ id: 'project.inspector.thread.mainAgent', defaultMessage: 'Main agent' });
      return {
        glyph: stroke(<path d="M2.5 3h9v6h-5L4 11.2V9H2.5z" />),
        line: (
          <>
            {entry.text !== undefined && entry.text !== first ? opener(label) : name(label)}
            {!open && first && <span className="pj-th-s">{first}</span>}
          </>
        ),
        body: open && <p className="pj-th-q">{entry.text}</p>,
      };
    }
    case 'turn_ended':
      if (entry.state === 'completed')
        return {
          glyph: stroke(<path d="M3 7.3 5.7 10 11 4.2" />),
          tone: 'ok',
          line: name(
            t({ id: 'project.inspector.thread.turnCompleted', defaultMessage: 'Turn completed' }),
          ),
        };
      if (entry.state === 'failed')
        return {
          glyph: stroke(<path d={CROSS} />),
          tone: 'bad',
          line: name(
            t({ id: 'project.inspector.thread.turnFailed', defaultMessage: 'Turn failed' }),
          ),
          body: said(entry.error && reasonText(entry.error)),
        };
      return {
        glyph: stroke(<path d="M3.5 7h7" />),
        line: name(
          t({ id: 'project.inspector.thread.turnCancelled', defaultMessage: 'Turn cancelled' }),
        ),
      };
    case 'spawner_notified':
      return {
        glyph: stroke(<path d="M11.5 3.5v3a2 2 0 0 1-2 2H3M5.5 6 3 8.5 5.5 11" />),
        line: name(
          t({ id: 'project.inspector.thread.notified', defaultMessage: 'The main agent got it' }),
        ),
      };
    case 'question':
      return {
        glyph: <MessageCircleQuestionMark aria-hidden="true" />,
        line: name(
          entry.state === 'pending'
            ? t({
                id: 'project.inspector.thread.questionWaiting',
                defaultMessage: 'Asked, waiting for an answer',
              })
            : entry.answered_by === 'user'
              ? t({
                  id: 'project.inspector.thread.questionByUser',
                  defaultMessage: 'Asked, you answered',
                })
              : entry.answered_by === 'main_agent'
                ? t({
                    id: 'project.inspector.thread.questionByMainAgent',
                    defaultMessage: 'Asked, the main agent answered',
                  })
                : t({
                    id: 'project.inspector.thread.questionUnanswered',
                    defaultMessage: 'Asked, not answered',
                  }),
        ),
        body: entry.questions?.map((question, k) => (
          <p key={k} className="pj-th-p">
            {question}
          </p>
        )),
      };
    case 'review': {
      const label = t(
        { id: 'project.inspector.thread.review', defaultMessage: 'Review round {round}' },
        { round: entry.round },
      );
      const passed =
        entry.state === 'completed' &&
        entry.verdicts.length > 0 &&
        entry.verdicts.every((v) => v.verdict === 'pass');
      return {
        glyph: stroke(<path d="M4 2h4.5L11 4.5V12H4zM8.5 2v2.5H11M6 7.5h3M6 9.5h3" />),
        tone: entry.blocking.length || entry.state === 'failed' ? 'bad' : passed ? 'ok' : undefined,
        line: (
          <>
            {entry.blocking.length ? opener(label) : name(label)}
            {entry.state === 'running' && (
              <span className="pj-th-s">
                {t({ id: 'project.inspector.thread.reviewRunning', defaultMessage: 'Reviewing' })}
              </span>
            )}
            {entry.state === 'failed' && (
              <span className="pj-th-s">
                {t({
                  id: 'project.inspector.thread.reviewFailed',
                  defaultMessage: 'The review did not finish',
                })}
              </span>
            )}
            {entry.verdicts.map((v) => (
              <span key={v.runtime} className="pj-th-s">
                {v.verdict === 'pass'
                  ? t(
                      {
                        id: 'project.inspector.thread.verdictPass',
                        defaultMessage: '{runtime} passed',
                      },
                      { runtime: runtimeName(v.runtime) },
                    )
                  : t(
                      {
                        id: 'project.inspector.thread.verdictFail',
                        defaultMessage: '{runtime} failed',
                      },
                      { runtime: runtimeName(v.runtime) },
                    )}
              </span>
            ))}
            {entry.blocking.length > 0 && (
              <span className="pj-th-s">
                {t(
                  {
                    id: 'project.inspector.thread.blocking',
                    defaultMessage: '{count, plural, one {# blocking} other {# blocking}}',
                  },
                  { count: entry.blocking.length },
                )}
              </span>
            )}
          </>
        ),
        body: open && (
          <ul className="pj-th-f">
            {entry.blocking.map((finding) => (
              <li key={finding.id}>
                <span className="mono">{finding.location ?? finding.id}</span>
                {finding.impact && <span>{finding.impact}</span>}
              </li>
            ))}
          </ul>
        ),
      };
    }
    case 'gate':
      if (entry.state === 'passed')
        return {
          glyph: stroke(<path d={`${SHIELD}M5.2 7l1.3 1.3 2.4-2.6`} />),
          tone: 'ok',
          line: name(
            t({ id: 'project.inspector.thread.gatePassed', defaultMessage: 'Gate passed' }),
          ),
        };
      if (entry.state === 'failed')
        return {
          glyph: stroke(<path d={`${SHIELD}M5.5 5.5l3 3M8.5 5.5l-3 3`} />),
          tone: 'bad',
          line: name(
            t({ id: 'project.inspector.thread.gateFailed', defaultMessage: 'Gate failed' }),
          ),
          body: entry.failed_steps.length > 0 && (
            <ul className="pj-th-c">
              {entry.failed_steps.map((step) => (
                <li key={step} className="chip mono">
                  {step}
                </li>
              ))}
            </ul>
          ),
        };
      return {
        glyph: stroke(<path d={SHIELD} />),
        line: name(
          t({ id: 'project.inspector.thread.gateCancelled', defaultMessage: 'Gate cancelled' }),
        ),
      };
    case 'landing':
      return entry.state === 'landed'
        ? {
            glyph: stroke(MERGE),
            tone: 'ok',
            line: (
              <>
                {name(t({ id: 'project.inspector.thread.landed', defaultMessage: 'Landed' }))}
                <span className="mono pj-th-s">{entry.commit.slice(0, 7)}</span>
              </>
            ),
          }
        : {
            glyph: stroke(MERGE),
            tone: 'bad',
            line: name(
              t({
                id: 'project.inspector.thread.landingBlocked',
                defaultMessage: 'Landing blocked',
              }),
            ),
            body: said(entry.reason && reasonText(entry.reason)),
          };
    case 'main_agent_action':
      return {
        glyph:
          entry.action === 'interrupt'
            ? stroke(<path d="M5 3.5v7M9 3.5v7" />)
            : entry.action === 'close'
              ? stroke(<path d={CROSS} />)
              : stroke(MERGE),
        line: name(
          entry.action === 'interrupt'
            ? t({
                id: 'project.inspector.thread.interrupted',
                defaultMessage: 'The main agent interrupted it',
              })
            : entry.action === 'close'
              ? t({
                  id: 'project.inspector.thread.closed',
                  defaultMessage: 'The main agent closed it',
                })
              : t({
                  id: 'project.inspector.thread.handedToLand',
                  defaultMessage: 'The main agent sent it to land',
                }),
        ),
        body: said(entry.reason),
      };
  }
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
  const thread = useSessionThread(sessionId);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // The session whose earlier entries are open; the item can turn to another session.
  const [earlierOf, setEarlierOf] = useState<string | null>(null);
  const earlier = earlierOf !== null && earlierOf === sessionId;
  const entries = thread.data?.entries ?? [];
  const threadName = t({ id: 'project.inspector.thread', defaultMessage: 'What happened' });
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
      {sessionId && (thread.error || thread.loading || entries.length > 0) && (
        <section className="pj-sec" aria-label={threadName}>
          <h3 className="pj-h2">{threadName}</h3>
          {thread.error ? (
            <LoadError
              message={t(
                {
                  id: 'project.inspector.thread.failed',
                  defaultMessage: "Couldn't read what happened to the session: {error}",
                },
                { error: thread.error },
              )}
              onRetry={thread.reload}
            />
          ) : thread.data ? (
            <ol className="pj-th">
              {entries.length > SHOWN_ENTRIES && (
                <li className="pj-th-e">
                  <button
                    type="button"
                    className="pj-th-n"
                    aria-expanded={earlier}
                    onClick={() => setEarlierOf(earlier ? null : sessionId)}
                  >
                    {t(
                      {
                        id: 'project.inspector.thread.earlier',
                        defaultMessage: '{count, plural, one {# earlier} other {# earlier}}',
                      },
                      { count: entries.length - SHOWN_ENTRIES },
                    )}
                  </button>
                </li>
              )}
              {(earlier ? entries : entries.slice(-SHOWN_ENTRIES)).map((entry) => {
                const row = threadRow(entry, opened.has(entry.id), () =>
                  setOpened((was) => {
                    const next = new Set(was);
                    if (!next.delete(entry.id)) next.add(entry.id);
                    return next;
                  }),
                );
                return (
                  <li key={entry.id} className="pj-th-i">
                    <span className="pj-th-g" data-tone={row.tone} aria-hidden="true">
                      {row.glyph}
                    </span>
                    <time className="pj-th-t" dateTime={new Date(entry.at).toISOString()}>
                      {ageText(entry.at, now)}
                    </time>
                    <div className="pj-th-b">
                      <div className="pj-th-l">{row.line}</div>
                      {row.body}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="pj-th-sk" aria-busy="true">
              <Skeleton style={{ height: 10, width: '60%' }} />
              <Skeleton style={{ height: 10, width: '40%' }} />
            </div>
          )}
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
