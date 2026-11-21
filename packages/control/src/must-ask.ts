import type { Approval, CharterPower, Project, Session, Workspace } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { SHELL_TOOLS } from './handoff.js';
import { outsideWorktree, writesFiles } from './non-writer-audit.js';
import { workflowPolicy } from './workflow-policy.js';

/** The decisions that always reach the user, whatever the charter says; the user may add entries but not remove these. */
export const MUST_ASK_KINDS = [
  'destructive_git',
  'agent_change',
  'external_start',
  'over_budget',
  'outside_sandbox',
] as const;

export type MustAskKind = (typeof MUST_ASK_KINDS)[number];

const POWER_KINDS: Partial<Record<CharterPower, MustAskKind>> = {
  create_agent: 'agent_change',
  start_external: 'external_start',
};

// Each pattern is tried on one git invocation of a shell command, after its `git`.
const DESTRUCTIVE_GIT = [
  /\bpush\b.*\s(--force(-with-lease)?|-[a-zA-Z]*f[a-zA-Z]*)(?=[\s=]|$)/,
  /\bpush\b.*\s\+\S/,
  /\bpush\b.*[\s:/](main|master)(\s|$)/,
  /\breset\b.*\s--hard\b/,
  /\bbranch\b.*\s-[a-zA-Z]*D/,
  /\bclean\b.*\s(--force|-[a-zA-Z]*f[a-zA-Z]*)(?=\s|$)/,
];
const NETWORK_TOOL = /^(webfetch|websearch|fetch)$/;
const CREDENTIAL_TOOL = /credential|secret|password|keychain|apikey/;

/** The commands of a shell prompt: its input summary and the text of its rule. */
function shellCommands(approval: Approval): string[] {
  if (!SHELL_TOOLS.has(approval.tool ?? '')) return [];
  const ruled = approval.rule?.match(/^[^(]+\((.*)\)$/s)?.[1];
  return [approval.input_summary, ruled].filter((text): text is string => !!text);
}

/** The simple commands of a shell command line, split at chaining, pipes and substitution. */
const segments = (command: string) =>
  command
    .split(/[;&|\n`]|\$\(/)
    .map((part) => part.trim())
    .filter(Boolean);

function destructiveGit(command: string): boolean {
  return segments(command).some((segment) => {
    const git = segment.match(/(?:^|[\s/])git\s(.*)$/)?.[1];
    return git !== undefined && DESTRUCTIVE_GIT.some((pattern) => pattern.test(git));
  });
}

/** The file fields an approval's input summary lists as key=value pairs. */
function summaryFields(summary: string): Record<string, unknown> {
  return Object.fromEntries(
    [...summary.matchAll(/(?:^|, )(file_path|path|filePath|notebook_path)=(.*?)(?=, \w+=|$)/g)].map(
      (match) => [match[1], match[2]],
    ),
  );
}

/** The folders the approval's session may write: its linked worktree, or the project roots. */
function writableRoots(ctx: ControlContext, projectId: string, approval: Approval): string[] {
  const session = approval.session_id
    ? ctx.store.get<Session>('sessions', approval.session_id)
    : undefined;
  const workspace = session?.workspace_id
    ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
    : undefined;
  return workspace?.kind === 'linked_worktree'
    ? [workspace.path]
    : ctx.store.must<Project>('projects', projectId).roots;
}

function leavesSandbox(ctx: ControlContext, projectId: string, approval: Approval): boolean {
  const tool = approval.tool ?? '';
  const name = tool
    .split(/__|[.:/]/)
    .at(-1)!
    .replace(/[_-]/g, '')
    .toLowerCase();
  if (NETWORK_TOOL.test(name) || CREDENTIAL_TOOL.test(name)) return true;
  if (!writesFiles(tool) || !approval.input_summary) return false;
  const fields = summaryFields(approval.input_summary);
  return writableRoots(ctx, projectId, approval).every(
    (root) => outsideWorktree(root, fields) !== undefined,
  );
}

/** Whether the prompt matches a permission rule the user added: the tool, or Tool(prefix) of a shell command. */
function userEntry(entry: string, approval: Approval): boolean {
  if (entry === approval.rule || entry === approval.tool) return true;
  const [, tool, prefix] = entry.match(/^([^(]+)\((.*)\)$/s) ?? [];
  if (tool !== approval.tool || !prefix) return false;
  return shellCommands(approval).some((command) =>
    segments(command).some((segment) => segment === prefix || segment.startsWith(`${prefix} `)),
  );
}

/** Whether the prompt or the use of the power must go to the user, whatever the charter says. */
export function mustAsk(
  ctx: ControlContext,
  projectId: string,
  subject: Approval | CharterPower,
): boolean {
  if (typeof subject === 'string') return POWER_KINDS[subject] !== undefined;
  return (
    shellCommands(subject).some(destructiveGit) ||
    leavesSandbox(ctx, projectId, subject) ||
    (workflowPolicy(ctx, projectId).must_ask_extra ?? []).some((entry) => userEntry(entry, subject))
  );
}
