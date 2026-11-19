import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import {
  addedTaskFields,
  opChanges,
  resolvePlanProposal,
  type PlanOp,
  type PlanProposal,
} from '../../data/plan-edit';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { changeList, PLAN_TITLE_MAX } from './PlanEdit';
import { TASK_TYPE } from './status';
import './edits.css';

/** One op of the proposal with its place in the proposal's list. */
interface Row {
  at: number;
  op: PlanOp;
}

const rowsOf = (proposal: PlanProposal): Row[] => proposal.ops.map((op, at) => ({ at, op }));

/** A lead's pending plan proposal as its ops, each to drop or retitle before the rest is accepted. */
export function ProposalEdit({
  model,
  projectId,
  proposal,
  onCancel,
}: {
  model: BoardModel;
  projectId: string;
  proposal: PlanProposal;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Row[]>(() => rowsOf(proposal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The places in the proposal of the added tasks whose contract is unfolded.
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const leadId = proposal.lead_session_id;

  // A task the proposal adds is named by its own title; any other by the board's.
  const taskTitle = (planId: string) =>
    model.tasks.find((task) => task.id === `${leadId}:${planId}`)?.title ??
    proposal.ops.flatMap((op) =>
      op.type === 'add_task' && op.task.id === planId ? [op.task.title] : [],
    )[0] ??
    planId;
  const nameOf = (op: PlanOp): string => {
    switch (op.type) {
      case 'add_task':
        return op.task.title;
      case 'set_milestone':
        return op.patch.title ?? op.milestone_id;
      case 'set_iterations':
        return listText(...op.iterations.map((i) => i.title));
      default:
        return taskTitle(op.task_id);
    }
  };

  const untitled = draft.some(({ op }) => op.type === 'add_task' && !op.task.title.trim());
  const retitle = (at: number, text: string) =>
    setDraft((now) =>
      now.map((row) =>
        row.at === at && row.op.type === 'add_task'
          ? { at, op: { ...row.op, task: { ...row.op.task, title: text } } }
          : row,
      ),
    );
  const acceptEdited = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await resolvePlanProposal(projectId, proposal, {
      decision: 'accept',
      ops: draft.map(({ op }) =>
        op.type === 'add_task' ? { ...op, task: { ...op.task, title: op.task.title.trim() } } : op,
      ),
    });
    // Once the daemon took it, the next board read takes the row away.
    if (failure === null) return;
    setBusy(false);
    setError(failure);
  };

  const drop = (row: Row) => (
    <button
      type="button"
      className="ib"
      aria-label={t(
        { id: 'board.plan.proposal.drop', defaultMessage: 'Remove change: {change}' },
        { change: nameOf(proposal.ops[row.at]!) },
      )}
      disabled={busy}
      onClick={() => setDraft((now) => now.filter((r) => r.at !== row.at))}
    >
      <X aria-hidden="true" />
    </button>
  );
  const sign = (change: 'remove' | 'add') => (
    <>
      <span className="bd-pp-sign" aria-hidden="true">
        {change === 'remove' ? '−' : '+'}
      </span>
      <span className="bd-vh">
        {change === 'remove'
          ? t({ id: 'board.plan.proposal.removes', defaultMessage: 'Removes' })
          : t({ id: 'board.plan.proposal.adds', defaultMessage: 'Adds' })}
      </span>
    </>
  );
  const line = (row: Row): ReactNode => {
    const { op } = row;
    if (op.type === 'remove_task')
      return (
        <li key={row.at} className="bd-pp-row" data-change="remove">
          {sign('remove')}
          <Clip className="bd-pp-nm" text={taskTitle(op.task_id)} />
          {drop(row)}
        </li>
      );
    if (op.type === 'add_task') {
      const type = op.task.task_type;
      const ups = op.task.depends_on;
      const open = unfolded.has(row.at);
      const Chevron = open ? ChevronDown : ChevronRight;
      return (
        <Fragment key={row.at}>
          <li className="bd-pp-row" data-change="add">
            {sign('add')}
            <input
              className="inp bd-pp-in"
              aria-label={t(
                {
                  id: 'board.plan.proposal.taskTitle',
                  defaultMessage: 'Title of the new task {title}',
                },
                { title: nameOf(proposal.ops[row.at]!) },
              )}
              aria-invalid={!op.task.title.trim() || undefined}
              maxLength={PLAN_TITLE_MAX}
              value={op.task.title}
              disabled={busy}
              onChange={(e) => retitle(row.at, e.target.value)}
            />
            {type && <span className="bd-pp-mu">{TASK_TYPE[type].label}</span>}
            {ups.length > 0 && (
              <span className="bd-pp-mu">
                {t(
                  { id: 'board.plan.proposal.dependsOn', defaultMessage: 'Depends on {tasks}' },
                  { tasks: listText(...ups.map(taskTitle)) },
                )}
              </span>
            )}
            <button
              type="button"
              className="ib"
              aria-expanded={open}
              aria-label={t(
                { id: 'board.plan.proposal.contract', defaultMessage: 'Contract of {title}' },
                { title: nameOf(proposal.ops[row.at]!) },
              )}
              onClick={() =>
                setUnfolded((now) => {
                  const next = new Set(now);
                  if (!next.delete(row.at)) next.add(row.at);
                  return next;
                })
              }
            >
              <Chevron aria-hidden="true" />
            </button>
            {drop(row)}
          </li>
          {open && (
            <li>
              <dl className="bd-pp-ct">
                {addedTaskFields(model, leadId, op.task).map(({ field, values }) => (
                  <Fragment key={field}>
                    <dt>{field}</dt>
                    <dd>
                      {values.map((value, i) => (
                        <div key={i}>{value}</div>
                      ))}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </li>
          )}
        </Fragment>
      );
    }
    return (
      <li key={row.at} className="bd-pp-row">
        <span className="bd-pp-sign" aria-hidden="true" />
        <Clip className="bd-pp-nm" text={nameOf(op)} />
        {changeList(opChanges(model, leadId, op))}
        {drop(row)}
      </li>
    );
  };

  return (
    <div className="bd-pp-card">
      <ul className="bd-pp-rows">{draft.map(line)}</ul>
      <div className="bd-pp-acts">
        <button
          type="button"
          className="btn sm pri"
          disabled={busy || draft.length === 0 || untitled}
          onClick={() => void acceptEdited()}
        >
          {t({ id: 'board.plan.proposal.acceptEdited', defaultMessage: 'Accept these changes' })}
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={onCancel}>
          {t({ id: 'board.plan.proposal.cancel', defaultMessage: 'Cancel' })}
        </button>
      </div>
      {error && (
        <p className="bd-perr" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
