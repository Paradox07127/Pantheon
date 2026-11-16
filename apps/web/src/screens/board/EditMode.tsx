import { useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Toolbar } from '@base-ui/react/toolbar';
import { Flag, Lock, LockOpen, Pencil, Plus, Route, Undo2 } from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import {
  addDraftEdit,
  discardDraftEdits,
  draftEdits,
  removeDraftEdit,
  sendDraftEdits,
  useDraftEdits,
  useDraftSending,
} from '../../data/plan-draft';
import { planVersion } from '../../data/plan-edit';
import { planTaskIds } from '../../data/task-trace';
import { t } from '../../i18n';
import { NewTaskForm, newTaskId, planLead } from './NewTask';
import { OrderLockedMark } from './status';
import './edit-mode.css';

// The projects whose board is in edit mode, kept for this window only.
const editing = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const boardEditing = (projectId: string) => editing.has(projectId);

export function setBoardEditing(projectId: string, on: boolean) {
  if (on === editing.has(projectId)) return;
  if (on) editing.add(projectId);
  else editing.delete(projectId);
  listeners.forEach((listener) => listener());
}

/** Whether the project's board is in edit mode. */
export function useBoardEditing(projectId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => boardEditing(projectId),
    () => boardEditing(projectId),
  );
}

export interface EditButtonProps {
  projectId: string;
  /** Set while the board read is out of date. */
  disabled: boolean;
  /** The project's drafted changes and sent edits not in effect yet. */
  count?: number;
}

/** The board bar's button that puts the project's board into edit mode. */
export function EditButton({ projectId, disabled, count = 0 }: EditButtonProps) {
  const edit = t({ id: 'board.editMode.edit', defaultMessage: 'Edit' });
  const label =
    count > 0
      ? t(
          {
            id: 'board.editMode.editCount',
            defaultMessage:
              '{count, plural, one {Edit, # unsent change} other {Edit, # unsent changes}}',
          },
          { count },
        )
      : edit;
  return (
    <button
      type="button"
      className="btn"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={() => setBoardEditing(projectId, true)}
    >
      <Pencil className="ic-sm" aria-hidden="true" />
      <span className="tb-lbl">{edit}</span>
      {count > 0 && <span className="bd-ed-n">{count}</span>}
    </button>
  );
}

interface DiscardDraftsProps {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}

function DiscardDrafts({ count, open, onOpenChange, onDiscard }: DiscardDraftsProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="pj-scrim" />
        <AlertDialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <AlertDialog.Title className="pj-dt">
              {t(
                {
                  id: 'board.editMode.discardTitle',
                  defaultMessage:
                    '{count, plural, one {Discard # change?} other {Discard # changes?}}',
                },
                { count },
              )}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="pj-rm-body">
            {t(
              {
                id: 'board.editMode.discardBody',
                defaultMessage:
                  "{count, plural, one {The change you have not sent will be lost. This can't be undone.} other {The # changes you have not sent will be lost. This can't be undone.}}",
              },
              { count },
            )}
          </AlertDialog.Description>
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <AlertDialog.Close className="btn">
              {t({ id: 'board.lead.tell.cancel', defaultMessage: 'Cancel' })}
            </AlertDialog.Close>
            <button type="button" className="btn dng" onClick={onDiscard}>
              {t({ id: 'board.edits.discard', defaultMessage: 'Discard' })}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export interface EditBarProps {
  model: BoardModel;
  projectId: string;
}

/**
 * The strip over the board in edit mode: the plan version the edits build on, when a running lead
 * reads them, and the project's drafted changes to discard or send.
 */
export function EditBar({ model, projectId }: EditBarProps) {
  const drafts = useDraftEdits(projectId);
  const sending = useDraftSending(projectId);
  const [confirming, setConfirming] = useState(false);
  const leadId = planLead(model);
  const running = model.leads?.find((l) => l.session_id === leadId)?.state === 'running';
  const failed = drafts.filter((d) => d.problem);
  const send = () => sendDraftEdits(model, projectId);
  return (
    <div className="bd-em-bar">
      <span className="chip">
        <Pencil aria-hidden="true" />
        {leadId
          ? t(
              { id: 'board.editMode.editing', defaultMessage: 'Editing, based on plan v{version}' },
              { version: planVersion(model, leadId) },
            )
          : t({ id: 'board.editMode.editingNoPlan', defaultMessage: 'Editing' })}
      </span>
      {running && (
        <span className="bd-em-note">
          {t({
            id: 'board.editMode.leadRunning',
            defaultMessage: 'The lead is running; it reads the changes you send when its turn ends',
          })}
        </span>
      )}
      <span className="bd-em-end">
        {failed.length > 0 && (
          <span className="bd-em-err" role="alert">
            {t(
              {
                id: 'board.editMode.notSent',
                defaultMessage:
                  '{count, plural, one {# change not sent: {reason}} other {# changes not sent: {reason}}}',
              },
              { count: failed.length, reason: failed[0]!.problem },
            )}
          </span>
        )}
        {drafts.length > 0 && (
          <>
            <button
              type="button"
              className="btn ghost"
              disabled={sending}
              onClick={() => setConfirming(true)}
            >
              {t({ id: 'board.edits.discard', defaultMessage: 'Discard' })}
            </button>
            <button
              type="button"
              className="btn pri"
              aria-busy={sending || undefined}
              disabled={sending}
              onClick={() => void send()}
            >
              {t(
                {
                  id: 'board.edits.send',
                  defaultMessage: '{count, plural, one {Send # change} other {Send # changes}}',
                },
                { count: drafts.length },
              )}
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={() => setBoardEditing(projectId, false)}>
          {t({ id: 'board.editMode.done', defaultMessage: 'Done' })}
        </button>
      </span>
      <DiscardDrafts
        count={drafts.length}
        open={confirming}
        onOpenChange={setConfirming}
        onDiscard={() => {
          discardDraftEdits(projectId);
          setConfirming(false);
        }}
      />
    </div>
  );
}

export interface EditToolbarProps {
  projectId: string;
  /** Whether dragging between tasks draws a dependency. */
  connecting: boolean;
  onTask: () => void;
  /** Absent, its button is off; so are the other optional actions'. */
  onMilestone?: () => void;
  onConnect?: () => void;
}

/** The tools floating over the canvas in edit mode; undo takes back the newest drafted change. */
export function EditToolbar({
  projectId,
  connecting,
  onTask,
  onMilestone,
  onConnect,
}: EditToolbarProps) {
  const drafts = useDraftEdits(projectId);
  const last = drafts.at(-1);
  return (
    <Toolbar.Root
      className="pop bd-em-tools"
      aria-label={t({ id: 'board.editMode.tools', defaultMessage: 'Editing tools' })}
    >
      <Toolbar.Button className="btn ghost sm" onClick={onTask}>
        <Plus className="ic-sm" aria-hidden="true" />
        {t({ id: 'board.editMode.tools.task', defaultMessage: 'Task' })}
      </Toolbar.Button>
      <Toolbar.Button className="btn ghost sm" disabled={!onMilestone} onClick={onMilestone}>
        <Flag className="ic-sm" aria-hidden="true" />
        {t({ id: 'board.editMode.tools.milestone', defaultMessage: 'Milestone' })}
      </Toolbar.Button>
      <Toolbar.Button
        className="btn ghost sm"
        aria-pressed={connecting}
        disabled={!onConnect}
        onClick={onConnect}
      >
        <Route className="ic-sm" aria-hidden="true" />
        {t({ id: 'board.editMode.tools.connect', defaultMessage: 'Connect' })}
      </Toolbar.Button>
      <Toolbar.Button
        className="btn ghost sm"
        disabled={!last}
        onClick={() => removeDraftEdit(projectId, last!.key)}
      >
        <Undo2 className="ic-sm" aria-hidden="true" />
        {t({ id: 'board.editMode.tools.undo', defaultMessage: 'Undo' })}
      </Toolbar.Button>
    </Toolbar.Root>
  );
}

export interface EditModeProps extends EditToolbarProps {
  /** Off, only the canvas shows, in the same elements, so it stays mounted across the switch. */
  on?: boolean;
  /** The task column beside the canvas, such as a DraftTaskForm. */
  side: ReactNode;
  /** The flow chart being edited. */
  children: ReactNode;
}

/** The board's body in edit mode: the canvas with the editing tools, and a task column. */
export function EditMode({ on = true, side, children, ...tools }: EditModeProps) {
  return (
    <div className={on ? 'bd-em' : 'bd-em-off'}>
      <section
        className="bd-em-canvas"
        aria-label={
          on ? t({ id: 'board.editMode.canvas', defaultMessage: 'Editable task flow' }) : undefined
        }
      >
        {children}
        {on && <EditToolbar {...tools} />}
      </section>
      {on && (
        <aside
          className="bd-em-side"
          aria-label={t({ id: 'board.editMode.side', defaultMessage: 'Task' })}
        >
          {side}
        </aside>
      )}
    </div>
  );
}

export interface OrderLockProps {
  model: BoardModel;
  projectId: string;
}

/**
 * The plan lead's tasks to pick for locking their relative order, which the lead and edits then
 * keep; a lock replaces the one before it and unlocking frees every task.
 */
export function OrderLock({ model, projectId }: OrderLockProps) {
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const leadId = planLead(model);
  const tasks = model.tasks
    .filter((task) => task.owner_session_id === leadId && task.order !== undefined)
    .sort((a, b) => a.order! - b.order!);
  if (!leadId || tasks.length < 2) return null;
  const send = async (
    op: { type: 'lock_order'; task_ids: string[] } | { type: 'unlock_order' },
  ) => {
    setSending(true);
    setFailure(null);
    const result = await runCommand(
      'board.plan.edit',
      {
        project_id: projectId,
        lead_session_id: leadId,
        base_version: planVersion(model, leadId),
        ops: [op],
      },
      null,
    );
    setSending(false);
    if (result.ok) setPicked([]);
    else setFailure(failureText(result.error));
  };
  const toggle = (id: string) =>
    setPicked((now) => (now.includes(id) ? now.filter((p) => p !== id) : [...now, id]));
  return (
    <section
      className="bd-em-lock"
      aria-label={t({ id: 'board.editMode.order', defaultMessage: 'Task order' })}
    >
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <label>
              <input
                type="checkbox"
                checked={picked.includes(task.id)}
                onChange={() => toggle(task.id)}
              />
              <span>{task.title}</span>
            </label>
            {task.order_locked && <OrderLockedMark />}
          </li>
        ))}
      </ul>
      <div className="bd-em-lockb">
        {tasks.some((task) => task.order_locked) && (
          <button
            type="button"
            className="btn sm"
            disabled={sending}
            onClick={() => void send({ type: 'unlock_order' })}
          >
            <LockOpen className="ic-sm" aria-hidden="true" />
            {t({ id: 'board.editMode.unlockOrder', defaultMessage: 'Unlock order' })}
          </button>
        )}
        <button
          type="button"
          className="btn sm"
          aria-busy={sending || undefined}
          disabled={sending || picked.length < 2}
          onClick={() =>
            void send({
              type: 'lock_order',
              task_ids: tasks
                .filter((task) => picked.includes(task.id))
                .map((task) => planTaskIds(task.id).task),
            })
          }
        >
          <Lock className="ic-sm" aria-hidden="true" />
          {t({ id: 'board.editMode.lockOrder', defaultMessage: 'Lock order' })}
        </button>
      </div>
      {failure && (
        <p className="bd-em-err" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

export interface DraftTaskFormProps {
  model: BoardModel;
  projectId: string;
  titleRef?: Ref<HTMLInputElement>;
}

/** The new task form of the task column: a task added there joins the draft, not the plan. */
export function DraftTaskForm({ model, projectId, titleRef }: DraftTaskFormProps) {
  const [made, setMade] = useState(0);
  const leadId = planLead(model);
  if (!leadId) return null;
  return (
    <NewTaskForm
      key={made}
      model={model}
      projectId={projectId}
      leadId={leadId}
      submitText={t({ id: 'board.editMode.addTask', defaultMessage: 'Add to changes' })}
      titleRef={titleRef}
      onSubmit={(made, start) => {
        // The form picks an id the plan does not hold; the tasks drafted before it need theirs too.
        const queued = draftEdits(projectId).flatMap((d) =>
          d.target.leadId === leadId
            ? d.ops.flatMap((o) => (o.type === 'add_task' ? [o.task.id] : []))
            : [],
        );
        const taken = new Set([
          ...queued,
          ...model.tasks
            .filter((task) => task.owner_session_id === leadId)
            .flatMap((task) => [planTaskIds(task.id).task, ...(task.depends_on ?? [])]),
        ]);
        const op = queued.includes(made.task.id)
          ? { ...made, task: { ...made.task, id: newTaskId(made.task.title, taken) } }
          : made;
        const id = op.task.id;
        addDraftEdit({ projectId, leadId, planId: id, taskId: `${leadId}:${id}` }, [op], start);
        setMade((n) => n + 1);
        return Promise.resolve(null);
      }}
    />
  );
}
