import type { Session } from '@pantheon/domain';
import type { ProjectPlanView } from '@pantheon/protocol';
import { useBoard } from '../../data/board';
import { t } from '../../i18n';
import { useShell } from '../../store';

type Plan = NonNullable<ProjectPlanView['plan']>;
type Item = Plan['items'][number];

/** A milestone id, or '' for the items outside every milestone. */
type GroupKey = string;

/** The plan list's edits of one project, laid over the plan as it is now. */
export interface PlanDraft {
  /** Item id to the title typed for it. */
  titles: Record<string, string>;
  /** Item id to whether it is to be dropped. */
  dropped: Record<string, boolean>;
  /** The item ids of a group in the order wanted. */
  order: Record<GroupKey, string[]>;
  /** The items to add at the end of a group. */
  added: Record<GroupKey, { key: string; title: string }[]>;
}

export const EMPTY_DRAFT: PlanDraft = { titles: {}, dropped: {}, order: {}, added: {} };

/** write_plan's limits: characters in a title, items in a plan with the dropped ones. */
export const PLAN_TITLE_MAX = 120;
export const PLAN_ITEMS_MAX = 40;

/** The items the sent edits named, for the plan as it was and the main agent's turn they went to. */
export interface PlanPending {
  /** planContent of the plan the edits were made on. */
  content: string;
  sessionId: string;
  /** The turn_count the main agent has while the turn carrying the edits runs. */
  turn: number;
  items: string[];
  /** The titles sent as new items, by the group they go to the end of. */
  added: { group: GroupKey; title: string }[];
}

export interface EditRow {
  id: string;
  /** The title in the plan now. */
  was: string;
  title: string;
  dropped: boolean;
  /** The user accepted it and the plan keeps it, so it cannot be dropped. */
  kept: boolean;
  /** Renamed, dropped, restored or in another place. */
  changed: boolean;
}

export interface EditGroup {
  key: GroupKey;
  title: string;
  rows: EditRow[];
  added: { key: string; title: string }[];
}

function groupOf(plan: Plan, item: Item): GroupKey {
  return item.milestone && plan.milestones.some((m) => m.id === item.milestone)
    ? item.milestone
    : '';
}

const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const typedTitle = (draft: PlanDraft, item: Item) => own(draft.titles, item.id) ?? item.title;

/** Whether the title typed differs from the plan's; an empty one leaves the title as it is. */
const renamed = (draft: PlanDraft, item: Item) => {
  const title = typedTitle(draft, item).trim();
  return !!title && title !== item.title.trim();
};

/** An item the user accepted stays in the plan whatever the draft says. */
const isDropped = (draft: PlanDraft, item: Item) =>
  item.accepted && !item.dropped ? false : (own(draft.dropped, item.id) ?? !!item.dropped);

/**
 * Every milestone, then the items outside every milestone when there are any, new ones among them,
 * or no milestone; dropped items included.
 */
export function editGroups(plan: Plan, draft: PlanDraft): EditGroup[] {
  const groups = [
    ...plan.milestones.map((m) => ({ key: m.id, title: m.title })),
    { key: '', title: t({ id: 'project.plan.other', defaultMessage: 'Other' }) },
  ];
  return groups
    .map(({ key, title }) => {
      const items = plan.items.filter((item) => groupOf(plan, item) === key);
      const wanted = own(draft.order, key) ?? [];
      const ordered = [
        ...wanted.flatMap((id) => items.filter((item) => item.id === id)),
        ...items.filter((item) => !wanted.includes(item.id)),
      ];
      return {
        key,
        title,
        rows: ordered.map((item, k) => ({
          id: item.id,
          was: item.title,
          title: typedTitle(draft, item),
          dropped: isDropped(draft, item),
          kept: !!item.accepted && !item.dropped,
          changed:
            renamed(draft, item) ||
            isDropped(draft, item) !== !!item.dropped ||
            items[k]!.id !== item.id,
        })),
        added: own(draft.added, key) ?? [],
      };
    })
    .filter(
      (group) =>
        group.key !== '' ||
        group.rows.length > 0 ||
        group.added.length > 0 ||
        plan.milestones.length === 0,
    );
}

/** The draft with the row at `from` of a group moved to `to`. */
export function moveRow(group: EditGroup, draft: PlanDraft, from: number, to: number): PlanDraft {
  const ids = group.rows.map((row) => row.id);
  const [id] = ids.splice(from, 1);
  ids.splice(to, 0, id!);
  return { ...draft, order: { ...draft.order, [group.key]: ids } };
}

const quoted = (text: string) => JSON.stringify(text);

/** The edits as lines of a message to the main agent, the items they change and the titles they add. */
export function planEditLines(
  plan: Plan,
  draft: PlanDraft,
): { lines: string[]; items: string[]; added: PlanPending['added'] } {
  const lines: string[] = [];
  const items = new Set<string>();
  const added: PlanPending['added'] = [];
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const ref = (id: string) => `${id} ${quoted(byId.get(id)!.title)}`;
  for (const group of editGroups(plan, draft)) {
    for (const row of group.rows) {
      const item = byId.get(row.id)!;
      if (renamed(draft, item)) {
        lines.push(`rename ${ref(row.id)} -> ${quoted(row.title.trim())}`);
        items.add(row.id);
      }
      if (row.dropped !== !!item.dropped) {
        lines.push(`${row.dropped ? 'drop' : 'restore'} ${ref(row.id)}`);
        items.add(row.id);
      }
    }
    const was = plan.items.filter((item) => groupOf(plan, item) === group.key).map((i) => i.id);
    const now = group.rows.map((row) => row.id);
    const moved = now.filter((id, k) => was[k] !== id);
    if (moved.length > 0) {
      const name = group.key
        ? `milestone ${group.key} ${quoted(group.title)}`
        : 'outside every milestone';
      lines.push(`order ${name}: ${now.map(ref).join(', ')}`);
      moved.forEach((id) => items.add(id));
    }
    const where = group.key
      ? `to milestone ${group.key} ${quoted(group.title)}`
      : 'outside every milestone';
    let last = now.length > 0 ? ref(now[now.length - 1]!) : null;
    for (const add of group.added) {
      const title = add.title.trim();
      if (!title) continue;
      lines.push(`add ${quoted(title)} ${where}${last ? `, after ${last}` : ''}`);
      added.push({ group: group.key, title });
      last = quoted(title);
    }
  }
  return { lines, items: [...items], added };
}

// Prompts to models stay in English whatever the interface language is.
const MESSAGE_HEAD =
  "I edited your plan in the plan list. Apply these changes with write_plan, keeping every item's id and every item I accepted:";

export const planEditMessage = (lines: readonly string[]) => [MESSAGE_HEAD, ...lines].join('\n');

/** The plan as the main agent writes it, without the user's acceptances. */
export const planContent = (plan: Plan): string =>
  JSON.stringify({
    milestones: plan.milestones,
    items: plan.items.map(
      ({ id, title, milestone, depends_on, session_ids, named_at, acceptance, dropped }) => ({
        id,
        title,
        milestone,
        depends_on,
        session_ids,
        named_at,
        acceptance,
        dropped,
      }),
    ),
  });

/** Whether the main agent's turn carrying the edits ended. */
export const turnEnded = (pending: PlanPending, session: Session): boolean =>
  // A steer into the same turn adds to turn_count too, so the turn ends only once the session stops running.
  session.state !== 'running' && session.turn_count >= pending.turn;

/** Whether the main agent wrote the plan since the edits went to it, or the turn carrying them ended. */
export function pendingOver(pending: PlanPending, plan: Plan, session: Session): boolean {
  return turnEnded(pending, session) || planContent(plan) !== pending.content;
}

/** The edits sent to `session`, until the main agent writes the plan or the turn carrying them ends. */
export function livePending(
  pending: PlanPending | undefined,
  plan: Plan | null | undefined,
  session: Session | undefined,
): PlanPending | undefined {
  if (!pending || !plan || !session || session.id !== pending.sessionId) return undefined;
  return pendingOver(pending, plan, session) ? undefined : pending;
}

/** Forgets each project's sent edits once their turn ended, whatever is shown; returns the stop. */
export function watchPlanTurns(): () => void {
  return useBoard.subscribe((state) => {
    const sessions = state.board?.sessions ?? [];
    const pending = useShell.getState().planPending;
    const over = Object.keys(pending).filter((projectId) => {
      const session = sessions.find((s) => s.id === pending[projectId]!.sessionId);
      return !!session && turnEnded(pending[projectId]!, session);
    });
    if (over.length === 0) return;
    useShell.setState((s) => ({
      planPending: Object.fromEntries(
        Object.entries(s.planPending).filter(([projectId]) => !over.includes(projectId)),
      ),
    }));
  });
}
