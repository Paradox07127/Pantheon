import { ArrowUpRight, Route } from 'lucide-react';
import type { ChangeRow, ProjectChanges, WorkbenchSession } from '@pantheon/protocol';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { Skeleton } from '../../components/Skeleton';
import { useBoard } from '../../data/board';
import { useProjectQuery } from '../../data/project-read';
import { t } from '../../i18n';
import { tokenText } from '../../lib/number-text';
import { useShell } from '../../store';
import { sessionRow } from './model';
import { readFailed } from './shared';
import './run-map.css';

/** The widest the run map's column in the panel dock gets, in px. */
export const RUN_MAP_WIDTH = 400;

const NO_SESSIONS: readonly WorkbenchSession[] = [];

/** The listed sessions a main agent spawned; none for any other session. */
export function spawnedOf(
  conductor: WorkbenchSession | null,
  sessions: readonly WorkbenchSession[] | null,
): readonly WorkbenchSession[] {
  if (!conductor?.conductor || !sessions) return NO_SESSIONS;
  const spawned = sessions.filter(
    (s) => s.spawned_by?.session_id === conductor.id && !s.archived_at,
  );
  return spawned.length ? spawned : NO_SESSIONS;
}

const isChanges = (value: unknown): boolean =>
  Array.isArray((value as Partial<ProjectChanges> | null)?.changes);

type Tone = 'ok' | 'bad' | 'run' | 'idle';

function gateOf(gate: ChangeRow['gate'] | undefined): { text: string; tone: Tone } | null {
  switch (gate?.state) {
    case 'running':
      return {
        text: t({ id: 'sessions.runMap.gateRunning', defaultMessage: 'Gate running' }),
        tone: 'run',
      };
    case 'passed':
      return {
        text: t({ id: 'sessions.runMap.gatePassed', defaultMessage: 'Gate passed' }),
        tone: 'ok',
      };
    case 'failed':
      return {
        text: t({ id: 'sessions.runMap.gateFailed', defaultMessage: 'Gate failed' }),
        tone: 'bad',
      };
    case 'stale':
      return {
        text: t({ id: 'sessions.runMap.gateStale', defaultMessage: 'Gate out of date' }),
        tone: 'idle',
      };
    case 'none':
      return {
        text: t({ id: 'sessions.runMap.gateNone', defaultMessage: 'Gate not run' }),
        tone: 'idle',
      };
    default:
      return null;
  }
}

function reviewOf(review: ChangeRow['review']): { text: string; tone: Tone } | null {
  if (!review) return null;
  if (review.state === 'running')
    return {
      text: t({ id: 'sessions.runMap.reviewRunning', defaultMessage: 'Reviewing' }),
      tone: 'run',
    };
  if (review.state === 'failed')
    return {
      text: t({ id: 'sessions.runMap.reviewFailed', defaultMessage: 'Review failed' }),
      tone: 'bad',
    };
  if (review.blocking_open > 0)
    return {
      text: t(
        {
          id: 'sessions.runMap.reviewBlocking',
          defaultMessage: '{count, plural, one {# blocking finding} other {# blocking findings}}',
        },
        { count: review.blocking_open },
      ),
      tone: 'bad',
    };
  if (review.verdicts.some((v) => v.verdict === 'fail'))
    return {
      text: t({ id: 'sessions.runMap.reviewChanges', defaultMessage: 'Review asks for changes' }),
      tone: 'bad',
    };
  if (review.incomplete)
    return {
      text: t({ id: 'sessions.runMap.reviewIncomplete', defaultMessage: 'Review incomplete' }),
      tone: 'idle',
    };
  // A review that ended without verdicts never reached one.
  if (review.verdicts.length === 0) return null;
  return {
    text: t({ id: 'sessions.runMap.reviewPassed', defaultMessage: 'Review passed' }),
    tone: 'ok',
  };
}

let focusOnOpen: string | null = null;

/** Whether a run map row just opened this session, so its pane takes the focus; true once. */
export function takeOpenedFocus(sessionId: string): boolean {
  if (focusOnOpen !== sessionId) return false;
  focusOnOpen = null;
  return true;
}

/** A main agent's spawned sessions: counts, then one row each that opens it. */
export function RunMap(props: {
  projectId: string;
  spawned: readonly WorkbenchSession[];
  width: number;
}) {
  const { spawned } = props;
  const known = useBoard((s) => s.board?.sessions);
  const changes = useProjectQuery<ProjectChanges>('project.changes', props.projectId, isChanges);
  const changeOf = new Map(changes.read?.changes.map((c) => [c.id, c]));
  const usage = spawned.map((s) => known?.find((k) => k.id === s.id));
  const tokensOf = (i: number) =>
    (usage[i]?.usage?.input_tokens ?? 0) + (usage[i]?.usage?.output_tokens ?? 0);
  const unreported = (i: number) => usage[i]?.usage?.tokens_unreported === true;
  const tokens = tokenText(spawned.reduce((sum, _, i) => sum + tokensOf(i), 0));
  const turns = usage.reduce((sum, k) => sum + (k?.turn_count ?? 0), 0);
  const label = t({ id: 'sessions.runMap.title', defaultMessage: 'Run map' });
  return (
    <section className="rmap" style={{ width: props.width }} aria-label={label}>
      <div className="rmap-h">
        <Route className="rmap-ic" aria-hidden="true" />
        <h2 className="rmap-t">{label}</h2>
        <span className="rmap-n">
          {t(
            {
              id: 'sessions.runMap.sessions',
              defaultMessage: '{count, plural, one {# session} other {# sessions}}',
            },
            { count: spawned.length },
          )}
        </span>
      </div>
      <div className="panel rmap-sum">
        <div className="cell">
          <span className="cap">
            {t({ id: 'sessions.runMap.running', defaultMessage: 'Running' })}
          </span>
          <span className="kpi">
            {spawned.filter((s) => s.state === 'running' || s.state === 'starting').length}
          </span>
        </div>
        <div className="cell">
          <span className="cap">
            {t({ id: 'sessions.runMap.waiting', defaultMessage: 'Waiting for you' })}
          </span>
          <span className="kpi">{spawned.filter((s) => s.state === 'waiting').length}</span>
        </div>
        <div className="cell">
          <span className="cap">{t({ id: 'sessions.runMap.usage', defaultMessage: 'Usage' })}</span>
          <span className="rmap-use">
            <span className="kpi">
              {spawned.some((_, i) => unreported(i))
                ? t(
                    { id: 'sessions.runMap.tokensPartial', defaultMessage: 'At least {tokens}' },
                    { tokens },
                  )
                : tokens}
            </span>
            <span className="rmap-turns">
              {t(
                {
                  id: 'sessions.runMap.turns',
                  defaultMessage: '{count, plural, one {# turn} other {# turns}}',
                },
                { count: turns },
              )}
            </span>
          </span>
        </div>
      </div>
      {!changes.unavailable && readFailed(changes)}
      <ul className="rmap-list" aria-busy={changes.loading || undefined}>
        {spawned.map((s, i) => {
          const change = changeOf.get(`session:${s.id}`);
          const gate = gateOf(change?.gate);
          const review = reviewOf(change?.review);
          return (
            <li key={s.id}>
              <button
                type="button"
                className="rmap-row"
                onClick={() => {
                  focusOnOpen = s.id;
                  useShell.getState().openSession(s.id);
                }}
              >
                <SessionStateIcon session={s} place="list" />
                <span className="rmap-title">{sessionRow(s).title}</span>
                <ArrowUpRight className="rmap-go" aria-hidden="true" />
                <span className="rmap-sub">
                  {s.branch && <span className="rmap-br mono">{s.branch}</span>}
                  {!!s.ahead && (
                    <span className="rmap-num">
                      {t(
                        { id: 'sessions.runMap.ahead', defaultMessage: '{count} ahead' },
                        { count: s.ahead },
                      )}
                    </span>
                  )}
                  {changes.loading && <Skeleton className="rmap-sk" />}
                  {gate && (
                    <span className="rmap-st" data-tone={gate.tone}>
                      {gate.text}
                    </span>
                  )}
                  {review && (
                    <span className="rmap-st" data-tone={review.tone}>
                      {review.text}
                    </span>
                  )}
                  {!unreported(i) && <span className="rmap-tok">{tokenText(tokensOf(i))}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
