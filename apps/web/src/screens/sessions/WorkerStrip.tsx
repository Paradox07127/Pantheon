import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { StateGlyph } from '../../components/SessionStateIcon';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { workerCounts, workerLanes, type WorkerCounts } from './model';
import { GateSeg } from './SessionHeader';
import { SessionRowButton } from './SessionRow';
import './residents.css';

/** The project's resident leads, in the order the sidebar lists them. */
export const RESIDENTS = [
  {
    kind: 'assistant',
    get name() {
      return t({ id: 'components.sidebar.residentAssistant', defaultMessage: 'Assistant' });
    },
  },
  {
    kind: 'triage',
    get name() {
      return t({ id: 'components.sidebar.residentTriage', defaultMessage: 'Triage' });
    },
  },
] as const;

/** The counts of running, awaiting review and gate failed workers as one sentence. */
export const workerCountsText = (counts: WorkerCounts): string =>
  t(
    {
      id: 'sessions.residents.workers',
      defaultMessage: 'Workers: {running} running, {review} awaiting review, {failed} gate failed',
    },
    { ...counts },
  );

/** Each count beside its state glyph; with `all` the zero counts show too. */
export function workerCountMarks(counts: WorkerCounts, all = false): ReactNode[] {
  const marks = [
    {
      key: 'running',
      n: counts.running,
      glyph: 'running',
      word: t({ id: 'sessions.residents.running', defaultMessage: 'running' }),
    },
    {
      key: 'review',
      n: counts.review,
      glyph: 'ready',
      word: t({ id: 'sessions.residents.review', defaultMessage: 'awaiting review' }),
    },
    {
      key: 'failed',
      n: counts.failed,
      glyph: 'failed',
      word: t({ id: 'sessions.residents.failed', defaultMessage: 'gate failed' }),
    },
  ] as const;
  return marks
    .filter((mark) => all || mark.n > 0)
    .map((mark) => (
      <span key={mark.key} className="ss-wc" aria-hidden="true">
        <StateGlyph name={mark.glyph} place="list" />
        <span className="ss-wn">{mark.n}</span>
        {all && mark.word}
      </span>
    ));
}

/**
 * The bar over a resident's conversation: how many of its workers run, await review and failed
 * their gates; open, its workers by plan lane, a lane every worker of which ended folded.
 */
export function WorkerStrip({ workers }: { workers: readonly WorkbenchSession[] }) {
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  // Lanes the user folded or unfolded against how they start.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  if (workers.length === 0) return null;
  const counts = workerCounts(workers);
  const lanes = workerLanes(workers);
  const toggle = (key: string) =>
    setToggled((before) => {
      const next = new Set(before);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="ss-ws">
      <button
        type="button"
        className="ss-wsb"
        aria-expanded={open}
        aria-label={workerCountsText(counts)}
        onClick={() => setOpen((was) => !was)}
      >
        {workerCountMarks(counts, true)}
        <ChevronDown className="ic-sm ss-wsc" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="ss-wpop pop"
          role="group"
          aria-label={t({ id: 'sessions.residents.workerTree', defaultMessage: 'Workers' })}
        >
          {lanes.map((lane) => {
            const shut = lane.finished !== toggled.has(lane.key);
            const total = lane.workers.length;
            return (
              <section key={lane.key} className="ss-lane" aria-label={lane.title}>
                <button
                  type="button"
                  className="ss-lh"
                  aria-expanded={!shut}
                  onClick={() => toggle(lane.key)}
                >
                  {shut ? (
                    <ChevronRight className="ic-sm" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="ic-sm" aria-hidden="true" />
                  )}
                  <span className="ss-ttl">{lane.title}</span>
                  <span
                    className="ss-lseg"
                    role="img"
                    aria-label={t(
                      {
                        id: 'sessions.residents.laneProgress',
                        defaultMessage:
                          '{total, plural, one {# task} other {# tasks}}, {merged} merged',
                      },
                      { total, merged: lane.merged },
                    )}
                  >
                    <GateSeg
                      passed={lane.merged}
                      failed={lane.failed}
                      skipped={0}
                      running={lane.running}
                      notRun={Math.max(0, total - lane.merged - lane.failed - lane.running)}
                    />
                  </span>
                  <span className="ss-lnum">{`${lane.merged}/${total}`}</span>
                </button>
                {!shut &&
                  lane.workers.map((worker) => (
                    <SessionRowButton
                      key={worker.id}
                      session={worker}
                      on={false}
                      now={now}
                      onSelect={() => useShell.getState().openSession(worker.id)}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
