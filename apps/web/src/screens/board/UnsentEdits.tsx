import { useState } from 'react';
import { Pencil, Plus, Route, X } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { ageText } from '../../data/needs-you';
import {
  draftTiming,
  removeDraftEdit,
  useDraftEdits,
  type DraftEdit,
  type DraftTiming,
} from '../../data/plan-draft';
import {
  clearPlanEdit,
  editPlan,
  opChanges,
  planVersion,
  useUnsentEdits,
  withdrawPlanEdit,
  type EditTarget,
  type EditTiming,
  type PlanOp,
  type UnsentEdit,
} from '../../data/plan-edit';
import { Tip } from '../../components/Tip';
import { currentLocale, t } from '../../i18n';
import { lastEditProgress, type EditStep } from './edit-progress';
import { changeList } from './PlanEdit';
import { EmptyState } from '../../components/EmptyState';
import './edits.css';

const STEP: Record<EditStep, () => string> = {
  sent: () => t({ id: 'board.edits.last.sent', defaultMessage: 'You sent' }),
  planned: () => t({ id: 'board.edits.last.planned', defaultMessage: 'In the plan' }),
  read: () => t({ id: 'board.edits.last.read', defaultMessage: 'Lead read' }),
  notified: () => t({ id: 'board.edits.last.notified', defaultMessage: 'Sessions got it' }),
};

/** How far the newest edit sent in the last day has got, one dot per step. */
function LastSent({ model }: { model: BoardModel }) {
  const steps = lastEditProgress(model.leads);
  if (!steps) return null;
  return (
    <div className="bd-ed-last">
      <span className="bd-ed-lh">
        {t({ id: 'board.edits.last.title', defaultMessage: 'Last sent' })}
      </span>
      <ol className="bd-ed-steps">
        {steps.map(({ step, at }) => {
          const time =
            at === null ? null : new Date(at).toLocaleString(currentLocale(), { hour12: false });
          return (
            <Tip key={step} content={time ?? ''} disabled={time === null}>
              <li data-reached={at !== null || undefined}>
                <i
                  role="img"
                  aria-label={
                    time === null
                      ? t({ id: 'board.edits.last.notYet', defaultMessage: 'Not yet' })
                      : t(
                          { id: 'board.edits.last.reached', defaultMessage: 'Reached {time}' },
                          { time },
                        )
                  }
                />
                <span>{STEP[step]()}</span>
              </li>
            </Tip>
          );
        })}
      </ol>
    </div>
  );
}

const TIMING: Record<EditTiming, () => string> = {
  now: () => t({ id: 'board.edits.timing.now', defaultMessage: 'Takes effect now' }),
  lead: () => t({ id: 'board.edits.timing.lead', defaultMessage: 'Once the lead decides' }),
};

const STATUS: Record<UnsentEdit['status'], { dot: string; text: () => string }> = {
  sending: {
    dot: 'wait',
    text: () => t({ id: 'board.edits.status.sending', defaultMessage: 'Sending' }),
  },
  conflict: {
    dot: 'chg',
    text: () => t({ id: 'board.plan.edit.conflict', defaultMessage: 'Plan updated' }),
  },
  failed: {
    dot: 'bad',
    text: () => t({ id: 'board.edits.status.failed', defaultMessage: 'Not sent' }),
  },
  pending: {
    dot: 'wait',
    text: () => t({ id: 'board.edits.status.pending', defaultMessage: 'Held' }),
  },
};

const DRAFT_TIMING: Record<DraftTiming, () => string> = {
  joins_plan: () =>
    t({ id: 'board.edits.draft.joinsPlan', defaultMessage: 'Joins the plan once sent' }),
  after_turn: TIMING.lead,
  now: () => t({ id: 'board.edits.draft.now', defaultMessage: 'Takes effect at once' }),
};

/** The title of the task an edit adds or changes. */
function editTitle(model: BoardModel, target: EditTarget, ops: readonly PlanOp[]) {
  const add = ops.find((op) => op.type === 'add_task');
  return (
    (add?.type === 'add_task' && add.task.title) ||
    model.tasks.find((task) => task.id === target.taskId)?.title ||
    target.planId
  );
}

/** One drafted change: the task, what it changes, when it takes effect and why it was not sent. */
function draftRow(model: BoardModel, draft: DraftEdit) {
  const { target, ops } = draft;
  const title = editTitle(model, target, ops);
  const Icon = ops.some((op) => op.type === 'add_task')
    ? Plus
    : ops.some((op) => op.type === 'set_dependencies' || op.type === 'move_task')
      ? Route
      : Pencil;
  return (
    <li key={draft.key} className="bd-ed-row">
      <div className="bd-bn-h">
        <Icon className="ic-sm bd-ed-ic" aria-hidden="true" />
        <span className="bd-ed-t">{title}</span>
        <span className="bd-ed-when">{DRAFT_TIMING[draftTiming(model, target.leadId, ops)]()}</span>
        <button
          type="button"
          className="ib"
          aria-label={t(
            { id: 'board.edits.draft.remove', defaultMessage: 'Remove {title}' },
            { title },
          )}
          onClick={() => removeDraftEdit(target.projectId, draft.key)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      {changeList(ops.flatMap((op) => opChanges(model, target.leadId, op)))}
      {draft.problem && <p className="bd-perr">{draft.problem}</p>}
    </li>
  );
}

/** Takes back a held edit, held while the request is out; a refusal shows above it. */
function Withdraw({ target, editId }: { target: EditTarget; editId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await withdrawPlanEdit(target, editId);
    setBusy(false);
    setError(failure);
  };
  return (
    <>
      {error && <p className="bd-perr">{error}</p>}
      <div className="bd-dacts">
        <button
          type="button"
          className="btn ghost"
          aria-label={t({ id: 'board.plan.edit.withdrawLabel', defaultMessage: 'Withdraw edit' })}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={() => void withdraw()}
        >
          {t({ id: 'board.plan.edit.withdraw', defaultMessage: 'Withdraw' })}
        </button>
      </div>
    </>
  );
}

/** One unsent edit: the task, what it changes, when it takes effect, and what can be done with it. */
function editRow(model: BoardModel, edit: UnsentEdit) {
  const { target, ops, status } = edit;
  const title = editTitle(model, target, ops);
  const version = planVersion(model, target.leadId);
  return (
    <li key={edit.key} className="bd-ed-row">
      <div className="bd-bn-h">
        <span className="bd-pchip" data-dot={STATUS[status].dot}>
          {STATUS[status].text()}
        </span>
        <span className="bd-ed-t">{title}</span>
        {edit.createdAt !== undefined && (
          <span className="bd-bn-at">{ageText(edit.createdAt, model.now)}</span>
        )}
        <span className="bd-ed-when">{TIMING[edit.timing]()}</span>
      </div>
      {changeList(ops.flatMap((op) => opChanges(model, target.leadId, op)))}
      {edit.text && <p className="bd-perr">{edit.text}</p>}
      {status === 'conflict' && (
        <div className="bd-dacts">
          <button
            type="button"
            className="btn pri"
            onClick={() => void editPlan(target, ops, version)}
          >
            {t(
              { id: 'board.plan.edit.retry', defaultMessage: 'Resend on v{version}' },
              { version },
            )}
          </button>
          <button type="button" className="btn" onClick={() => clearPlanEdit(target.taskId)}>
            {t({ id: 'board.plan.edit.discard', defaultMessage: 'Discard changes' })}
          </button>
        </div>
      )}
      {status === 'failed' && (
        <div className="bd-dacts">
          <button type="button" className="btn" onClick={() => clearPlanEdit(target.taskId)}>
            {t({ id: 'board.plan.edit.discard', defaultMessage: 'Discard changes' })}
          </button>
        </div>
      )}
      {status === 'pending' && edit.editId && <Withdraw target={target} editId={edit.editId} />}
    </li>
  );
}

/**
 * The project's drafted plan changes, sent or discarded together, and its sent edits that have not
 * taken effect, with their count.
 */
export function UnsentEdits({ model, projectId }: { model: BoardModel; projectId: string }) {
  const edits = useUnsentEdits(model, projectId);
  const drafts = useDraftEdits(projectId);
  const count = drafts.length + edits.length;
  const label = t({ id: 'board.edits.title', defaultMessage: 'Unsent changes' });
  return (
    <section className="bd-ed" aria-label={label}>
      <h2 className="bd-ed-h">
        {label}
        {count > 0 && <span className="bd-ed-n">{count}</span>}
      </h2>
      {drafts.length > 0 && (
        <ul className="bd-ed-list">{drafts.map((draft) => draftRow(model, draft))}</ul>
      )}
      {edits.length > 0 && (
        <ul className="bd-ed-list">{edits.map((edit) => editRow(model, edit))}</ul>
      )}
      {count === 0 && (
        <EmptyState
          inline
          title={t({ id: 'board.edits.none', defaultMessage: 'Nothing waiting' })}
        />
      )}
      <LastSent model={model} />
    </section>
  );
}
