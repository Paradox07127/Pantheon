import type { ReactNode } from 'react';
import type { SessionRecap } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { reasonText } from '../data/needs-you';
import { t } from '../i18n';
import './state-icon.css';

// Pieces drawn on a 14 × 14 grid with currentColor; strokes come from the <svg>.
const shield = <path d="M7 1.5 12 3.5V7c0 3-2.2 4.8-5 5.75C4.2 11.8 2 10 2 7V3.5Z" />;
const ring = <circle cx="7" cy="7" r="5" />;
const diamond = <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" />;
const mergePath = (
  <>
    <circle cx="4" cy="3" r="1.5" />
    <path d="M4 4.5v8M4 6.5c0 2 1.5 3 3.25 3" />
  </>
);
const stopSquare = (
  <rect x="5" y="5" width="4" height="4" rx=".5" fill="currentColor" stroke="none" />
);
// A spinning arc around (cx, cy); pathLength makes the dash pattern independent of the radius.
const arc = (cx: number, cy: number, r: number) => (
  <circle className="si-spin" cx={cx} cy={cy} r={r} pathLength={4} strokeDasharray="3 1" />
);

interface Glyph {
  shape: string;
  label: string;
  tone: string;
  breathe?: boolean;
  draw: ReactNode;
}

const GLYPHS = {
  starting: {
    shape: 'broken-circle',
    get label() {
      return t({ id: 'components.sessionState.starting', defaultMessage: 'Starting' });
    },
    tone: '--run',
    draw: arc(7, 7, 5),
  },
  running: {
    shape: 'filled-circle',
    get label() {
      return t({ id: 'components.sessionState.running', defaultMessage: 'Running' });
    },
    tone: '--run',
    breathe: true,
    draw: <circle cx="7" cy="7" r="4.5" fill="currentColor" stroke="none" />,
  },
  approval: {
    shape: 'shield-exclamation',
    get label() {
      return t({ id: 'components.sessionState.approval', defaultMessage: 'Needs approval' });
    },
    tone: '--wait',
    draw: (
      <>
        {shield}
        <path d="M7 4.5v3" />
        <circle cx="7" cy="9.6" r=".75" fill="currentColor" stroke="none" />
      </>
    ),
  },
  question: {
    shape: 'diamond-question',
    get label() {
      return t({ id: 'components.sessionState.question', defaultMessage: 'Needs an answer' });
    },
    tone: '--wait',
    draw: (
      <>
        {diamond}
        <path d="M5.75 5.75a1.3 1.3 0 1 1 1.8 1.2c-.35.15-.55.4-.55.8" />
        <circle cx="7" cy="9.4" r=".7" fill="currentColor" stroke="none" />
      </>
    ),
  },
  baseline_review: {
    shape: 'clipboard',
    get label() {
      return t({
        id: 'components.sessionState.baselineReview',
        defaultMessage: 'Needs confirmation',
      });
    },
    tone: '--wait',
    draw: (
      <>
        <rect x="3" y="2.5" width="8" height="10" rx="1.25" />
        <path d="M5.25 2.5V1.75h3.5v.75M5 6.25h4M5 9h4" />
      </>
    ),
  },
  idle: {
    shape: 'hollow-circle',
    get label() {
      return t({ id: 'components.sessionState.idle', defaultMessage: 'Idle' });
    },
    tone: '--idle',
    draw: ring,
  },
  ready: {
    shape: 'hollow-diamond',
    get label() {
      return t({ id: 'components.sessionState.ready', defaultMessage: 'Ready to merge' });
    },
    tone: '--ready',
    draw: diamond,
  },
  merging: {
    shape: 'merge-arc',
    get label() {
      return t({ id: 'components.sessionState.merging', defaultMessage: 'Merging' });
    },
    tone: '--ready',
    draw: (
      <>
        {mergePath}
        {arc(10.25, 9.5, 2.25)}
      </>
    ),
  },
  failed: {
    shape: 'octagon-cross',
    get label() {
      return t({ id: 'components.sessionState.failed', defaultMessage: 'Failed' });
    },
    tone: '--bad',
    draw: (
      <>
        <path d="M4.6 1.5h4.8l3.1 3.1v4.8l-3.1 3.1H4.6L1.5 9.4V4.6Z" />
        <path d="m5 5 4 4M9 5 5 9" />
      </>
    ),
  },
  merged: {
    shape: 'merge-check',
    get label() {
      return t({ id: 'components.sessionState.merged', defaultMessage: 'Merged' });
    },
    tone: '--ok',
    draw: (
      <>
        {mergePath}
        <path d="m8.5 9.5 1.25 1.25L12.5 8" />
      </>
    ),
  },
  discarded: {
    shape: 'slashed-circle',
    get label() {
      return t({ id: 'components.sessionState.discarded', defaultMessage: 'Discarded' });
    },
    tone: '--idle',
    draw: (
      <>
        {ring}
        <path d="m3.5 10.5 7-7" />
      </>
    ),
  },
  done: {
    shape: 'circle-check',
    get label() {
      return t({ id: 'components.sessionState.done', defaultMessage: 'Done' });
    },
    tone: '--ok',
    draw: (
      <>
        {ring}
        <path d="m4.75 7.1 1.55 1.55 2.95-3.05" />
      </>
    ),
  },
  reconciling: {
    shape: 'split-diamond',
    get label() {
      return t({ id: 'components.sessionState.reconciling', defaultMessage: 'Needs recovery' });
    },
    tone: '--wait',
    draw: <path d="M6.25 2.25 1.5 7l4.75 4.75ZM7.75 2.25 12.5 7l-4.75 4.75Z" />,
  },
  stopping: {
    shape: 'square-arc',
    get label() {
      return t({ id: 'components.sessionState.stopping', defaultMessage: 'Stopping' });
    },
    tone: '--idle',
    draw: (
      <>
        {stopSquare}
        {arc(7, 7, 5.25)}
      </>
    ),
  },
} satisfies Record<string, Glyph>;

export type GlyphName = keyof typeof GLYPHS;

function Svg({ glyph, place }: { glyph: Glyph; place?: string }) {
  return (
    <svg
      role="img"
      aria-label={glyph.label}
      data-shape={glyph.shape}
      data-place={place}
      className={glyph.breathe ? 'si si-breathe' : 'si'}
      style={{ color: `var(${glyph.tone})` }}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyph.draw}
    </svg>
  );
}

/** One state glyph by name; the board draws its tasks with these. */
export function StateGlyph({
  name,
  place,
  tone,
}: {
  name: GlyphName;
  place?: string;
  /** A colour token to draw it in instead of the state's own. */
  tone?: string;
}) {
  return <Svg glyph={tone ? { ...GLYPHS[name], tone } : GLYPHS[name]} place={place} />;
}

/** The name of the glyph SessionStateIcon draws for the session. */
export function sessionGlyphName(session: WorkbenchSession): GlyphName {
  if (session.stopping) return 'stopping';
  if (session.reconciling) return 'reconciling';
  if (session.state === 'waiting') return session.waiting_kind ?? 'approval';
  return session.state;
}

const SETTLED: readonly GlyphName[] = ['done', 'failed', 'merged'];

/** The one state a listed session shows, by priority stopping > reconciling > state. */
export function SessionStateIcon({
  session,
  place,
  seen,
}: {
  session: WorkbenchSession;
  place: 'list' | 'header' | 'card';
  /** In the list, a finished state the user has seen is drawn in the idle tone. */
  seen?: boolean;
}) {
  const name = sessionGlyphName(session);
  if (place === 'list' && seen && SETTLED.includes(name))
    return <Svg glyph={{ ...GLYPHS[name], tone: '--idle' }} place={place} />;
  return <StateGlyph name={name} place={place} />;
}

/** The name of the state SessionStateIcon draws. */
export const sessionStateLabel = (session: WorkbenchSession): string =>
  GLYPHS[sessionGlyphName(session)].label;

/** The colour token SessionStateIcon draws the state in. */
export const sessionStateTone = (session: WorkbenchSession): string =>
  GLYPHS[sessionGlyphName(session)].tone;

/** A recoverable turn result beside the lifecycle; it never changes whether input is accepted. */
export function lastTurnLabel(session: WorkbenchSession): string | null {
  if (session.stopping || session.reconciling || !['idle', 'ready'].includes(session.state))
    return null;
  if (session.last_turn?.state === 'failed')
    return t({ id: 'components.sessionState.lastTurnFailed', defaultMessage: 'Last turn failed' });
  if (session.last_turn?.state === 'cancelled')
    return t({
      id: 'components.sessionState.lastTurnInterrupted',
      defaultMessage: 'Last turn interrupted',
    });
  return null;
}

/** Why the last turn failed, and whether the main agent or the user has it; also when the session failed. */
export function lastTurnFailure(session: WorkbenchSession): string | null {
  const turn = session.last_turn;
  if (
    turn?.state !== 'failed' ||
    session.stopping ||
    session.reconciling ||
    !['idle', 'ready', 'failed'].includes(session.state)
  )
    return null;
  const reason = turn.error_code ? reasonText(turn.error_code) : turn.error?.split('\n')[0];
  // The same words a plan item's failure uses.
  const handler =
    session.spawned_by && turn.told_main_agent
      ? t({ id: 'project.plan.mainAgentKnows', defaultMessage: 'Main agent knows' })
      : t({ id: 'project.plan.forYou', defaultMessage: 'Up to you' });
  return reason
    ? t(
        {
          id: 'components.sessionState.lastTurnFailedBecause',
          defaultMessage: 'Last turn failed · {handler}: {reason}',
        },
        { reason, handler },
      )
    : t(
        {
          id: 'components.sessionState.lastTurnFailedHandled',
          defaultMessage: 'Last turn failed. {handler}',
        },
        { handler },
      );
}

/** The one recap text a session row, header or board card shows: what it needs while it waits. */
export function recapLine(recap: SessionRecap | undefined, waiting: boolean): string | null {
  if (!recap) return null;
  return (waiting && recap.needs_you) || recap.headline;
}

const INTERRUPTED: Glyph = {
  shape: 'filled-square',
  get label() {
    return t({
      id: 'components.sessionState.lastTurnInterrupted',
      defaultMessage: 'Last turn interrupted',
    });
  },
  tone: '--idle',
  draw: stopSquare,
};

export function LastTurnMark({ session }: { session: WorkbenchSession }) {
  const label = lastTurnLabel(session);
  if (!label) return null;
  const glyph = session.last_turn?.state === 'failed' ? GLYPHS.failed : INTERRUPTED;
  return <Svg glyph={{ ...glyph, label }} />;
}

type GateState = NonNullable<WorkbenchSession['gate']>['state'];

const GATES: Record<GateState | 'none', Glyph> = {
  running: {
    shape: 'shield-arc',
    get label() {
      return t({ id: 'components.gate.running', defaultMessage: 'Gates running' });
    },
    tone: '--run',
    draw: (
      <>
        {shield}
        {arc(7, 6.75, 2)}
      </>
    ),
  },
  cancelling: {
    shape: 'shield-stop-arc',
    get label() {
      return t({ id: 'components.gate.cancelling', defaultMessage: 'Cancelling gates' });
    },
    tone: '--run',
    draw: (
      <>
        {shield}
        {arc(7, 6.75, 2.75)}
        <path d="M6 5.75h2v2H6Z" />
      </>
    ),
  },
  cancelled: {
    shape: 'shield-stop',
    get label() {
      return t({ id: 'components.gate.cancelled', defaultMessage: 'Gates cancelled' });
    },
    tone: '--idle',
    draw: (
      <>
        {shield}
        <path d="M5.5 5.25h3v3h-3Z" />
      </>
    ),
  },
  passed: {
    shape: 'shield-check',
    get label() {
      return t({ id: 'components.gate.passed', defaultMessage: 'Gates passed' });
    },
    tone: '--ok',
    draw: (
      <>
        {shield}
        <path d="m5 6.9 1.4 1.4L9 5.7" />
      </>
    ),
  },
  failed: {
    shape: 'shield-cross',
    get label() {
      return t({ id: 'components.gate.failed', defaultMessage: 'Gates failed' });
    },
    tone: '--bad',
    draw: (
      <>
        {shield}
        <path d="m5.5 5.25 3 3m0-3-3 3" />
      </>
    ),
  },
  stale: {
    shape: 'dashed-shield',
    get label() {
      return t({ id: 'components.gate.stale', defaultMessage: 'Gates out of date' });
    },
    tone: '--idle',
    draw: <g strokeDasharray="2 1.75">{shield}</g>,
  },
  none: {
    shape: 'shield',
    get label() {
      return t({ id: 'components.gate.none', defaultMessage: 'Gates not run' });
    },
    tone: '--idle',
    draw: shield,
  },
};

/** The session's newest gate run, beside its state glyph, or a gate state given alone; nothing without either. */
export function GateMark({
  gate,
  state,
}: {
  gate?: WorkbenchSession['gate'];
  state?: GateState | 'none';
}) {
  const shown = state ?? gate?.state;
  if (!shown) return null;
  return <Svg glyph={GATES[shown]} />;
}

const MERGE_BLOCKED: Glyph = {
  shape: 'merge-blocked',
  get label() {
    return t({ id: 'components.sessionState.mergeBlocked', defaultMessage: 'Merge blocked' });
  },
  tone: '--bad',
  draw: (
    <>
      {mergePath}
      <path d="M10 7v5" />
    </>
  ),
};

/** A merge that cannot go ahead, beside the gate mark; nothing otherwise. */
export function MergeBlockedMark({ merge }: { merge: WorkbenchSession['merge'] }) {
  if (merge?.state !== 'blocked') return null;
  return <MergeBlockedGlyph />;
}

/** The blocked-merge glyph on its own, where a list names the blocked merge in words. */
export function MergeBlockedGlyph() {
  return <Svg glyph={MERGE_BLOCKED} />;
}
