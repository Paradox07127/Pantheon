import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@base-ui/react/dialog';
import { ChartColumn, Table2 } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { runtimeColor } from '../../components/RuntimeGlyph';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import {
  acceptanceEvidence,
  criteriaLines,
  milestoneCounts,
  milestoneFinished,
  milestoneSessions,
  tellLeadDraft,
  visibleMilestones,
  watchAcceptance,
  type BoardMilestone,
  type BoardTask,
  type RunBoardCommand,
  type SnapshotMilestone,
  type SnapshotSession,
} from './panels-model';
import { StatusIcon } from './status';
import { TellLead, useDialogContent } from './TellLead';
import './charts.css';

/* Shared panel parts */

export function Panel({
  title,
  className,
  num,
  tools,
  children,
}: {
  title: string;
  className?: string;
  num?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`bp-pn${className ? ` ${className}` : ''}`} aria-labelledby={id}>
      <div className="bp-ph">
        <h2 id={id}>{title}</h2>
        {num}
        {tools && <div className="bp-tools">{tools}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="bp-empty">{text}</div>;
}

/** Bolds the digits of a title-row number, e.g. "3 时 15 分". */
export function NumText({ text }: { text: string }) {
  return <>{text.split(/([\d.]+)/).map((part, i) => (i % 2 ? <b key={i}>{part}</b> : part))}</>;
}

/** Tracks an element's content box; pass the setter as the element's ref. */
export function useSize() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, size] as const;
}

export interface TipRow {
  label: string;
  value: string;
  swatch?: ReactNode;
}
export interface TipContent {
  head?: string;
  rows: TipRow[];
}

function FloatTip({
  id,
  x,
  y,
  content,
}: {
  id: string;
  x: number;
  y: number;
  content: TipContent;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y, content]);
  return createPortal(
    <div ref={ref} id={id} className="bp-tip" role="tooltip" style={pos}>
      {content.head && <div className="h">{content.head}</div>}
      {content.rows.map((row, i) => (
        <div className="r" key={i}>
          {row.swatch}
          <span className="k">{row.label}</span>
          <span className="v">{row.value}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

let tipSeq = 0;

/** Pass `owner` to `show` so the trigger can point `aria-describedby` at the tip via `describedBy`. */
export function useFloatTip() {
  // Not useId: chart tests drive this hook without a React renderer.
  const [id] = useState(() => `bp-tip-${++tipSeq}`);
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    content: TipContent;
    owner?: string;
  } | null>(null);
  const show = useCallback(
    (e: { clientX: number; clientY: number }, content: TipContent, owner?: string) =>
      setTip({ x: e.clientX, y: e.clientY, content, owner }),
    [],
  );
  const hide = useCallback(() => setTip(null), []);
  const shown = tip !== null;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTip(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown]);
  return {
    node: tip ? <FloatTip id={id} x={tip.x} y={tip.y} content={tip.content} /> : null,
    show,
    hide,
    describedBy: (owner: string) => (tip?.owner === owner ? id : undefined),
  };
}

export const WarnIcon = () => (
  <svg className="bp-ic" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M6 1.4 11 10.4H1z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M6 4.8v2.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="6" cy="8.9" r=".75" fill="currentColor" />
  </svg>
);

export function ViewToggle({ table, onToggle }: { table: boolean; onToggle: () => void }) {
  return (
    <button
      className="bp-ib"
      type="button"
      aria-pressed={table}
      aria-label={
        table
          ? t({ id: 'board.charts.chartView', defaultMessage: 'Chart view' })
          : t({ id: 'board.charts.tableView', defaultMessage: 'Table view' })
      }
      onClick={onToggle}
    >
      {table ? <ChartColumn aria-hidden="true" /> : <Table2 aria-hidden="true" />}
    </button>
  );
}

export function DataTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="bp-dtw">
      <table className="bp-dt">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={i ? 'n' : undefined} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={i ? 'n' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { runtimeColor };

/* Chart geometry */

export function niceScale(max: number, integer: boolean) {
  if (max <= 0) return { max: integer ? 4 : 1, step: integer ? 1 : 0.25 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nm = raw / mag;
  let step = (nm <= 1 ? 1 : nm <= 2 ? 2 : nm <= 2.5 && !integer ? 2.5 : nm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

export function scaleSteps(scale: { max: number; step: number }) {
  const values: number[] = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) values.push(v);
  return values;
}

/** Moves end labels apart so none overlap, keeping all inside [lo, hi]. */
export function spreadLabels<T extends { y: number }>(labels: T[], lo: number, hi: number): T[] {
  const gap = 14;
  const sorted = labels.slice().sort((a, b) => a.y - b.y);
  sorted.forEach((label, i) => {
    const prev = sorted[i - 1];
    label.y = Math.max(label.y, lo, prev ? prev.y + gap : lo);
  });
  for (let i = sorted.length - 1; i >= 0; i--) {
    const next = sorted[i + 1];
    sorted[i]!.y = Math.max(lo, Math.min(sorted[i]!.y, next ? next.y - gap : hi));
  }
  return sorted;
}

/* Milestones */

export interface MilestoneActions {
  projectId: string;
  /** Snapshot rows; they carry the revisions and the stored title, sessions and criteria. */
  milestones: readonly SnapshotMilestone[];
  sessions: readonly SnapshotSession[];
  run: RunBoardCommand;
}

const toggled = (set: ReadonlySet<string>, id: string): Set<string> => {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
};

function DialogFrame({
  title,
  error,
  busy,
  ready,
  blocked = null,
  submit,
  onSubmit,
  children,
}: {
  title: string;
  error: string | null;
  busy: boolean;
  ready: boolean;
  /** Why submit is disabled; shown on hover and read with the button. */
  blocked?: string | null;
  submit: string;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const blockedId = useId();
  const button = (
    <button
      type="button"
      className="btn pri"
      aria-busy={busy || undefined}
      aria-describedby={blocked ? blockedId : undefined}
      disabled={busy || !ready || blocked !== null}
      onClick={onSubmit}
    >
      {submit}
    </button>
  );
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="pj-scrim" />
      <Dialog.Popup className="pj-dlg pj-rm pop">
        <div className="pj-dh">
          <Dialog.Title className="pj-dt">{title}</Dialog.Title>
        </div>
        <div className="bp-dlb">{children}</div>
        {error && (
          <div className="pj-err" role="alert">
            <b>{error}</b>
          </div>
        )}
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <Dialog.Close className="btn ghost">
            {t({ id: 'board.dialog.cancel', defaultMessage: 'Cancel' })}
          </Dialog.Close>
          {blocked ? <Tip content={blocked}>{button}</Tip> : button}
          {blocked && (
            <span id={blockedId} hidden>
              {blocked}
            </span>
          )}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

/** Runs one command from a dialog; closes it once the command went through. */
function useDialogCommand(run: RunBoardCommand, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Some submit was refused; it stays set through later tries. */
  const [refused, setRefused] = useState(false);
  const send = async (...args: Parameters<RunBoardCommand>) => {
    setBusy(true);
    setError(null);
    const failure = await run(...args);
    setBusy(false);
    if (failure) {
      setError(failure);
      setRefused(true);
    } else onClose();
  };
  return { busy, error, refused, send };
}

/**
 * `task:<plan task id>` for each done task of a ready lead milestone whose sessions are not all
 * merged; only the lead's acceptance makes such a task done.
 */
function acceptedTaskEvidence(
  milestone: BoardMilestone,
  tasks: readonly BoardTask[],
  merged: ReadonlySet<string>,
): { ref: string; label: string }[] {
  return tasks
    .filter(
      (t) =>
        t.milestone_id === milestone.id &&
        t.owner_session_id === milestone.owner_session_id &&
        t.status === 'done' &&
        !t.segments
          .filter((s) => s.status !== 'discarded')
          .every((s) => s.session_id !== null && merged.has(s.session_id)),
    )
    .map((t) => ({ ref: `task:${t.id.slice(t.id.indexOf(':') + 1)}`, label: t.title }));
}

/** What an acceptance of this milestone cites: its merged sessions by title, then its tasks done without a merge. */
export function acceptEvidence(
  ms: BoardMilestone,
  model: BoardModel,
  sessions: readonly SnapshotSession[],
): { ref: string; label: string }[] {
  const merged = acceptanceEvidence(ms, model.merges, sessions).map((ref) =>
    ref.slice('session:'.length),
  );
  const titleOf = (sessionId: string) =>
    sessions.find((s) => s.id === sessionId)?.title ??
    model.merges.find((m) => m.session_id === sessionId)?.title ??
    sessionId;
  return [
    ...merged.map((id) => ({ ref: `session:${id}`, label: titleOf(id) })),
    ...(ms.owner_session_id === undefined
      ? []
      : acceptedTaskEvidence(ms, model.tasks, new Set(merged))),
  ];
}

export function AcceptDialog({
  stored,
  evidence,
  run,
  onClose,
}: {
  /** The milestone's newest snapshot row. */
  stored: SnapshotMilestone;
  evidence: { ref: string; label: string }[];
  run: RunBoardCommand;
  onClose: () => void;
}) {
  const [opened] = useState(stored);
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(evidence.map((e) => e.ref)),
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const { busy, error, refused, send } = useDialogCommand(run, onClose);
  // The row whose revision the acceptance names and whose title and criteria are shown: the one
  // the dialog opened on, the newest once a submit was refused.
  const row = refused ? stored : opened;
  const refs = evidence.map((e) => e.ref).filter((ref) => picked.has(ref));
  const criteria = row.criteria.map((_, index) => index);
  const left = criteria.filter((index) => !checked.has(String(index))).length;
  return (
    <DialogFrame
      title={t(
        { id: 'board.accept.title', defaultMessage: 'Accept “{milestone}”' },
        { milestone: row.title },
      )}
      error={error}
      busy={busy}
      ready={refs.length > 0}
      blocked={
        left
          ? t(
              {
                id: 'board.accept.criteriaLeft',
                defaultMessage:
                  '{count, plural, one {# criterion not checked yet} other {# criteria not checked yet}}',
              },
              { count: left },
            )
          : null
      }
      submit={t({ id: 'board.accept.submit', defaultMessage: 'Accept' })}
      onSubmit={() =>
        void send(
          'milestone.accept',
          { milestone_id: row.id, evidence_refs: refs, criteria_checked: criteria },
          row.revision,
        )
      }
    >
      <div className="pj-lb">{t({ id: 'board.accept.evidence', defaultMessage: 'Evidence' })}</div>
      <div
        className="bp-picks"
        role="group"
        aria-label={t({ id: 'board.accept.evidence', defaultMessage: 'Evidence' })}
      >
        {evidence.map(({ ref, label }) => (
          <label key={ref}>
            <input
              type="checkbox"
              checked={picked.has(ref)}
              onChange={() => setPicked((now) => toggled(now, ref))}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {criteria.length > 0 && (
        <>
          <div className="pj-lb">
            {t({ id: 'board.milestones.criteria', defaultMessage: 'Criteria' })}
          </div>
          <div
            className="bp-picks"
            role="group"
            aria-label={t({ id: 'board.milestones.criteria', defaultMessage: 'Criteria' })}
          >
            {row.criteria.map((criterion, index) => (
              <label key={index}>
                <input
                  type="checkbox"
                  checked={checked.has(String(index))}
                  onChange={() => setChecked((now) => toggled(now, String(index)))}
                />
                <span>{criterion}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </DialogFrame>
  );
}

function MilestoneDialog({
  stored,
  actions,
  onClose,
}: {
  /** The newest snapshot row of the milestone being revised; null creates one. */
  stored: SnapshotMilestone | null;
  actions: MilestoneActions;
  onClose: () => void;
}) {
  const [opened] = useState(stored);
  const [title, setTitle] = useState(stored?.title ?? '');
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(stored?.required_sessions ?? []),
  );
  const [criteria, setCriteria] = useState(stored?.criteria.join('\n') ?? '');
  const { busy, error, refused, send } = useDialogCommand(actions.run, onClose);
  // The draft revises the row it opened on, the newest once a submit was refused.
  const row = refused ? stored : opened;
  const lines = criteriaLines(criteria);
  const input = { title: title.trim(), required_sessions: [...picked], criteria: lines };
  return (
    <DialogFrame
      title={
        row
          ? t(
              { id: 'board.milestoneForm.reviseTitle', defaultMessage: 'Revise “{milestone}”' },
              { milestone: row.title },
            )
          : t({ id: 'board.milestoneForm.newTitle', defaultMessage: 'New milestone' })
      }
      error={error}
      busy={busy}
      ready={!!input.title && picked.size > 0 && lines.length > 0}
      submit={
        row
          ? t({ id: 'board.milestoneForm.save', defaultMessage: 'Save' })
          : t({ id: 'board.milestoneForm.create', defaultMessage: 'Create' })
      }
      onSubmit={() =>
        void (row
          ? send('milestone.revise', { milestone_id: row.id, ...input }, row.revision)
          : send('milestone.create', { project_id: actions.projectId, ...input }, null))
      }
    >
      <label className="pj-lb" htmlFor="bp-ms-title">
        {t({ id: 'board.milestoneForm.titleField', defaultMessage: 'Title' })}
      </label>
      <div className="pj-inp">
        <input id="bp-ms-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="pj-lb">
        {t({ id: 'board.milestoneForm.sessions', defaultMessage: 'Required sessions' })}
      </div>
      <div
        className="bp-picks"
        role="group"
        aria-label={t({ id: 'board.milestoneForm.sessions', defaultMessage: 'Required sessions' })}
      >
        {milestoneSessions(actions.sessions, actions.projectId).map((s) => (
          <label key={s.id}>
            <input
              type="checkbox"
              checked={picked.has(s.id)}
              onChange={() => setPicked((now) => toggled(now, s.id))}
            />
            <span>{s.title ?? s.id}</span>
          </label>
        ))}
      </div>
      <label className="pj-lb" htmlFor="bp-ms-criteria">
        {t({ id: 'board.milestones.criteria', defaultMessage: 'Criteria' })}
      </label>
      <textarea
        id="bp-ms-criteria"
        className="bp-ta"
        rows={4}
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
      />
    </DialogFrame>
  );
}

export function Milestones({ model, actions }: { model: BoardModel; actions?: MilestoneActions }) {
  const [expanded, setExpanded] = useState(false);
  // stored null: the create form.
  const form = useDialogContent<{ stored: SnapshotMilestone | null }>();
  const accepting = useDialogContent<{ milestone: BoardMilestone; stored: SnapshotMilestone }>();
  const [watch, setWatch] = useState(() => ({
    of: model.milestones,
    ...watchAcceptance(null, model.milestones),
  }));
  if (watch.of !== model.milestones)
    setWatch({ of: model.milestones, ...watchAcceptance(watch, model.milestones) });
  const { rows, hidden } = visibleMilestones(model.milestones, expanded);
  // A dialog stays open across snapshot refreshes; it gets the row as it is now.
  const newest = (row: SnapshotMilestone) =>
    actions?.milestones.find((m) => m.id === row.id) ?? row;
  return (
    <Panel
      title={t({ id: 'board.milestones.title', defaultMessage: 'Milestones' })}
      tools={
        actions && (
          <button className="bp-lnk" type="button" onClick={() => form.show({ stored: null })}>
            {t({ id: 'board.milestones.new', defaultMessage: 'New' })}
          </button>
        )
      }
    >
      {rows.length === 0 ? (
        <Empty text={t({ id: 'board.milestones.empty', defaultMessage: 'No milestones yet' })} />
      ) : (
        <div>
          {rows.map((ms) => {
            const finished = milestoneFinished(ms);
            const { done, total } = milestoneCounts(ms);
            const lead = ms.owner_session_id !== undefined;
            const stored = actions?.milestones.find((m) => m.id === ms.id);
            return (
              <Fragment key={ms.id}>
                <div
                  className={`bp-msr${lead ? ' bp-msl' : ''}${finished ? ' fin' : ''}${actions ? ' with-acts' : ''}`}
                >
                  <span className="nm">{ms.title}</span>
                  <span
                    className="bp-trk"
                    role="progressbar"
                    aria-label={ms.title}
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                  >
                    <i
                      className="bp-trk-bar"
                      style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="cnt">
                    {done}/{total}
                  </span>
                  {ms.status === 'stale' ? (
                    <span className="due late">
                      <WarnIcon />
                      {t({ id: 'board.milestones.stale', defaultMessage: 'Stale' })}
                    </span>
                  ) : ms.status === 'ready_for_acceptance' ? (
                    lead ? (
                      <span className="due">
                        <StatusIcon status="ready" />
                        {t({
                          id: 'board.milestones.awaitingLead',
                          defaultMessage: 'Awaiting lead acceptance',
                        })}
                      </span>
                    ) : (
                      <span className="due">
                        {t({
                          id: 'board.milestones.awaiting',
                          defaultMessage: 'Awaiting acceptance',
                        })}
                      </span>
                    )
                  ) : ms.status === 'completed' ? (
                    <span className="due">
                      {watch.accepted.has(ms.id) ? (
                        <span className="bp-acc-in">
                          <StatusIcon status="done" />
                        </span>
                      ) : (
                        <StatusIcon status="done" />
                      )}
                      {t({ id: 'board.milestones.accepted', defaultMessage: 'Accepted' })}
                    </span>
                  ) : (
                    <span className="due">
                      <StatusIcon status="running" />
                      {t({ id: 'board.milestones.inProgress', defaultMessage: 'In progress' })}
                    </span>
                  )}
                  {actions && (
                    <span className="acts">
                      {stored && ms.status === 'ready_for_acceptance' && (
                        <button
                          className="bp-lnk"
                          type="button"
                          aria-label={t(
                            {
                              id: 'board.milestones.acceptLabel',
                              defaultMessage: 'Accept {milestone}',
                            },
                            { milestone: ms.title },
                          )}
                          onClick={() => accepting.show({ milestone: ms, stored })}
                        >
                          {t({ id: 'board.milestones.accept', defaultMessage: 'Accept' })}
                        </button>
                      )}
                      {lead && (
                        <TellLead
                          className="bp-lnk"
                          lead={actions.sessions.find((s) => s.id === ms.owner_session_id)}
                          draft={tellLeadDraft('milestone', ms.title, stored?.key ?? ms.id)}
                          label={ms.title}
                          run={actions.run}
                        />
                      )}
                      {stored && !lead && (
                        <button
                          className="bp-lnk"
                          type="button"
                          aria-label={t(
                            {
                              id: 'board.milestones.reviseLabel',
                              defaultMessage: 'Revise {milestone}',
                            },
                            { milestone: ms.title },
                          )}
                          onClick={() => form.show({ stored })}
                        >
                          {t({ id: 'board.milestones.revise', defaultMessage: 'Revise' })}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {ms.criteria.length > 0 && (
                  <ul
                    className="bp-crit"
                    aria-label={t(
                      { id: 'board.milestones.criteriaOf', defaultMessage: '{milestone} criteria' },
                      { milestone: ms.title },
                    )}
                  >
                    {ms.criteria.map((criterion, index) => (
                      <li key={index}>
                        <i
                          className={`mk ${criterion.accepted ? 'acc' : 'pend'}`}
                          role="img"
                          aria-label={
                            criterion.accepted
                              ? t({ id: 'board.milestones.accepted', defaultMessage: 'Accepted' })
                              : t({
                                  id: 'board.milestones.awaiting',
                                  defaultMessage: 'Awaiting acceptance',
                                })
                          }
                        />
                        <span>{criterion.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Fragment>
            );
          })}
          {hidden > 0 && (
            <button className="bp-more" type="button" onClick={() => setExpanded(true)}>
              {t(
                { id: 'board.milestones.more', defaultMessage: '{count} more' },
                { count: hidden },
              )}
            </button>
          )}
        </div>
      )}
      {actions && (
        <>
          <Dialog.Root {...form.root}>
            {form.content && (
              <MilestoneDialog
                key={form.content.stored?.id ?? ''}
                stored={form.content.stored && newest(form.content.stored)}
                actions={actions}
                onClose={form.close}
              />
            )}
          </Dialog.Root>
          <Dialog.Root {...accepting.root}>
            {accepting.content && (
              <AcceptDialog
                key={accepting.content.stored.id}
                stored={newest(accepting.content.stored)}
                evidence={acceptEvidence(accepting.content.milestone, model, actions.sessions)}
                run={actions.run}
                onClose={accepting.close}
              />
            )}
          </Dialog.Root>
        </>
      )}
    </Panel>
  );
}
