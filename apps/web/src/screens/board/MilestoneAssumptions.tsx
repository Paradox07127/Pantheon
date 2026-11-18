import { useId, useMemo, useRef, useState } from 'react';
import { CircleDot, TriangleAlert, Undo2, User, X } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { toast } from '../../components/Toast';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { planVersion } from '../../data/plan-edit';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { clockText } from '../../lib/time-text';
import { leadState } from './frame-model';
import type { BoardMilestone } from './panels-model';
import { StatusIcon, TaskStateIcon, taskStateLabel } from './status';
import './assumptions.css';

type Assumption = NonNullable<BoardMilestone['assumptions']>[number];
type Refused = { id: string; kind: 'stale' | 'gone' | 'other'; text: string; instead: string };
type Refuted = Omit<NonNullable<Assumption['refuted']>, 'edit_id'> & { edit_id?: string };
/** What the daemon took from this window before the board shows it: `edit` is the refute edit the board showed then. */
type Taken = { id: string; instead: string; state: 'pending' | 'withdrawn'; edit?: string };

const FIRST = 4;
const FIRST_TASKS = 3;

/** The assumptions with an id that the milestone rests on; the user says one is wrong here. */
export function MilestoneAssumptions({
  model,
  milestone,
  projectId,
  onOpenTask,
  onOpenSession,
}: {
  model: BoardModel;
  milestone: BoardMilestone;
  projectId?: string;
  onOpenTask: (taskId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [taken, setTaken] = useState<Taken | null>(null);
  // The row whose refute button takes the focus back once its edit closes.
  const refocus = useRef<string | null>(null);
  // A notice's Undo sends on the plan version of the board at that time, not when the notice opened.
  const latest = useRef({ model, milestone });
  latest.current = { model, milestone };
  const tasks = useMemo(() => new Map(model.tasks.map((task) => [task.id, task])), [model.tasks]);
  const assumptions = milestone.assumptions ?? [];
  if (!assumptions.length) return null;
  const leadId = milestone.owner_session_id;
  const lead = model.leads?.find((l) => l.session_id === leadId);
  const leadName = lead?.title || t({ id: 'board.lead.untitled', defaultMessage: 'Lead' });

  const send = async (assumptionId: string, instead: string) => {
    if (!projectId || !leadId) return;
    const before = latest.current.milestone.assumptions?.find((a) => a.id === assumptionId)?.refuted
      ?.edit_id;
    setRefused(null);
    setSending(assumptionId);
    const result = await runCommand(
      'board.plan.edit',
      {
        project_id: projectId,
        lead_session_id: leadId,
        base_version: planVersion(latest.current.model, leadId),
        ops: [{ type: 'refute_assumption', assumption_id: assumptionId, instead }],
      },
      null,
    );
    setSending(null);
    const kind = result.ok
      ? null
      : result.error.code === 'revision_conflict'
        ? 'stale'
        : result.error.code === 'not_found'
          ? 'gone'
          : 'other';
    if (kind === null) setTaken({ id: assumptionId, instead, state: 'pending', edit: before });
    if (kind === null || kind === 'gone')
      setDraft((open) => (open?.id === assumptionId ? null : open));
    if (!result.ok && kind)
      setRefused({ id: assumptionId, kind, text: failureText(result.error), instead });
  };
  const withdraw = async (assumption: Assumption, editId: string, instead: string) => {
    if (!projectId || !leadId) return;
    setRefused(null);
    const result = await runCommand(
      'board.plan.edit.withdraw',
      { project_id: projectId, lead_session_id: leadId, edit_id: editId },
      null,
    );
    if (!result.ok)
      return setRefused({
        id: assumption.id,
        kind: 'other',
        text: failureText(result.error),
        instead,
      });
    setTaken({ id: assumption.id, instead, state: 'withdrawn', edit: editId });
    toast({
      title: t(
        { id: 'board.assumptions.withdrew', defaultMessage: 'Withdrew your change to “{text}”' },
        { text: assumption.text },
      ),
      action: {
        label: t({ id: 'board.assumptions.undo', defaultMessage: 'Undo' }),
        run: () => void send(assumption.id, instead),
      },
    });
  };
  // The board's refute, or what this window sent until the board shows a later state of it.
  const refutedOf = (assumption: Assumption): Refuted | undefined => {
    const board = assumption.refuted;
    if (taken?.id !== assumption.id || board?.edit_id !== taken.edit) return board;
    if (taken.state === 'pending') return { instead: taken.instead, state: 'pending' };
    return board?.state === 'pending' ? { ...board, state: 'withdrawn' } : board;
  };
  const close = (assumptionId: string) => {
    setDraft(null);
    setRefused(null);
    refocus.current = assumptionId;
  };

  const restsOn = (assumption: Assumption) => {
    const resting = assumption.affects.flatMap((taskId) => tasks.get(taskId) ?? []);
    if (!resting.length) return null;
    const open = unfolded.has(assumption.id);
    const shown = open ? resting : resting.slice(0, FIRST_TASKS);
    const rest = resting.slice(FIRST_TASKS);
    return (
      <ul
        className="bma-k"
        aria-label={t(
          {
            id: 'board.assumptions.rests',
            defaultMessage:
              '{count, plural, one {Rests on it: # task} other {Rests on it: # tasks}}',
          },
          { count: resting.length },
        )}
      >
        {shown.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="bma-tk"
              aria-label={t(
                { id: 'board.task.link.label', defaultMessage: '{title}, {status}' },
                { title: task.title, status: taskStateLabel(task) },
              )}
              onClick={() => onOpenTask(task.id)}
            >
              <TaskStateIcon task={task} />
              <Clip text={task.title} />
            </button>
          </li>
        ))}
        {!open && rest.length > 0 && (
          <li>
            <button
              type="button"
              className="btn sm ghost"
              aria-expanded={false}
              aria-label={t(
                {
                  id: 'board.assumptions.moreLabel',
                  defaultMessage:
                    '{count, plural, one {Show # more task: {titles}} other {Show # more tasks: {titles}}}',
                },
                { count: rest.length, titles: listText(...rest.map((task) => task.title)) },
              )}
              onClick={() => setUnfolded(new Set(unfolded).add(assumption.id))}
            >
              {t(
                { id: 'board.assumptions.more', defaultMessage: '{count, plural, other {# more}}' },
                { count: rest.length },
              )}
            </button>
          </li>
        )}
      </ul>
    );
  };

  const outcome = (assumption: Assumption) => {
    const refuted = refutedOf(assumption);
    if (!refuted) return null;
    if (refuted.state === 'pending') {
      const editId = refuted.edit_id;
      const at = lead?.pending_edits?.find((edit) => edit.id === editId)?.created_at;
      return (
        <div className="bma-rf">
          <span className="bma-w">
            <User
              role="img"
              aria-label={t({ id: 'board.assumptions.youSaid', defaultMessage: 'You said' })}
            />
            <q>{refuted.instead}</q>
          </span>
          <span className="bma-rs">
            <StatusIcon status="todo" />
            {t({ id: 'board.assumptions.pending', defaultMessage: 'Waits for the lead' })}
          </span>
          {at !== undefined && <span className="bma-at">{clockText(at)}</span>}
          {projectId && leadId && editId && (
            <button
              type="button"
              className="btn sm ghost"
              aria-label={t(
                {
                  id: 'board.assumptions.withdrawLabel',
                  defaultMessage: 'Withdraw your change to: {text}',
                },
                { text: assumption.text },
              )}
              onClick={() => void withdraw(assumption, editId, refuted.instead)}
            >
              {t({ id: 'board.assumptions.withdraw', defaultMessage: 'Withdraw' })}
            </button>
          )}
        </div>
      );
    }
    if (refuted.state === 'applied')
      return (
        <div className="bma-rf">
          <span className="bma-rs">
            <StatusIcon status="done" />
            {t({ id: 'board.assumptions.applied', defaultMessage: 'Lead changed the plan' })}
          </span>
        </div>
      );
    if (refuted.state === 'rejected')
      return (
        <div className="bma-rf">
          <span className="bma-w">
            <User
              role="img"
              aria-label={t({ id: 'board.assumptions.youSaid', defaultMessage: 'You said' })}
            />
            <q>{refuted.instead}</q>
          </span>
          <span className="bma-rs">
            <X aria-hidden="true" />
            {t({ id: 'board.assumptions.rejected', defaultMessage: 'Lead kept it' })}
          </span>
          {refuted.reason && <span className="bma-why">{refuted.reason}</span>}
          {onOpenSession && lead && (
            <button
              type="button"
              className="btn sm ghost"
              aria-label={t(
                {
                  id: 'board.frame.lead.label',
                  defaultMessage: '{name} {state}, open session',
                },
                { name: leadName, state: leadState(lead).label },
              )}
              onClick={() => onOpenSession(lead.session_id)}
            >
              {t({ id: 'board.lead.line.open', defaultMessage: 'Open lead' })}
            </button>
          )}
        </div>
      );
    return (
      <div className="bma-rf">
        <span className="bma-w">
          <User
            role="img"
            aria-label={t({
              id: 'board.assumptions.youWithdrew',
              defaultMessage: 'You said, then withdrew',
            })}
          />
          <del>{refuted.instead}</del>
        </span>
        <span className="bma-rs">
          <Undo2 aria-hidden="true" />
          {t({ id: 'board.assumptions.withdrawn', defaultMessage: 'Withdrawn' })}
        </span>
      </div>
    );
  };

  const row = (assumption: Assumption) => {
    const editing = draft?.id === assumption.id ? draft : null;
    const failure = refused?.id === assumption.id ? refused : null;
    const errorId = `${id}-${assumption.id}-err`;
    const version = leadId ? planVersion(model, leadId) : 0;
    const busy = sending === assumption.id;
    return (
      <li key={assumption.id} className="bma-it">
        <CircleDot className="bma-ic" aria-hidden="true" />
        <div className="bma-b">
          <Clip className="bma-t" text={assumption.text} lines={2} />
          {restsOn(assumption)}
          {editing ? (
            <form
              className="bma-fx"
              aria-label={t(
                {
                  id: 'board.assumptions.formLabel',
                  defaultMessage: 'What holds instead of: {text}',
                },
                { text: assumption.text },
              )}
              onSubmit={(e) => {
                e.preventDefault();
                const instead = editing.text.trim();
                if (instead && !busy) void send(assumption.id, instead);
              }}
            >
              <label className="field">
                <User aria-hidden="true" />
                <input
                  autoFocus
                  maxLength={400}
                  aria-label={t({
                    id: 'board.assumptions.input',
                    defaultMessage: 'What holds instead',
                  })}
                  aria-invalid={failure ? true : undefined}
                  aria-describedby={failure ? errorId : undefined}
                  value={editing.text}
                  onChange={(e) => setDraft({ id: assumption.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return;
                    e.preventDefault();
                    close(assumption.id);
                  }}
                />
              </label>
              <button
                type="submit"
                className="btn sm pri"
                disabled={!editing.text.trim() || busy}
                aria-busy={busy || undefined}
              >
                {t({ id: 'board.assumptions.send', defaultMessage: 'Send' })}
              </button>
              <button type="button" className="btn sm ghost" onClick={() => close(assumption.id)}>
                {t({ id: 'board.assumptions.cancel', defaultMessage: 'Cancel' })}
              </button>
            </form>
          ) : (
            outcome(assumption)
          )}
          {failure && (
            <p className="bma-err" id={errorId} role="alert">
              <TriangleAlert aria-hidden="true" />
              <span>
                {failure.kind === 'stale'
                  ? t(
                      {
                        id: 'board.assumptions.stale',
                        defaultMessage: 'The lead changed the plan to v{version} while you wrote.',
                      },
                      { version },
                    )
                  : failure.kind === 'gone'
                    ? t({
                        id: 'board.assumptions.gone',
                        defaultMessage: 'The plan no longer has this assumption.',
                      })
                    : failure.text}
              </span>
              {failure.kind === 'stale' && (
                <button
                  type="button"
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => void send(assumption.id, failure.instead)}
                >
                  {t(
                    { id: 'board.plan.edit.retry', defaultMessage: 'Resend on v{version}' },
                    { version },
                  )}
                </button>
              )}
            </p>
          )}
        </div>
        <span className="bma-a">
          {projectId && leadId && !editing && refutedOf(assumption)?.state !== 'pending' && (
            <button
              type="button"
              className="btn sm ghost"
              ref={(el) => {
                if (!el || refocus.current !== assumption.id) return;
                refocus.current = null;
                el.focus();
              }}
              onClick={() => {
                setRefused(null);
                setDraft({ id: assumption.id, text: '' });
              }}
            >
              {t({ id: 'board.assumptions.refute', defaultMessage: 'No, do something else' })}
            </button>
          )}
        </span>
      </li>
    );
  };

  const shown = all ? assumptions : assumptions.slice(0, FIRST);
  return (
    <div className="bma">
      <ul
        className="bma-l"
        aria-label={t({ id: 'board.assumptions.list', defaultMessage: 'Assumptions' })}
      >
        {shown.map(row)}
      </ul>
      {!all && assumptions.length > FIRST && (
        <button type="button" className="bma-more" onClick={() => setAll(true)}>
          {t(
            {
              id: 'board.assumptions.showAll',
              defaultMessage: '{count, plural, other {Show all # assumptions}}',
            },
            { count: assumptions.length },
          )}
        </button>
      )}
    </div>
  );
}
