import type { GraphStatus } from '@pantheon/domain';
import type { ProjectPlanView } from '@pantheon/protocol';
import type { GraphSpec } from '../../components/visual/graph-layout';
import { t } from '../../i18n';
import { evidenceText } from './EvidenceMark';
import { planBucket, planStage, type PlanBucket, type ShownPlanItem } from './project-model';

type Plan = NonNullable<ProjectPlanView['plan']>;

// The colours of a milestone bar's parts; an item not started or abandoned stays neutral.
const BUCKET_STATUS: Partial<Record<PlanBucket, GraphStatus>> = {
  landed: 'done',
  active: 'running',
  needs_you: 'waiting',
  failed: 'failed',
};

/** An edge from a landed item is solid, one from an item still to land dashed. */
export const LANDED_EDGE = 'main';
export const PENDING_EDGE = 'async';

/** The legend's names of the two edge styles. */
export const flowEdgeNames = () => ({
  [LANDED_EDGE]: t({ id: 'project.flow.edge.landed', defaultMessage: 'Dependency landed' }),
  [PENDING_EDGE]: t({ id: 'project.flow.edge.pending', defaultMessage: 'Dependency not landed' }),
});

const milestoneGroup = (id: string) => `milestone:${id}`;
// Item ids are any string, so an item's node takes a prefix no milestone group has.
const ITEM = 'item:';
export const itemNode = (id: string) => ITEM + id;
/** The plan item a node of the graph stands for. */
export const nodeItem = (nodeId: string) =>
  nodeId.startsWith(ITEM) ? nodeId.slice(ITEM.length) : null;

/** Whether an item not dropped waits for another such item, the one case the graph is offered in. */
export function hasDependencies(plan: Plan | null | undefined): boolean {
  const shown = new Set(plan?.items.filter((item) => !item.dropped).map((item) => item.id));
  return !!plan?.items.some(
    (item) => !item.dropped && (item.depends_on ?? []).some((id) => shown.has(id)),
  );
}

/**
 * The plan as a graph: a node per item not dropped, in its milestone's group, and an edge from each
 * item to the items that wait for it; a dependency on a dropped or unknown item is left out.
 */
export function planFlow(plan: Plan): GraphSpec {
  const shown = plan.items.filter((item): item is ShownPlanItem => !item.dropped);
  const byId = new Map(shown.map((item) => [item.id, item]));
  const known = new Set(plan.milestones.map((m) => m.id));
  const grouped = (item: ShownPlanItem) =>
    item.milestone && known.has(item.milestone) ? item.milestone : undefined;
  return {
    direction: 'LR',
    groups: plan.milestones
      .filter((m) => shown.some((item) => grouped(item) === m.id))
      .map((m) => ({ id: milestoneGroup(m.id), label: m.title })),
    nodes: shown.map((item) => {
      const stage = planStage(item);
      const status = BUCKET_STATUS[planBucket(item)];
      const milestone = grouped(item);
      return {
        id: itemNode(item.id),
        label: item.title,
        ...(status && { status }),
        ...(milestone && { group: milestoneGroup(milestone) }),
        detail: [
          t(
            { id: 'project.flow.stage', defaultMessage: '{stage} {done}/5' },
            { stage: stage.name, done: stage.cells.filter((cell) => cell !== 'empty').length },
          ),
          ...(item.evidence ? [evidenceText(item.evidence)] : []),
          ...(item.failure ? [item.failure.reason] : []),
        ],
      };
    }),
    edges: shown.flatMap((item) =>
      (item.depends_on ?? []).flatMap((id) => {
        const upstream = byId.get(id);
        if (!upstream) return [];
        return [
          {
            from: itemNode(upstream.id),
            to: itemNode(item.id),
            style: upstream.stage === 'landed' ? LANDED_EDGE : PENDING_EDGE,
          },
        ];
      }),
    ),
  };
}
