import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import type { ProjectPlanView, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { tellState } from '../changes/tell-model';
import {
  EMPTY_DRAFT,
  editGroups,
  livePending,
  moveRow,
  PLAN_ITEMS_MAX,
  PLAN_TITLE_MAX,
  planContent,
  planEditLines,
  planEditMessage,
  type PlanDraft,
} from './plan-edit';

/** Puts the project's plan list in edit with the draft, or back to reading for null. */
export function setPlanDraft(projectId: string, draft: PlanDraft | null) {
  const { [projectId]: _before, ...rest } = useShell.getState().planDrafts;
  useShell.setState({ planDrafts: draft ? { ...rest, [projectId]: draft } : rest });
}

export const startPlanEdit = (projectId: string) => setPlanDraft(projectId, EMPTY_DRAFT);

function setPlanSending(projectId: string, sending: boolean) {
  const { [projectId]: _before, ...rest } = useShell.getState().planSending;
  useShell.setState({ planSending: sending ? { ...rest, [projectId]: true } : rest });
}

function setPlanError(projectId: string, error: string | null) {
  const { [projectId]: _before, ...rest } = useShell.getState().planErrors;
  useShell.setState({ planErrors: error ? { ...rest, [projectId]: error } : rest });
}

const editedMark = () => (
  <i
    className="pj-mk"
    role="img"
    aria-label={t({ id: 'project.plan.edit.edited', defaultMessage: 'Edited' })}
  />
);

/**
 * The plan list in edit: titles, drops, order within a milestone and new items; the edits go to
 * the main agent as one message, sent while it is idle and steered into its running turn.
 */
export function PlanEditor({
  plan,
  projectId,
  main,
  draft,
}: {
  plan: NonNullable<ProjectPlanView['plan']>;
  projectId: string;
  main: WorkbenchSession;
  draft: PlanDraft;
}) {
  const target = useBoard((s) => s.board?.sessions.find((x) => x.id === main.id));
  const busy = useShell((s) => !!s.planSending[projectId]);
  const error = useShell((s) => s.planErrors[projectId]);
  // Additions sent to any main agent count against the cap until they are written or their turn ends.
  const sentTo = useShell((s) => s.planPending[projectId]?.sessionId);
  const recipient = useBoard((s) => s.board?.sessions.find((x) => x.id === sentTo));
  const sentAdds = useShell(
    (s) => livePending(s.planPending[projectId], plan, recipient)?.added.length ?? 0,
  );
  const state = tellState(target);
  const groups = editGroups(plan, draft);
  const { lines, items, added } = planEditLines(plan, draft);
  const full =
    plan.items.length + sentAdds + groups.reduce((n, group) => n + group.added.length, 0) >=
    PLAN_ITEMS_MAX;
  const change = (next: PlanDraft) => setPlanDraft(projectId, next);
  const send = async () => {
    if (useShell.getState().planSending[projectId]) return;
    if (lines.length === 0 || !target || !state.enabled) return;
    if (plan.items.length + sentAdds + added.length > PLAN_ITEMS_MAX) {
      setPlanError(
        projectId,
        t(
          { id: 'project.plan.edit.full', defaultMessage: 'A plan holds at most {max} items' },
          { max: PLAN_ITEMS_MAX },
        ),
      );
      return;
    }
    const sent = draft;
    setPlanSending(projectId, true);
    setPlanError(projectId, null);
    const result = await runCommand(
      state.type,
      { session_id: target.id, input: planEditMessage(lines) },
      target.revision,
    );
    setPlanSending(projectId, false);
    if (!result.ok) {
      setPlanError(projectId, failureText(result.error));
      return;
    }
    // The daemon adds one to turn_count for a send and for a steer alike.
    const turn = target.turn_count + 1;
    useShell.setState((s) => {
      const before = livePending(s.planPending[projectId], plan, target);
      return {
        planPending: {
          ...s.planPending,
          [projectId]: {
            content: planContent(plan),
            sessionId: target.id,
            turn,
            items: [...new Set([...(before?.items ?? []), ...items])],
            added: [...(before?.added ?? []), ...added],
          },
        },
      };
    });
    if (useShell.getState().planDrafts[projectId] === sent) setPlanDraft(projectId, null);
  };
  const title = t({ id: 'project.plan.title', defaultMessage: 'Plan' });
  const sendName = t({ id: 'project.plan.edit.send', defaultMessage: 'Send to main agent' });
  const sendButton = (
    <button
      type="button"
      className="btn pri sm"
      aria-busy={busy || undefined}
      disabled={busy || lines.length === 0}
      aria-disabled={!state.enabled || undefined}
      onClick={() => void send()}
    >
      {sendName}
    </button>
  );
  return (
    <section className="pj-list" aria-label={title}>
      <div className="pj-lh">
        <h2 className="pj-h2">{title}</h2>
        <button
          type="button"
          className="btn ghost sm pj-end"
          disabled={busy}
          onClick={() => {
            setPlanError(projectId, null);
            setPlanDraft(projectId, null);
          }}
        >
          {t({ id: 'project.plan.edit.discard', defaultMessage: 'Discard' })}
        </button>
        {state.reason ? <Tip content={state.reason}>{sendButton}</Tip> : sendButton}
      </div>
      {error && (
        <div className="pj-cerr pj-pe-err" role="alert">
          {error}
        </div>
      )}
      {groups.map((group) => (
        <div key={group.key} role="group" aria-label={group.title}>
          <div className="pj-mh">
            <h3 className="pj-mt">
              <Clip text={group.title} />
            </h3>
          </div>
          <ul className="pj-rows">
            {group.rows.map((row, k) => (
              <li key={row.id} className="pj-pe" data-dropped={row.dropped || undefined}>
                <input
                  className="inp pj-pe-t"
                  aria-label={t(
                    { id: 'project.plan.edit.itemTitle', defaultMessage: 'Title of {title}' },
                    { title: row.was },
                  )}
                  value={row.title}
                  maxLength={PLAN_TITLE_MAX}
                  readOnly={busy}
                  onChange={(e) =>
                    change({ ...draft, titles: { ...draft.titles, [row.id]: e.target.value } })
                  }
                />
                <button
                  type="button"
                  className="ib"
                  aria-label={t({ id: 'project.plan.edit.up', defaultMessage: 'Move up' })}
                  disabled={busy || k === 0}
                  onClick={() => change(moveRow(group, draft, k, k - 1))}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="ib"
                  aria-label={t({ id: 'project.plan.edit.down', defaultMessage: 'Move down' })}
                  disabled={busy || k === group.rows.length - 1}
                  onClick={() => change(moveRow(group, draft, k, k + 1))}
                >
                  <ArrowDown aria-hidden="true" />
                </button>
                {row.kept ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() =>
                      change({ ...draft, dropped: { ...draft.dropped, [row.id]: !row.dropped } })
                    }
                  >
                    {row.dropped
                      ? t({ id: 'project.plan.edit.restore', defaultMessage: 'Restore' })
                      : t({ id: 'project.plan.edit.drop', defaultMessage: 'Drop' })}
                  </button>
                )}
                {row.changed && editedMark()}
              </li>
            ))}
            {group.added.map((add) => {
              const others = group.added.filter((other) => other.key !== add.key);
              const setAdded = (next: PlanDraft['added'][string]) =>
                change({ ...draft, added: { ...draft.added, [group.key]: next } });
              return (
                <li key={add.key} className="pj-pe">
                  <input
                    className="inp pj-pe-t"
                    aria-label={t(
                      { id: 'project.plan.edit.newTitle', defaultMessage: 'New item in {group}' },
                      { group: group.title },
                    )}
                    value={add.title}
                    maxLength={PLAN_TITLE_MAX}
                    readOnly={busy}
                    onChange={(e) =>
                      setAdded(
                        group.added.map((other) =>
                          other.key === add.key ? { ...other, title: e.target.value } : other,
                        ),
                      )
                    }
                  />
                  <span />
                  <span />
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => setAdded(others)}
                  >
                    {t({ id: 'project.plan.edit.remove', defaultMessage: 'Remove' })}
                  </button>
                  {editedMark()}
                </li>
              );
            })}
          </ul>
          <div className="pj-pe-add">
            <button
              type="button"
              className="btn ghost sm"
              aria-label={t(
                { id: 'project.plan.edit.addTo', defaultMessage: 'Add an item to {group}' },
                { group: group.title },
              )}
              disabled={busy || full}
              onClick={() =>
                change({
                  ...draft,
                  added: {
                    ...draft.added,
                    [group.key]: [...group.added, { key: crypto.randomUUID(), title: '' }],
                  },
                })
              }
            >
              <Plus aria-hidden="true" />
              {t({ id: 'project.plan.edit.add', defaultMessage: 'Add item' })}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
