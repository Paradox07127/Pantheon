import type {
  AgentProposal,
  Approval,
  BoardPlan,
  Milestone,
  Principal,
  Session,
} from '@pantheon/domain';
import {
  inputSchemas,
  type ProjectBriefItem,
  type ProjectBriefProse,
  type ProjectBriefRef,
} from '@pantheon/protocol';
import { readAppSettings } from './app-settings.js';
import { userOnly, type ControlContext, type Handlers } from './context.js';
import { briefItemsKey, cursorId, projectBrief, type SeenCursor } from './project-brief.js';
import { projectOverBudget } from './workflow-policy.js';

/** One brief item as the side model reads it, under the key its sentences cite it by. */
export interface BriefFact {
  key: string;
  ref: ProjectBriefRef;
  text: string;
}

const PROSE_TIMEOUT_MS = 20_000;
const MAX_SENTENCES = 4;
const MAX_SENTENCE_CHARS = 240;

const refKey = (ref: ProjectBriefRef) => `${ref.kind}:${ref.id}`;

/** The briefs a side call was started for, per control, so each is asked for once. */
const asked = new WeakMap<ControlContext, Set<string>>();

/** The name the board shows for what the ref links to; undefined when it has none. */
function refTitle(
  ctx: ControlContext,
  ref: ProjectBriefRef,
  plans: BoardPlan[],
): string | undefined {
  if (ref.kind === 'task') {
    const at = ref.id.indexOf(':');
    return plans
      .find((plan) => plan.id === ref.id.slice(0, at))
      ?.tasks.find((task) => task.id === ref.id.slice(at + 1))?.title;
  }
  if (ref.kind === 'milestone') return ctx.store.get<Milestone>('milestones', ref.id)?.title;
  if (ref.kind === 'proposal')
    return ctx.store.get<AgentProposal>('agent_proposals', ref.id)?.fields.name;
  const session =
    ref.kind === 'merge'
      ? ref.id
      : ref.kind === 'approval'
        ? ctx.store.get<Approval>('approvals', ref.id)?.session_id
        : (
            ctx.store.db.prepare('SELECT aggregate_id FROM events WHERE event_id=?').get(ref.id) as
              { aggregate_id: string } | undefined
          )?.aggregate_id;
  return session ? ctx.store.get<Session>('sessions', session)?.title : undefined;
}

/** Each item of the brief in one line with the names the board shows. */
export function briefFacts(
  ctx: ControlContext,
  projectId: string,
  items: ProjectBriefItem[],
): BriefFact[] {
  const plans = ctx.store
    .list<BoardPlan>('board_plans')
    .filter((plan) => plan.project_id === projectId);
  return items.map((item) => {
    const title = refTitle(ctx, item.ref, plans);
    const named = title ? `"${title}"` : undefined;
    const text =
      item.kind === 'decisions'
        ? `${item.count} decisions wait on the user, ${item.new} of them new; the first is ${item.top.reason}${named ? ` on ${named}` : ''} and blocks ${item.top.blocks} tasks.`
        : item.kind === 'milestone'
          ? `Milestone "${item.title}" moved to ${item.done} of ${item.total} done.`
          : item.kind === 'merge'
            ? `${named ?? 'An untitled session'} merged.`
            : item.kind === 'failure'
              ? `${named ?? 'A session'} failed: ${item.reason}.`
              : item.kind === 'assumption'
                ? `The plan assumes something new: ${item.text}`
                : `An agent proposal${named ? ` for ${named}` : ''} waits for the user.`;
    return { key: refKey(item.ref), ref: item.ref, text };
  });
}

export function briefProsePrompt(facts: BriefFact[]): string {
  return [
    'Write a short paragraph for a user who comes back to a software project, about what happened while they were away.',
    'Reply with one JSON object alone: {"sentences": [{"text": string, "refs": [string]}]}.',
    `At most ${MAX_SENTENCES} sentences, each at most ${MAX_SENTENCE_CHARS} characters. refs lists the keys, written in brackets before each item, of the items the sentence is about; a sentence without refs is dropped.`,
    'Use only the facts of the items. Write a number only in digits and only as a cited item gives it; do not count, add or round, and write no dates or times.',
    'Name an item by the title the item gives in quotes, written exactly.',
    'Write in the language of the titles.',
    '',
    '<brief_items>',
    ...facts.map((fact) => `- [${fact.key}] ${fact.text}`),
    '</brief_items>',
  ].join('\n');
}

/**
 * The cited sentences of the reply: a sentence with no ref, an unknown ref, or a number its cited
 * items do not give is dropped, and so is one past the length; undefined when the reply is no such JSON.
 */
export function checkBriefProse(
  reply: string,
  facts: BriefFact[],
): ProjectBriefProse['sentences'] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  } catch {
    return;
  }
  const sentences = (value as { sentences?: unknown } | null)?.sentences;
  if (!Array.isArray(sentences)) return;
  const kept: ProjectBriefProse['sentences'] = [];
  for (const sentence of sentences as unknown[]) {
    if (kept.length === MAX_SENTENCES) break;
    const { text, refs } = (sentence ?? {}) as { text?: unknown; refs?: unknown };
    if (typeof text !== 'string' || !Array.isArray(refs) || refs.length === 0) continue;
    const trimmed = text.trim();
    if (!trimmed || [...trimmed].length > MAX_SENTENCE_CHARS) continue;
    const cited = [...new Set(refs)].map((key) => facts.filter((fact) => fact.key === key));
    if (cited.some((matches) => matches.length === 0)) continue;
    const given = new Set(cited.flat().flatMap((fact) => fact.text.match(/\d+/g) ?? []));
    if ((trimmed.match(/\d+/g) ?? []).some((digits) => !given.has(digits))) continue;
    kept.push({ text: trimmed, refs: cited.map((matches) => matches[0]!.ref) });
  }
  return kept;
}

/**
 * Asks the summarizer for the paragraph of the caller's brief and keeps it on the caller's seen
 * cursor; false when no call starts: an empty brief, the setting off, the project over budget,
 * no summarizer, or a brief that already has one or was asked for.
 */
export function writeBriefProse(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): boolean {
  const summarizer = ctx.turnSummarizer;
  const brief = projectBrief(ctx, principal, projectId);
  if (
    !summarizer ||
    brief.items.length === 0 ||
    brief.prose ||
    readAppSettings(ctx).brief_prose === false ||
    projectOverBudget(ctx, projectId)
  )
    return false;
  const itemsKey = briefItemsKey(brief.items),
    key = JSON.stringify([principal.id, projectId, brief.since, itemsKey]);
  const started = asked.get(ctx) ?? new Set<string>();
  asked.set(ctx, started);
  if (started.has(key)) return false;
  started.add(key);
  const facts = briefFacts(ctx, projectId, brief.items);
  const prompt = briefProsePrompt(facts);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  void Promise.race([
    Promise.resolve().then(() => summarizer(prompt, controller.signal)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${PROSE_TIMEOUT_MS} ms`));
      }, PROSE_TIMEOUT_MS);
    }),
  ])
    .then((reply) => {
      const sentences = checkBriefProse(reply.text, facts);
      if (!sentences?.length) throw new Error('the reply held no cited sentence');
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        const id = cursorId(principal, projectId),
          cursor = ctx.store.get<SeenCursor>('seen_cursors', id);
        // The user marked the brief read while the model wrote.
        if ((cursor?.at ?? 0) !== brief.since) return;
        const prose = {
          since: brief.since,
          items_key: itemsKey,
          sentences,
          at: ctx.store.now(),
          ...(reply.model ? { model: reply.model } : {}),
          ...(reply.usage ? { usage: reply.usage } : {}),
        };
        const next = cursor
          ? ctx.store.update('seen_cursors', { ...cursor, prose }, cursor.revision)
          : ctx.store.insert<SeenCursor>('seen_cursors', {
              id,
              revision: 1,
              user_id: principal.id,
              project_id: projectId,
              at: 0,
              prose,
            });
        ctx.store.event('project.brief_prose_written', next, projectId, prose);
      });
      ctx.changed();
    })
    .catch((error: unknown) =>
      console.error(
        `No brief prose for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    .finally(() => clearTimeout(timer));
  return true;
}

export const briefProseHandlers: Handlers = {
  'project.brief.prose.write': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.brief.prose.write'].parse(c.input);
    return { started: writeBriefProse(ctx, p, input.project_id) };
  },
};
