import {
  useId,
  useMemo,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Menu } from '@base-ui/react/menu';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Ellipsis,
  Flag,
  GripVertical,
  Pencil,
  Plus,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { BoardModel } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { toast } from '../../components/Toast';
import { Tip } from '../../components/Tip';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { EvidenceMark } from './EvidenceMark';
import { milestoneCounts, milestoneFinished, type BoardMilestone } from './panels-model';
import { StatusIcon } from './status';
import './goals.css';

type Goal = BoardModel['goals'][number];

const MAX_GOALS = 7;
const SHOWN_MILESTONES = 6;

/** The goal being written: an existing one by id, or a new one. */
interface Draft {
  goalId: string | null;
  text: string;
  busy: boolean;
  error: string | null;
  /** Another window changed the goal since the draft began. */
  conflict: boolean;
}

/** The project's goals, each with its progress, what waits on the user and its milestones; the user writes, orders and archives them here. */
export function GoalsPage({
  model,
  projectId,
  bar,
  onOpenNeeds,
  onOpenNow,
}: {
  model: BoardModel;
  projectId: string;
  /** The board bar's element the Add goal button goes in, once it is in. */
  bar: HTMLElement | null;
  /** Shows the now view with the needs-you strip in focus. */
  onOpenNeeds: () => void;
  /** Shows the now view on the milestone, or on the current one for null. */
  onOpenNow: (milestoneId: string | null) => void;
}) {
  const id = useId();
  const goals = model.goals;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState<{ goalId: string; text: string } | null>(null);
  const [restoreFailed, setRestoreFailed] = useState<{ goal: Goal; text: string } | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<{ goalId: string; over: string | null } | null>(null);
  const byId = useMemo(() => new Map(model.milestones.map((m) => [m.id, m])), [model.milestones]);
  const loose = useMemo(() => {
    const linked = new Set(goals.flatMap((g) => g.milestone_ids));
    return model.milestones.filter((m) => !linked.has(m.id));
  }, [goals, model.milestones]);
  const full = goals.length >= MAX_GOALS;
  const adding = draft?.goalId === null;

  const write = (goal: Goal | null) => {
    setFailed(null);
    setRestoreFailed(null);
    setDraft({
      goalId: goal?.id ?? null,
      text: goal?.text ?? '',
      busy: false,
      error: null,
      conflict: false,
    });
  };
  const save = async (next: Draft) => {
    const text = next.text.trim();
    const goal = goals.find((g) => g.id === next.goalId);
    if (!text || (next.goalId !== null && !goal)) return;
    setDraft({ ...next, busy: true });
    const result = await runCommand(
      'goal.set',
      { project_id: projectId, ...(goal && { goal_id: goal.id }), text },
      goal ? goal.revision : null,
    );
    if (result.ok) return setDraft(null);
    setDraft({
      ...next,
      busy: false,
      error: failureText(result.error),
      conflict: !!goal && result.error.code === 'revision_conflict',
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') return setDraft(null);
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || !draft || draft.busy)
      return;
    e.preventDefault();
    void save(draft);
  };
  const reorder = async (goalId: string, ids: string[]) => {
    setFailed(null);
    const result = await runCommand('goal.reorder', { project_id: projectId, goal_ids: ids }, null);
    if (!result.ok) setFailed({ goalId, text: failureText(result.error) });
  };
  const move = (goal: Goal, by: -1 | 1) => {
    const ids = goals.map((g) => g.id);
    const at = ids.indexOf(goal.id);
    [ids[at], ids[at + by]] = [ids[at + by]!, ids[at]!];
    void reorder(goal.id, ids);
  };
  const drop = (target: Goal) => {
    setDrag(null);
    if (!drag || drag.goalId === target.id) return;
    const from = goals.findIndex((g) => g.id === drag.goalId);
    const to = goals.findIndex((g) => g.id === target.id);
    const ids = goals.map((g) => g.id).filter((goalId) => goalId !== drag.goalId);
    // Dragged down it lands after the goal it is dropped on, dragged up before it.
    ids.splice(ids.indexOf(target.id) + (from < to ? 1 : 0), 0, drag.goalId);
    void reorder(drag.goalId, ids);
  };
  const restore = async (goal: Goal, revision: number) => {
    const result = await runCommand('goal.restore', { goal_id: goal.id }, revision);
    setRestoreFailed(result.ok ? null : { goal, text: failureText(result.error) });
  };
  const archive = async (goal: Goal) => {
    setFailed(null);
    const result = await runCommand('goal.archive', { goal_id: goal.id }, goal.revision);
    if (!result.ok) return setFailed({ goalId: goal.id, text: failureText(result.error) });
    const revision = (result.value as { revision: number }).revision;
    toast({
      title: t(
        { id: 'board.goals.archived', defaultMessage: 'Archived “{goal}”' },
        { goal: goal.text },
      ),
      action: {
        label: t({ id: 'board.goals.undo', defaultMessage: 'Undo' }),
        run: () => void restore(goal, revision),
      },
    });
  };

  const alert = (message: string, errorId?: string) => (
    <p className="gm-err" id={errorId} role="alert">
      <TriangleAlert aria-hidden="true" />
      <span>{message}</span>
    </p>
  );

  const editor = (current: Draft, goal: Goal | undefined) => {
    const errorId = `${id}-err`;
    return (
      <>
        <textarea
          className="gm-in"
          rows={1}
          autoFocus
          aria-label={
            goal
              ? t({ id: 'board.goals.input', defaultMessage: 'Goal' })
              : t({ id: 'board.goals.new', defaultMessage: 'New goal' })
          }
          maxLength={280}
          value={current.text}
          readOnly={current.busy}
          aria-invalid={current.error ? true : undefined}
          aria-describedby={current.error ? errorId : undefined}
          onChange={(e) => setDraft({ ...current, text: e.target.value })}
          onKeyDown={onKey}
        />
        {current.error &&
          alert(
            current.conflict && goal
              ? t(
                  {
                    id: 'board.goals.conflict',
                    defaultMessage:
                      'Changed in another window while you edited. It now reads “{goal}”.',
                  },
                  { goal: goal.text },
                )
              : current.error,
            errorId,
          )}
        <div className="gm-acts">
          <button
            type="button"
            className="btn sm pri"
            disabled={current.busy || !current.text.trim()}
            aria-busy={current.busy || undefined}
            onClick={() => void save(current)}
          >
            {current.conflict
              ? t({ id: 'board.goals.saveMine', defaultMessage: 'Save mine' })
              : goal
                ? t({ id: 'board.goals.save', defaultMessage: 'Save' })
                : t({ id: 'board.goals.addSubmit', defaultMessage: 'Add' })}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setDraft(null)}>
            {current.conflict
              ? t({ id: 'board.goals.useTheirs', defaultMessage: 'Use theirs' })
              : t({ id: 'board.goals.cancel', defaultMessage: 'Cancel' })}
          </button>
        </div>
      </>
    );
  };

  const milestoneRow = (m: BoardMilestone) => {
    const { done, total } = milestoneCounts(m);
    const state =
      m.status === 'completed'
        ? t({ id: 'board.goals.milestone.done', defaultMessage: 'Done' })
        : m.status === 'ready_for_acceptance'
          ? t({ id: 'board.goals.milestone.ready', defaultMessage: 'To accept' })
          : m.status === 'stale'
            ? t({ id: 'board.milestones.stale', defaultMessage: 'Stale' })
            : t({ id: 'board.goals.milestone.active', defaultMessage: 'In progress' });
    return (
      <li key={m.id}>
        <button type="button" className="gm-ms" onClick={() => onOpenNow(m.id)}>
          <span className="gm-ms-g" role="img" aria-label={state}>
            {m.status === 'completed' ? (
              <StatusIcon status="done" />
            ) : m.status === 'ready_for_acceptance' ? (
              <StatusIcon status="ready" />
            ) : (
              <Flag aria-hidden="true" />
            )}
          </span>
          <Clip className="gm-ms-t" text={m.title} />
          <span className="gm-ms-s">
            {m.status === 'active' ? (
              <span
                className="gm-n"
                role="img"
                aria-label={t(
                  {
                    id: 'board.flow.milestone.done',
                    defaultMessage: '{done} of {total} tasks done',
                  },
                  { done, total },
                )}
              >
                {done} / {total}
              </span>
            ) : (
              <span aria-hidden="true">{state}</span>
            )}
          </span>
          <EvidenceMark level={m.evidence_level} />
        </button>
      </li>
    );
  };

  /** The milestones of a goal, or of no goal under the key '', the first six until the rest are shown. */
  const milestoneList = (key: string, milestones: BoardMilestone[]) => {
    const open = expanded.has(key);
    const shown = open ? milestones : milestones.slice(0, SHOWN_MILESTONES);
    return (
      milestones.length > 0 && (
        <>
          <ul className="gm-mss">{shown.map(milestoneRow)}</ul>
          {!open && milestones.length > SHOWN_MILESTONES && (
            <button
              type="button"
              className="gm-more"
              aria-expanded={false}
              onClick={() => setExpanded(new Set([...expanded, key]))}
            >
              {t(
                { id: 'board.goals.more', defaultMessage: '{count} more' },
                { count: milestones.length - SHOWN_MILESTONES },
              )}
            </button>
          )}
        </>
      )
    );
  };

  const progress = ({ milestones: { done, ready, total } }: Goal) => {
    if (!total)
      return (
        <p className="gm-none">
          {t({ id: 'board.goals.noMilestones', defaultMessage: 'No milestones' })}
        </p>
      );
    const open = total - done - ready;
    return (
      <div className="gm-gp">
        <span
          className="gm-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label={t(
            { id: 'board.goals.progress.label', defaultMessage: 'Milestones: {parts}' },
            {
              parts: listText(
                done > 0 &&
                  t(
                    { id: 'board.goals.progress.done', defaultMessage: '{count} done' },
                    { count: done },
                  ),
                ready > 0 &&
                  t(
                    { id: 'board.goals.progress.ready', defaultMessage: '{count} to accept' },
                    { count: ready },
                  ),
                open > 0 &&
                  t(
                    { id: 'board.goals.progress.open', defaultMessage: '{count} in progress' },
                    { count: open },
                  ),
              ),
            },
          )}
        >
          {done > 0 && <i data-part="done" style={{ flexGrow: done }} />}
          {ready > 0 && <i data-part="ready" style={{ flexGrow: ready }} />}
          {open > 0 && <i style={{ flexGrow: open }} />}
        </span>
        <span className="gm-n">
          {done} / {total}
        </span>
      </div>
    );
  };

  const goalRow = (goal: Goal, at: number) => {
    const headId = `${id}-${goal.id}`;
    const writing = draft?.goalId === goal.id ? draft : null;
    const next =
      goal.milestone_ids.map((mid) => byId.get(mid)).find((m) => m && !milestoneFinished(m)) ??
      null;
    return (
      <section
        key={goal.id}
        className="gm-goal"
        role="listitem"
        {...(writing ? { 'aria-label': goal.text } : { 'aria-labelledby': headId })}
        data-drag={drag?.goalId === goal.id || undefined}
        data-drop={
          drag && drag.over === goal.id && drag.goalId !== goal.id
            ? goals.findIndex((g) => g.id === drag.goalId) < at
              ? 'after'
              : 'before'
            : undefined
        }
        onDragOver={(e: DragEvent) => {
          if (!drag) return;
          e.preventDefault();
          if (drag.over !== goal.id) setDrag({ ...drag, over: goal.id });
        }}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          drop(goal);
        }}
      >
        <button
          type="button"
          className="gm-grip"
          draggable
          aria-label={t(
            { id: 'board.goals.reorder', defaultMessage: 'Reorder: {goal}' },
            { goal: goal.text },
          )}
          onDragStart={(e: DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', goal.id);
            setDrag({ goalId: goal.id, over: null });
          }}
          onDragEnd={() => setDrag(null)}
        >
          <GripVertical aria-hidden="true" />
        </button>
        {writing ? (
          editor(writing, goal)
        ) : (
          <div className="gm-gh">
            <h2 className="gm-gt" id={headId}>
              <button type="button" className="gm-gtb" onClick={() => write(goal)}>
                {goal.text}
              </button>
            </h2>
            <span className="gm-ga">
              <Menu.Root>
                <Menu.Trigger
                  className="ib gm-menu"
                  aria-label={t(
                    { id: 'board.goals.actions', defaultMessage: 'Goal actions: {goal}' },
                    { goal: goal.text },
                  )}
                >
                  <Ellipsis aria-hidden="true" />
                </Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
                    <Menu.Popup className="wmenu pop">
                      <Menu.Item className="gm-mi" onClick={() => write(goal)}>
                        <Pencil aria-hidden="true" />
                        {t({ id: 'board.goals.rename', defaultMessage: 'Rename' })}
                      </Menu.Item>
                      <Menu.Item
                        className="gm-mi"
                        disabled={at === 0}
                        onClick={() => move(goal, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                        {t({ id: 'board.goals.moveUp', defaultMessage: 'Move up' })}
                      </Menu.Item>
                      <Menu.Item
                        className="gm-mi"
                        disabled={at === goals.length - 1}
                        onClick={() => move(goal, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                        {t({ id: 'board.goals.moveDown', defaultMessage: 'Move down' })}
                      </Menu.Item>
                      <Menu.Separator className="wmenu-sep" />
                      <Menu.Item className="gm-mi" onClick={() => void archive(goal)}>
                        <Archive aria-hidden="true" />
                        {t({ id: 'board.goals.archive', defaultMessage: 'Archive' })}
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
              {goal.needs > 0 && (
                <button
                  type="button"
                  className="chip gm-need"
                  aria-label={t(
                    {
                      id: 'board.goals.needs.label',
                      defaultMessage:
                        '{count, plural, one {# decision waits on you for this goal} other {# decisions wait on you for this goal}}',
                    },
                    { count: goal.needs },
                  )}
                  onClick={onOpenNeeds}
                >
                  <span className="ss-dot waiting" aria-hidden="true" />
                  {t(
                    { id: 'board.goals.needs', defaultMessage: '{count} to decide' },
                    { count: goal.needs },
                  )}
                </button>
              )}
              <button
                type="button"
                className="btn sm ghost"
                aria-label={t(
                  { id: 'board.goals.openNow.label', defaultMessage: 'Open in Now: {goal}' },
                  { goal: goal.text },
                )}
                onClick={() => onOpenNow(next?.id ?? null)}
              >
                <Workflow aria-hidden="true" />
                {t({ id: 'board.goals.openNow', defaultMessage: 'Now' })}
              </button>
            </span>
          </div>
        )}
        {failed?.goalId === goal.id && alert(failed.text)}
        {progress(goal)}
        {milestoneList(
          goal.id,
          goal.milestone_ids.flatMap((mid) => byId.get(mid) ?? []),
        )}
      </section>
    );
  };

  const addLabel = t({ id: 'board.goals.add', defaultMessage: 'Add goal' });
  const fullText = t({
    id: 'board.goals.full',
    defaultMessage: 'A project has at most 7 goals. Archive one to add another.',
  });
  let barButton: ReactNode = null;
  if (bar && goals.length > 0)
    barButton = createPortal(
      full ? (
        <>
          <Tip content={fullText}>
            <button
              type="button"
              className="btn sm"
              aria-disabled={true}
              aria-describedby={`${id}-full`}
            >
              <Plus aria-hidden="true" />
              {addLabel}
            </button>
          </Tip>
          <span id={`${id}-full`} hidden>
            {fullText}
          </span>
        </>
      ) : (
        <button type="button" className="btn sm" aria-pressed={adding} onClick={() => write(null)}>
          <Plus aria-hidden="true" />
          {addLabel}
        </button>
      ),
      bar,
    );

  return (
    <div className="gm">
      {barButton}
      <div className="gm-col">
        {goals.length > 0 || adding ? (
          <div
            className="gm-list"
            role="list"
            aria-label={t({ id: 'board.goals.list', defaultMessage: 'Goals' })}
          >
            {goals.map(goalRow)}
            {restoreFailed && !goals.some((g) => g.id === restoreFailed.goal.id) && (
              <section className="gm-goal" role="listitem" aria-label={restoreFailed.goal.text}>
                <h2 className="gm-gt" data-off="">
                  {restoreFailed.goal.text}
                </h2>
                {alert(restoreFailed.text)}
              </section>
            )}
            {draft?.goalId === null && (
              <section
                className="gm-goal"
                role="listitem"
                aria-label={t({ id: 'board.goals.new', defaultMessage: 'New goal' })}
              >
                {editor(draft, undefined)}
              </section>
            )}
          </div>
        ) : (
          <div className="gm-empty">
            <p>
              {t({
                id: 'board.goals.empty',
                defaultMessage: 'Say in your own words what this project is for.',
              })}
            </p>
            <button type="button" className="btn pri" onClick={() => write(null)}>
              <Plus aria-hidden="true" />
              {addLabel}
            </button>
          </div>
        )}
        {loose.length > 0 && (
          <div className="gm-list" role="group" aria-labelledby={`${id}-none`}>
            <section className="gm-goal">
              <h2 className="gm-gt" id={`${id}-none`} data-off="">
                {t({ id: 'board.goals.noGoal', defaultMessage: 'No goal' })}
              </h2>
              {milestoneList('', loose)}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
