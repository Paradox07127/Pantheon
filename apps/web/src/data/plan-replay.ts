import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanReplay, PlanReplayFrame } from '@pantheon/protocol';
import { t } from '../i18n';
import { reasonText } from './needs-you';
import { readQuery } from './workbench-sessions';

const FIRST_PAGE = 100;
const PAGE = 500;
/** Earlier pages load by themselves until this many frames are in; then one page per request. */
export const REPLAY_BACKGROUND_FRAMES = 2000;
// No event sequence reaches it, so a page before it is the plan's last.
const END = String(Number.MAX_SAFE_INTEGER);

export interface PlanReplayRead {
  /** The loaded frames, oldest first; always the plan's newest ones. */
  frames: PlanReplayFrame[];
  /** The plan's frames in all pages. */
  total: number;
  /** When the plan's first and last frames happened; null until the first page is in. */
  firstAt: number | null;
  lastAt: number | null;
  /** The first page is out. */
  loading: boolean;
  /** The first page failed. */
  error: string | null;
  /** A page of earlier frames is out. */
  loadingEarlier: boolean;
  /** The last page of earlier frames failed; `before` is the frame it was read before. */
  earlierError: { message: string; before: PlanReplayFrame } | null;
  /** Earlier frames remain and wait for loadEarlier. */
  held: boolean;
  /** Repeats the failed read. */
  retry: () => void;
  loadEarlier: () => void;
}

interface ReplayState {
  lead: string;
  frames: PlanReplayFrame[];
  total: number;
  firstAt: number | null;
  lastAt: number | null;
  loaded: boolean;
  error: string | null;
  earlierError: string | null;
  /** Earlier pages load while fewer frames than this are in. */
  budget: number;
}

const start = (lead: string): ReplayState => ({
  lead,
  frames: [],
  total: 0,
  firstAt: null,
  lastAt: null,
  loaded: false,
  error: null,
  earlierError: null,
  budget: REPLAY_BACKGROUND_FRAMES,
});

async function readPage(
  lead: string,
  params: Record<string, string>,
): Promise<{ page: PlanReplay } | { error: string }> {
  const result = await readQuery('board.plan.replay', { lead_session_id: lead, ...params });
  if (!result.ok)
    return {
      error: t(
        { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
        { reason: reasonText(result.error.code), message: result.error.message },
      ),
    };
  const page = result.value as PlanReplay | null;
  return Array.isArray(page?.frames)
    ? { page }
    : {
        error: t(
          { id: 'data.read.incomplete', defaultMessage: 'Incomplete read result ({method})' },
          { method: 'board.plan.replay' },
        ),
      };
}

/**
 * The lead plan's replay frames: the last page first, then earlier pages before it. Frames stay
 * while the hook is mounted for the same lead; another lead starts over.
 */
export function usePlanReplay(leadId: string): PlanReplayRead {
  const [state, setState] = useState<ReplayState>(() => start(leadId));
  const [attempt, setAttempt] = useState(0);
  // The frame the earlier page out was asked before.
  const asking = useRef<number | null>(null);
  const shown = state.lead === leadId ? state : start(leadId);

  useEffect(() => {
    let current = true;
    setState(start(leadId));
    asking.current = null;
    // The first frame's time places the loaded frames on the plan's whole span from the start.
    void Promise.all([
      readPage(leadId, { before: END, limit: String(FIRST_PAGE) }),
      readPage(leadId, { after: '0', limit: '1' }),
    ]).then(([last, first]) => {
      if (!current) return;
      if ('error' in last || 'error' in first) {
        setState({
          ...start(leadId),
          error: 'error' in last ? last.error : (first as { error: string }).error,
        });
        return;
      }
      setState({
        ...start(leadId),
        loaded: true,
        frames: last.page.frames,
        total: last.page.total,
        lastAt: last.page.last_at,
        firstAt: first.page.frames[0]?.at ?? null,
      });
    });
    return () => {
      current = false;
    };
  }, [leadId, attempt]);

  const oldest = shown.frames[0];
  const earlier =
    shown.loaded &&
    !shown.earlierError &&
    oldest !== undefined &&
    shown.frames.length < shown.total &&
    shown.frames.length < shown.budget;
  useEffect(() => {
    if (!earlier || asking.current === oldest.sequence) return;
    asking.current = oldest.sequence;
    void readPage(leadId, { before: String(oldest.sequence), limit: String(PAGE) }).then((read) => {
      if (asking.current !== oldest.sequence) return;
      asking.current = null;
      setState((s) =>
        s.lead !== leadId || s.frames[0] !== oldest
          ? s
          : 'error' in read
            ? { ...s, earlierError: read.error }
            : { ...s, frames: [...read.page.frames, ...s.frames], total: read.page.total },
      );
    });
  }, [earlier, oldest, leadId]);

  const retry = useCallback(() => {
    if (shown.earlierError) setState((s) => ({ ...s, earlierError: null }));
    else setAttempt((n) => n + 1);
  }, [shown.earlierError]);
  const loadEarlier = useCallback(
    () => setState((s) => ({ ...s, budget: s.frames.length + PAGE })),
    [],
  );

  const held =
    shown.loaded &&
    !shown.earlierError &&
    shown.frames.length < shown.total &&
    shown.frames.length >= shown.budget;
  return {
    frames: shown.frames,
    total: shown.total,
    firstAt: shown.firstAt,
    lastAt: shown.lastAt,
    loading: !shown.loaded && !shown.error,
    error: shown.error,
    loadingEarlier: earlier,
    earlierError:
      shown.earlierError && oldest ? { message: shown.earlierError, before: oldest } : null,
    held,
    retry,
    loadEarlier,
  };
}
