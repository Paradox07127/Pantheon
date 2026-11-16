import type { CommandType } from '@pantheon/protocol';
import type { ProjectBrief } from '../../data/project-read';
import { t } from '../../i18n';

/** A command ready to send, or the reasons it cannot be sent yet. */
export type Request =
  | {
      ok: true;
      type: CommandType;
      input: Record<string, unknown>;
      expected_revision: number | null;
    }
  | { ok: false; errors: string[] };

export interface Availability {
  enabled: boolean;
  reason: string | null;
}

/** One entry per non-empty line, trimmed. */
export function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export interface BriefDraft {
  goal: string;
  goals: string;
  non_goals: string;
}

/** project.brief.set against the brief the page shows; null revision creates the first one. */
export function briefRequest(
  project_id: string,
  brief: ProjectBrief | undefined,
  draft: BriefDraft,
): Request {
  const goal = draft.goal.trim();
  if (!goal)
    return {
      ok: false,
      errors: [t({ id: 'projects.brief.goalRequired', defaultMessage: 'Goal is required' })],
    };
  const next = { goal, goals: lines(draft.goals), non_goals: lines(draft.non_goals) };
  if (
    brief &&
    brief.goal === next.goal &&
    same(brief.goals, next.goals) &&
    same(brief.non_goals, next.non_goals)
  )
    return {
      ok: false,
      errors: [t({ id: 'projects.brief.unchanged', defaultMessage: 'No changes' })],
    };
  return {
    ok: true,
    type: 'project.brief.set',
    input: { project_id, ...next },
    expected_revision: brief?.revision ?? null,
  };
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
