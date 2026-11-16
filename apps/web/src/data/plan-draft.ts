import { useSyncExternalStore } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { t } from '../i18n';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import {
  editTiming,
  planVersion,
  sendPlanEdit,
  type EditOutcome,
  type EditTarget,
  type PlanOp,
} from './plan-edit';

/**
 * When a drafted change takes effect once sent: an added task joins the plan; one the daemon holds
 * for an unfinished session waits for the lead; any other applies at once.
 */
export type DraftTiming = 'joins_plan' | 'after_turn' | 'now';

/** One change of a lead's plan kept in this window until the user sends or discards it. */
export interface DraftEdit {
  key: string;
  target: EditTarget;
  /** Sent together as one plan edit; empty once only the start is left to send. */
  ops: PlanOp[];
  /** Starts the target task once its ops took effect. */
  start: boolean;
  /** Why the last send left the change in the draft. */
  problem?: string;
}

export interface DraftResult {
  key: string;
  outcome: Exclude<EditOutcome, { kind: 'sending' }>;
}

const EMPTY: readonly DraftEdit[] = [];
// The drafts by project id, in memory like the outcomes of the edits sent from this window.
const drafts = new Map<string, readonly DraftEdit[]>();
const sending = new Set<string>();
const listeners = new Set<() => void>();
let made = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function write(projectId: string, next: readonly DraftEdit[]) {
  if (next.length) drafts.set(projectId, next);
  else drafts.delete(projectId);
  listeners.forEach((listener) => listener());
}

export const draftEdits = (projectId: string): readonly DraftEdit[] =>
  drafts.get(projectId) ?? EMPTY;

/** Whether the project's drafted changes are being sent. */
export const draftSending = (projectId: string): boolean => sending.has(projectId);

/** Adds a change to the end of its project's draft and returns its key. */
export function addDraftEdit(target: EditTarget, ops: PlanOp[], start = false): string {
  const key = `draft-${++made}`;
  write(target.projectId, [...draftEdits(target.projectId), { key, target, ops, start }]);
  return key;
}

/** Replaces the ops or the start of a drafted change; the reason of its last send goes. */
export function changeDraftEdit(
  projectId: string,
  key: string,
  change: Partial<Pick<DraftEdit, 'ops' | 'start'>>,
) {
  write(
    projectId,
    draftEdits(projectId).map((d) => {
      if (d.key !== key) return d;
      const { problem: _, ...kept } = d;
      return { ...kept, ...change };
    }),
  );
}

export const removeDraftEdit = (projectId: string, key: string) =>
  write(
    projectId,
    draftEdits(projectId).filter((d) => d.key !== key),
  );

export const discardDraftEdits = (projectId: string) => write(projectId, EMPTY);

export function draftTiming(
  model: Pick<BoardModel, 'tasks'>,
  leadId: string,
  ops: readonly PlanOp[],
): DraftTiming {
  if (ops.some((op) => op.type === 'add_task')) return 'joins_plan';
  return editTiming(model, leadId, ops) === 'lead' ? 'after_turn' : 'now';
}

/** Starts tasks of a lead's plan; resolves to why the daemon refused, or null. */
export async function startPlanTasks(
  target: Pick<EditTarget, 'projectId' | 'leadId'>,
  planIds: string[],
): Promise<string | null> {
  const result = await runCommand(
    'task.start',
    { project_id: target.projectId, lead_session_id: target.leadId, task_ids: planIds },
    null,
  );
  return result.ok ? null : failureText(result.error);
}

/**
 * Sends the project's drafted changes in order, each as the draft holds it when its turn comes; one
 * that took effect or waits for the lead leaves the draft, any other stays with the reason.
 */
export async function sendDraftEdits(
  model: Pick<BoardModel, 'leads'>,
  projectId: string,
): Promise<DraftResult[]> {
  if (sending.has(projectId)) return [];
  sending.add(projectId);
  listeners.forEach((listener) => listener());
  try {
    return await sendEach(model, projectId);
  } finally {
    sending.delete(projectId);
    listeners.forEach((listener) => listener());
  }
}

async function sendEach(
  model: Pick<BoardModel, 'leads'>,
  projectId: string,
): Promise<DraftResult[]> {
  const bases = new Map<string, number>();
  const results: DraftResult[] = [];
  for (const { key } of draftEdits(projectId)) {
    const draft = draftEdits(projectId).find((d) => d.key === key);
    if (!draft) continue;
    const { target, ops, start } = draft;
    const base = bases.get(target.leadId) ?? planVersion(model, target.leadId);
    let outcome: DraftResult['outcome'] = ops.length
      ? await sendPlanEdit(target, ops, base)
      : { kind: 'applied' };
    // An applied edit moves its plan to the version its answer names; a held one leaves it.
    bases.set(
      target.leadId,
      outcome.kind === 'applied' && ops.length ? (outcome.version ?? base + 1) : base,
    );
    let left: Partial<DraftEdit> | null = null;
    if (outcome.kind === 'conflict')
      left = { problem: t({ id: 'board.plan.edit.conflict', defaultMessage: 'Plan updated' }) };
    else if (outcome.kind === 'failed') left = { problem: outcome.text };
    else if (outcome.kind === 'applied' && start) {
      const why = await startPlanTasks(target, [target.planId]);
      if (why) {
        outcome = { kind: 'failed', text: why };
        left = { ops: [], problem: why };
      }
    }
    // A change edited meanwhile stays whole: its ops set complete values, so sending it again is safe.
    write(
      projectId,
      draftEdits(projectId).flatMap((d) => (d !== draft ? [d] : left ? [{ ...d, ...left }] : [])),
    );
    results.push({ key: draft.key, outcome });
  }
  return results;
}

/** Whether the project's drafted changes are being sent, kept current. */
export function useDraftSending(projectId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => draftSending(projectId),
    () => draftSending(projectId),
  );
}

/** The project's drafted changes, kept current with every change of the draft. */
export function useDraftEdits(projectId: string): readonly DraftEdit[] {
  return useSyncExternalStore(
    subscribe,
    () => draftEdits(projectId),
    () => draftEdits(projectId),
  );
}
