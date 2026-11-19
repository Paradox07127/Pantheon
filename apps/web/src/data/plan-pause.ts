import { useProjectQuery, type ProjectRead } from './project-read';

type PlanView = ProjectRead['plans'][number];

/** The events after which a plan may be paused, resumed or reassessed. */
const PAUSE_KINDS: ReadonlySet<string> = new Set([
  'board.plan_paused',
  'board.plan_resumed',
  'board.plan_reassessed',
]);

const isProjectRead = (value: unknown): boolean =>
  Array.isArray((value as Partial<ProjectRead> | null)?.plans);

/** Whether the lead's plan is paused, and the lead's latest reassessment; read again only after a pause event. */
export function usePlanPause(
  projectId: string | null,
  leadId: string | null,
): Pick<PlanView, 'paused' | 'reassessment'> {
  const { read } = useProjectQuery<ProjectRead>(
    'project.read',
    projectId,
    isProjectRead,
    undefined,
    {
      kinds: PAUSE_KINDS,
    },
  );
  const plan = read?.plans.find((p) => p.lead_session_id === leadId);
  return { paused: plan?.paused, reassessment: plan?.reassessment };
}
