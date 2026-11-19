import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  hash,
  type AgentProfile,
  type EvalReceipt,
  type Improvement,
  type Project,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { screenExperience } from './experience-screen.js';
import { comparePairs, signTest } from './paired-stats.js';
import {
  leadPlaybook,
  playbookExportPath,
  playbookVersion,
  setPlaybookVersion,
  storedPlaybook,
} from './playbooks.js';
import { setProjectWorktree, writeProjectGate } from './project.js';
import { updateAgent } from './resident.js';
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

/** A line of an eval's runs.jsonl, the fields a receipt is checked by. */
interface EvalRun {
  task: string;
  condition: string;
  repetition: number;
  outcome: string;
  hidden_passed: boolean | null;
  input_tokens: number | null;
  /** The hash of the playbook sections the run's lead had; absent from runs of older evals. */
  playbook_sha256?: string | null;
}
/** The rule scripts/eval.mjs reports by; the rule.json beside a runs file is not part of its receipt. */
const EVAL_RULE = { alpha: 0.05, confidence: 0.95, bootstrap: { resamples: 10_000, seed: 1 } };

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
  agent_instructions: {
    apply(ctx, improvement, commandId) {
      const agent = ctx.store.must<AgentProfile>('agents', improvement.change.agent_id);
      updateAgent(ctx, agent, { instructions: improvement.change.to }, commandId);
      return { from: agent.instructions };
    },
    revert(ctx, improvement, commandId) {
      if (!changeKinds.agent_instructions.stillCurrent(ctx, improvement))
        return 'The agent instructions were changed since the change was confirmed, so they stay';
      updateAgent(
        ctx,
        ctx.store.must<AgentProfile>('agents', improvement.change.agent_id),
        { instructions: improvement.change.from },
        commandId,
      );
      return undefined;
    },
    stillCurrent: (ctx, improvement) =>
      ctx.store.must<AgentProfile>('agents', improvement.change.agent_id).instructions ===
      improvement.change.to,
    sameTarget: (a, b) => a.agent_id === b.agent_id,
  },
  // A playbook acts on a lead's plans, which no trial on live tasks compares, so a paired eval run decides.
  playbook: {
    apply(ctx, improvement, commandId) {
      const receipts = (improvement.evidence ?? []).filter(
        (entry): entry is EvalReceipt => entry.kind === 'eval_receipt',
      );
      const { runtime, to } = improvement.change;
      // The first condition must have run the playbook in force, the second the proposed version.
      const playbooks = [
        hash(leadPlaybook(ctx, improvement.project_id, runtime)),
        hash(storedPlaybook(ctx, improvement.project_id, runtime)?.versions[to]),
      ];
      // Why each receipt does not count; undefined for one that does.
      const reasons = receipts.map(({ path, sha256, verdict }) => {
        let runs: EvalRun[];
        try {
          const bytes = readFileSync(path);
          if (createHash('sha256').update(bytes).digest('hex') !== sha256)
            return `${path} changed since the eval run`;
          runs = bytes
            .toString('utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as EvalRun);
        } catch {
          return `${path} cannot be read as the runs of an eval`;
        }
        // The report orders the conditions as the runs first name them.
        const conditions = [...new Set(runs.map((run) => run.condition))];
        if (conditions.length !== 2)
          return `${path} holds the runs of ${conditions.length} conditions; a playbook eval compares two`;
        const [first, second] = conditions as [string, string];
        if (runs.some((run) => run.playbook_sha256 === undefined))
          return `${path} comes from an eval that did not record the playbook of each condition; run the eval again`;
        const other = runs.find(
          (run) => run.playbook_sha256 !== playbooks[run.condition === first ? 0 : 1],
        );
        if (other)
          return `${path}: ${other.condition} ran another playbook than ${other.condition === first ? 'the one in force' : `version ${to}`}`;
        // The verdicts of the eval report, from the same pairs by the same rule.
        const key = (run: EvalRun) => JSON.stringify([run.task, run.repetition]);
        const partners = new Map(
          runs.filter((run) => run.condition === second).map((run) => [key(run), run]),
        );
        const leaked = (run: EvalRun) => run.outcome === 'merged' && run.hidden_passed === false;
        const side = (run: EvalRun) => ({
          accepted: run.outcome === 'merged' && run.hidden_passed === true,
          cost: run.input_tokens,
        });
        const leakedOnlyUnder = { first: 0, second: 0 };
        const pairs = runs
          .filter((run) => run.condition === first)
          .flatMap((run) => {
            const partner = partners.get(key(run));
            if (!partner) return [];
            if (leaked(run) && !leaked(partner)) leakedOnlyUnder.first++;
            if (leaked(partner) && !leaked(run)) leakedOnlyUnder.second++;
            return [{ task: run.task, first: side(run), second: side(partner) }];
          });
        const { pass, cost } = comparePairs(pairs, EVAL_RULE);
        const named = { first, second };
        const shown = [
          signTest(leakedOnlyUnder.first, leakedOnlyUnder.second) < EVAL_RULE.alpha
            ? `${leakedOnlyUnder.first < leakedOnlyUnder.second ? first : second}_leaks_less`
            : 'no_conclusion',
          pass.verdict === 'no_conclusion' ? pass.verdict : `${named[pass.verdict]}_passes_more`,
          cost.verdict === 'no_conclusion' ? cost.verdict : `${named[cost.verdict]}_cheaper`,
        ];
        if (!shown.includes(verdict))
          return `The eval verdict ${verdict} is not what the runs in ${path} show: ${shown.join(', ')}`;
        if (verdict === 'no_conclusion') return `The eval in ${path} reached no conclusion`;
        return [`${second}_leaks_less`, `${second}_passes_more`, `${second}_cheaper`].includes(
          verdict,
        )
          ? undefined
          : `The eval verdict ${verdict} does not favour ${second}, the second condition`;
      });
      if (!reasons.includes(undefined))
        return {
          refusal: receipts.length
            ? { status_reason: 'eval_not_better', status_detail: reasons.join('; ') }
            : {
                status_reason: 'no_eval_receipt',
                status_detail:
                  'A playbook change needs an eval receipt whose verdict favours the second condition',
              },
        };
      const from = playbookVersion(ctx, improvement.project_id, runtime);
      setPlaybookVersion(ctx, improvement.project_id, runtime, to, commandId);
      return { from };
    },
    revert(ctx, improvement, commandId) {
      if (!changeKinds.playbook.stillCurrent(ctx, improvement))
        return 'The playbook version was changed since the change was confirmed, so it stays';
      const { runtime, from } = improvement.change;
      setPlaybookVersion(ctx, improvement.project_id, runtime, from!, commandId);
      return undefined;
    },
    stillCurrent: (ctx, improvement) =>
      playbookVersion(ctx, improvement.project_id, improvement.change.runtime) ===
      improvement.change.to,
    sameTarget: (a, b) => a.runtime === b.runtime,
  },
};

/** The checkout the package is built in, which holds scripts/eval.mjs and its frozen tasks. */
const BUILT_IN_CHECKOUT = fileURLToPath(new URL('../../../', import.meta.url));
const EVAL_REPETITIONS = 1;

/**
 * The paired eval that decides a playbook change: the version in force, then the proposed one,
 * each read from the file playbook.export writes; scripts/eval.mjs writes its runs to out.
 */
export function playbookEval(
  ctx: ControlContext,
  improvement: Pick<Improvement, 'id' | 'project_id'>,
  runtime: string | undefined,
  conditions: [number, number],
) {
  const checkout = ctx.appRoot ?? BUILT_IN_CHECKOUT;
  const out = path.join(path.dirname(ctx.files.directory), 'evals', improvement.id);
  const args = [
    'scripts/eval.mjs',
    'run',
    '--runtime',
    runtime === 'codex' ? 'codex' : 'claude',
    '--lead',
    'real',
    ...conditions.flatMap((version) => [
      '--condition',
      `playbook=file:${playbookExportPath(ctx, improvement.project_id, runtime, version)}`,
    ]),
    '--repetitions',
    String(EVAL_REPETITIONS),
    '--out',
    out,
  ];
  const tasks = path.join(checkout, 'tests/eval/tasks');
  const request: NonNullable<Improvement['eval_request']> = {
    conditions,
    runs: (existsSync(tasks) ? readdirSync(tasks).length : 0) * 2 * EVAL_REPETITIONS,
    command: ['node', ...args]
      .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`))
      .join(' '),
  };
  return { checkout, args, out, request };
}

/** The registry entry of the change's kind. */
export const changeKind = (change: Change) =>
  changeKinds[change.type] as ChangeKind<Change['type']>;
