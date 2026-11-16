import { COMMANDS, EDITS, READS, subagentCall } from '../../data/tool-calls';
import type { ToolItem, TurnView } from '../../data/transcript';

export type ToolKind = 'read' | 'edit' | 'run' | 'other';

const KINDS: readonly ToolKind[] = ['read', 'edit', 'run', 'other'];

const kindOf = (name: string): ToolKind =>
  READS.includes(name)
    ? 'read'
    : EDITS.includes(name)
      ? 'edit'
      : COMMANDS.includes(name)
        ? 'run'
        : 'other';

/** The turns' tool calls by kind, in the order read, edit, run, other; kinds without a call left out. */
export function toolTally(
  turns: readonly Pick<TurnView, 'items'>[],
): { kind: ToolKind; count: number }[] {
  const counts = new Map<ToolKind, number>();
  for (const turn of turns)
    for (const item of turn.items)
      if (item.kind === 'tool')
        counts.set(kindOf(item.name), (counts.get(kindOf(item.name)) ?? 0) + 1);
  return KINDS.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count }] : [];
  });
}

/** The subagents the turns dispatched, the same calls the thread shows as a fan, with whether their turn ended. */
export function dispatchedAgents(
  turns: readonly Pick<TurnView, 'items' | 'end' | 'turn'>[],
): { agent: ToolItem; ended: boolean }[] {
  return turns.flatMap((view) => {
    const ended =
      view.end !== null || (view.turn.state !== 'running' && view.turn.state !== 'queued');
    return view.items.flatMap((item) =>
      item.kind === 'tool' && !item.parent && subagentCall(item.name, item.input)
        ? [{ agent: item, ended }]
        : [],
    );
  });
}

/** A folder's name and the folder holding it, the home folder written as ~. */
export function folderParts(path: string, home: string | null): { name: string; parent: string } {
  const trimmed = path.replace(/\/+$/, '') || '/';
  const at = trimmed.lastIndexOf('/');
  const parent = at > 0 ? trimmed.slice(0, at) : '/';
  const root = home?.replace(/\/+$/, '');
  return {
    name: trimmed.slice(at + 1) || trimmed,
    parent:
      root && (parent === root || parent.startsWith(`${root}/`))
        ? `~${parent.slice(root.length)}`
        : parent,
  };
}

/** The steps of the main agent's newest TodoWrite, the plan the session bar shows; null without one. */
export function planSteps(
  turns: readonly Pick<TurnView, 'items'>[],
): { status: 'completed' | 'in_progress' | 'pending'; title: string }[] | null {
  const call = turns
    .flatMap((t) => t.items)
    .findLast((i) => i.kind === 'tool' && i.name === 'TodoWrite' && !i.parent);
  const todos = call?.kind === 'tool' ? (call.input as { todos?: unknown } | null)?.todos : null;
  if (!Array.isArray(todos) || todos.length === 0) return null;
  return todos.map((todo) => {
    const { status, content } = (todo ?? {}) as { status?: unknown; content?: unknown };
    return {
      status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      title: typeof content === 'string' ? content : '',
    };
  });
}
