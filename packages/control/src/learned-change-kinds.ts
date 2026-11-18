import { canonical, type Improvement, type Project } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { screenExperience } from './experience-screen.js';
import { setProjectWorktree, writeProjectGate } from './project.js';
import { applyPolicyChange, policyValue, workflowPolicy } from './workflow-policy.js';

type Change = Improvement['change'];
type Of<T extends Change['type']> = Extract<Change, { type: T }>;

interface ChangeKind<T extends Change['type']> {
  /** Puts the change in force; returns the value it replaced, or why it is refused. */
  apply(
    ctx: ControlContext,
    improvement: Improvement & { change: Of<T> },
    commandId: string,
    gitRoots: ReadonlySet<string>,
  ): { from?: unknown; refusal?: { status_reason: string; status_detail: string } };
  /** Puts the replaced value back; returns why the value stays instead when it is no longer current. */
  revert(
    ctx: ControlContext,
    improvement: Improvement & { change: Of<T> },
    commandId: string,
    gitRoots: ReadonlySet<string>,
  ): string | undefined;
  /** Whether the value in force is still the one the change set. */
  stillCurrent(ctx: ControlContext, improvement: Improvement & { change: Of<T> }): boolean;
  /** Whether both change the same thing, of which only one may wait or be on trial. */
  sameTarget(a: Of<T>, b: Of<T>): boolean;
}

const project = (ctx: ControlContext, improvement: Improvement) =>
  ctx.store.must<Project>('projects', improvement.project_id);

export const changeKinds: { [T in Change['type']]: ChangeKind<T> } = {
  policy_change: {
    apply: (ctx, improvement, commandId) => ({
      from: applyPolicyChange(
        ctx,
        improvement.project_id,
        improvement.change,
        { improvement_id: improvement.id },
        commandId,
      ),
    }),
    revert(ctx, improvement, commandId) {
      const change = improvement.change;
      if (!changeKinds.policy_change.stillCurrent(ctx, improvement))
        return `${change.param} was changed to ${canonical(policyValue(workflowPolicy(ctx, improvement.project_id), change))} since the trial started, so it stays`;
      applyPolicyChange(
        ctx,
        improvement.project_id,
        { param: change.param, tier: change.tier, to: change.from },
        { improvement_id: improvement.id },
        commandId,
      );
      return undefined;
    },
    stillCurrent: (ctx, improvement) =>
      canonical(policyValue(workflowPolicy(ctx, improvement.project_id), improvement.change)) ===
      canonical(improvement.change.to),
    sameTarget: (a, b) => a.param === b.param && a.tier === b.tier,
  },
  // An experience takes effect only by delivery, which follows its status.
  experience: {
    apply(ctx, improvement) {
      const refusal = screenExperience(project(ctx, improvement), improvement.change);
      return refusal ? { refusal } : {};
    },
    revert: () => undefined,
    stillCurrent: () => true,
    sameTarget: () => false,
  },
  gate_command: {
    apply(ctx, improvement, commandId, gitRoots) {
      const { root, to } = improvement.change,
        now = project(ctx, improvement);
      const from = now.gates?.[root];
      writeProjectGate(ctx, now, root, to, gitRoots, commandId);
      return { from };
    },
    revert(ctx, improvement, commandId, gitRoots) {
      const { root, from } = improvement.change;
      if (!changeKinds.gate_command.stillCurrent(ctx, improvement))
        return `The gate of ${root} was changed since the change was confirmed, so it stays`;
      writeProjectGate(ctx, project(ctx, improvement), root, from ?? [], gitRoots, commandId);
      return undefined;
    },
    // A root without commands has no key.
    stillCurrent: (ctx, improvement) =>
      canonical(project(ctx, improvement).gates?.[improvement.change.root] ?? []) ===
      canonical(improvement.change.to),
    sameTarget: (a, b) => a.root === b.root,
  },
  worktree_setup: {
    apply(ctx, improvement, commandId) {
      const now = project(ctx, improvement);
      setProjectWorktree(ctx, now, improvement.change.to!, commandId);
      return { from: now.worktree };
    },
    revert(ctx, improvement, commandId) {
      if (!changeKinds.worktree_setup.stillCurrent(ctx, improvement))
        return 'The worktree setup was changed since the change was confirmed, so it stays';
      // The user's own command cannot remove the setup either; an empty one prepares nothing.
      setProjectWorktree(
        ctx,
        project(ctx, improvement),
        improvement.change.from ?? { copy_paths: [] },
        commandId,
      );
      return undefined;
    },
    stillCurrent: (ctx, improvement) =>
      canonical(project(ctx, improvement).worktree) === canonical(improvement.change.to),
    sameTarget: () => true,
  },
};

/** The registry entry of the change's kind. */
export const changeKind = (change: Change) =>
  changeKinds[change.type] as ChangeKind<Change['type']>;
