import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  DomainError,
  hash,
  id,
  requireThat,
  type ChangeStory,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
  type StorySubmission,
} from '@pantheon/domain';
import {
  inputSchemas,
  USER_PRINCIPAL_ID,
  type Command,
  type LandingDiff,
} from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
} from './context.js';
import { runtime } from './admission.js';
import { runGit, type GitResult } from './git.js';
import { checkedSource } from './source-git.js';
import { rangeDiffWithSyncBounds, sessionRangeAsync } from './landing-diff.js';
import { cardPatch, checkStory } from './change-story-check.js';
import { renderStoryBrief } from './change-story-brief.js';
import { storyContext } from './change-story-evidence.js';

export const STORY_WALL_TIME_MS = 30 * 60 * 1000;
const BRIEF_BOUND = 400000;

// A path or message with spaces or quotes must reach git as one argument when pasted into a shell.
const quote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The project, range and brief of what change_story.start explains. */
async function storyTarget(
  ctx: ControlContext,
  p: Principal,
  input: { session_id: string },
  action: string,
) {
  const session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, p, session.project_id, action);
  const range = await sessionRangeAsync(ctx, session);
  requireThat(range.from_sha !== range.to_sha, 'invalid_state', 'No committed changes to explain');
  const context = storyContext(ctx, session, range.to_sha);
  return {
    project_id: session.project_id,
    range,
    fields: { workbench_session_id: session.id, context },
    diff: () => rangeDiffWithSyncBounds(ctx, p, session.project_id, range),
    brief: (diff: LandingDiff) => renderStoryBrief(context, diff, []),
  };
}

/** The running or ready story of the same session, range and context as target. */
function existingStory(ctx: ControlContext, target: Awaited<ReturnType<typeof storyTarget>>) {
  return ctx.store
    .list<ChangeStory>('change_stories')
    .find(
      (story) =>
        story.project_id === target.project_id &&
        story.workbench_session_id === target.fields.workbench_session_id &&
        story.source === target.range.source &&
        story.from_sha === target.range.from_sha &&
        story.to_sha === target.range.to_sha &&
        hash(story.context) === hash(target.fields.context) &&
        (story.state === 'running' || story.state === 'ready'),
    );
}

/** The files the submission's diagrams anchor quotes in. */
function anchoredFiles(submission: StorySubmission): string[] {
  const files = submission.cards.flatMap(({ diagram }) =>
    !diagram
      ? []
      : diagram.type === 'flow'
        ? diagram.nodes.map((node) => node.anchor?.file)
        : diagram.type === 'ui'
          ? diagram.regions.map((region) => region.anchor?.file)
          : diagram.type === 'decision'
            ? diagram.rows.flatMap((row) => [row.before_anchor?.file, row.after_anchor?.file])
            : [diagram.file],
  );
  return [...new Set(files.filter((file) => file !== undefined))];
}

/** Each file's text at each commit, read in one cat-file run; absent where it is no file there. */
async function shownFiles(
  source: string,
  shas: string[],
  files: string[],
): Promise<Map<string, string>> {
  // Batch input ends each name at a newline, so a path containing one is never found.
  const names = files
    .filter((file) => !file.includes('\n'))
    .flatMap((file) => shas.map((sha) => [sha, file] as const));
  const shown = new Map<string, string>();
  if (!names.length) return shown;
  const read = await runGit(
    source,
    ['cat-file', '--batch'],
    Buffer.from(names.map(([sha, file]) => `${sha}:${file}\n`).join('')),
    true,
  );
  if (read.exit_code !== 0) return shown;
  let at = 0;
  for (const [sha, file] of names) {
    const end = read.stdout.indexOf('\n', at);
    const header = read.stdout.toString('utf8', at, end);
    at = end + 1;
    // A missing or ambiguous name has no contents; a found one is `<oid> <type> <size>`.
    if (/ (missing|ambiguous)$/.test(header)) continue;
    const [, type, size] = header.split(' ');
    if (type === 'blob')
      shown.set(JSON.stringify([sha, file]), read.stdout.toString('utf8', at, at + Number(size)));
    at += Number(size) + 1;
  }
  return shown;
}

/** Reads exactly the commits the interpreter saw, including after the worktree changes or is removed. */
export function changeStoryDiff(
  ctx: ControlContext,
  p: Principal,
  storyId: string,
): Promise<LandingDiff> {
  const story = ctx.store.must<ChangeStory>('change_stories', storyId);
  projectAccess(ctx, p, story.project_id, 'project.read');
  return rangeDiffWithSyncBounds(ctx, p, story.project_id, story);
}

async function outdated(
  ctx: ControlContext,
  story: ChangeStory,
  cache: Map<string, Promise<string | null>>,
  heads: Map<string, Promise<GitResult>>,
): Promise<boolean> {
  if (!story.workbench_session_id) return true;
  const key = story.workbench_session_id;
  const saved = hash({
    source: story.source,
    from_sha: story.from_sha,
    to_sha: story.to_sha,
    context: story.context,
  });
  if (!cache.has(key)) {
    const session = ctx.store.get<Session>('sessions', key);
    cache.set(
      key,
      session
        ? sessionRangeAsync(ctx, session, heads)
            .then((range) => hash({ ...range, context: storyContext(ctx, session, range.to_sha) }))
            .catch(() => null)
        : Promise.resolve(null),
    );
  }
  return (await cache.get(key)!) !== saved;
}

function createStorySession(
  ctx: ControlContext,
  project: Project,
  storyId: string,
  runtimeName: string,
  brief: string,
): Session {
  runtime(ctx, runtimeName, 'reviewer');
  const session: Session = {
    id: id(),
    revision: 1,
    project_id: project.id,
    runtime: runtimeName,
    device_id: 'local',
    state: 'running',
    turn_count: 1,
    change_story: { story_id: storyId },
  };
  ctx.store.insert('sessions', session);
  const turn: SessionTurn = {
    id: id(),
    revision: 1,
    project_id: project.id,
    session_id: session.id,
    model: session.reported_model ?? session.requested_model ?? null,
    input: brief,
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
  };
  ctx.store.insert('session_turns', turn);
  ctx.store.enqueue('session.turn', { turn_id: turn.id });
  ctx.store.event('session.opened', session, project.id, { purpose: 'change_story' });
  ctx.store.event('turn.queued', turn, project.id, { purpose: 'change_story' });
  return session;
}

function boundStory(ctx: ControlContext, p: Principal, storyId: string, action: string) {
  const story = ctx.store.must<ChangeStory>('change_stories', storyId);
  projectAccess(ctx, p, story.project_id, action);
  const session = p.session_id ? ctx.store.get<Session>('sessions', p.session_id) : undefined;
  requireThat(
    session?.change_story?.story_id === story.id && story.session_id === session.id,
    'permission_denied',
    'Bound change story session required',
  );
  requireThat(story.state === 'running', 'invalid_state', 'Change story is not running');
  return { story, session };
}

export async function changeStoryList(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<ChangeStory[]> {
  projectAccess(ctx, p, projectId, 'project.read');
  const cache = new Map<string, Promise<string | null>>(),
    heads = new Map<string, Promise<GitResult>>();
  return Promise.all(
    ctx.store
      .list<ChangeStory>('change_stories')
      .filter((story) => story.project_id === projectId)
      .map(async (story) => ({ ...story, outdated: await outdated(ctx, story, cache, heads) })),
  );
}

export const isPreparedChangeStory = (type: string): boolean =>
  type === 'change_story.start' ||
  type === 'change_story.submit' ||
  type === 'change_story.revert_patch';

/**
 * Reads the git a change_story.start or change_story.submit needs before its transaction; the
 * returned handler records the command.
 */
export async function prepareChangeStory(
  ctx: ControlContext,
  p: Principal,
  c: Command,
): Promise<Handler> {
  if (c.type === 'change_story.revert_patch') return prepareRevertPatch(ctx, p, c);
  return c.type === 'change_story.start' ? prepareStart(ctx, p, c) : prepareSubmit(ctx, p, c);
}

async function prepareStart(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  userOnly(p);
  const input = inputSchemas['change_story.start'].parse(c.input);
  revision(ctx, c);
  const target = await storyTarget(ctx, p, input, c.type);
  const seen = existingStory(ctx, target);
  const diff = seen ? undefined : await target.diff();
  return (ctx, p, c) => {
    revision(ctx, c);
    const existing = existingStory(ctx, target);
    if (existing) return existing;
    if (!diff) return ctx.store.must<ChangeStory>('change_stories', seen!.id);
    return startStory(ctx, c, target, diff);
  };
}

function startStory(
  ctx: ControlContext,
  c: Command,
  target: Awaited<ReturnType<typeof storyTarget>>,
  diff: LandingDiff,
): ChangeStory {
  const project = ctx.store.must<Project>('projects', target.project_id);
  const brief = diff.truncated ? undefined : target.brief(diff);
  const base = {
    id: id(),
    revision: 1,
    project_id: project.id,
    ...target.fields,
    ...target.range,
  };
  if (brief === undefined || brief.length > BRIEF_BOUND) {
    const story: ChangeStory = {
      ...base,
      state: 'failed',
      reason: 'diff_too_large',
      created_at: ctx.store.now(),
    };
    ctx.store.insert('change_stories', story);
    return story;
  }
  const runtimes = [...ctx.adapters.keys()];
  const runtimeName = runtimes.includes('claude') ? 'claude' : runtimes[0]!;
  const session = createStorySession(ctx, project, base.id, runtimeName, brief);
  const story: ChangeStory = {
    ...base,
    state: 'running',
    session_id: session.id,
    runtime: runtimeName,
    deadline: ctx.store.now() + STORY_WALL_TIME_MS,
    created_at: ctx.store.now(),
  };
  ctx.store.insert('change_stories', story);
  ctx.store.event(
    'change_story.started',
    story,
    project.id,
    { session_id: session.id },
    c.command_id,
  );
  return story;
}

async function prepareSubmit(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const { story_id, ...submission } = inputSchemas['change_story.submit'].parse(c.input);
  revision(ctx, c);
  const { story } = boundStory(ctx, p, story_id, c.type);
  // The session may not read workspaces; the diff is read as the user who started the story.
  const owner: Principal = { id: USER_PRINCIPAL_ID, role: 'user' };
  const diff = await rangeDiffWithSyncBounds(ctx, owner, story.project_id, story);
  const source = checkedSource(ctx, owner, story.project_id, story.source);
  const shown = await shownFiles(source, [diff.from_sha, diff.to_sha], anchoredFiles(submission));
  const checked = checkStory({
    diff,
    task: { acceptance: story.context?.acceptance ?? [] },
    gates: story.context?.checks.state === 'recorded' ? story.context.checks.results : [],
    submission,
    show: (sha, file) => shown.get(JSON.stringify([sha, file])) ?? null,
  });
  if (!checked.ok) throw new DomainError('invalid_input', checked.errors.join('\n'));
  return (ctx, p, c) => {
    revision(ctx, c);
    const { story, session } = boundStory(ctx, p, story_id, c.type);
    const next = ctx.store.update<ChangeStory>(
      'change_stories',
      { ...story, state: 'ready', result: checked.result },
      story.revision,
    );
    ctx.store.event(
      'change_story.ready',
      next,
      next.project_id,
      { session_id: session.id },
      c.command_id,
    );
    return next;
  };
}

async function prepareRevertPatch(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  userOnly(p);
  const story = ctx.store.must<ChangeStory>(
    'change_stories',
    inputSchemas['change_story.revert_patch'].parse(c.input).story_id,
  );
  projectAccess(ctx, p, story.project_id, c.type);
  const diff = await rangeDiffWithSyncBounds(ctx, p, story.project_id, story);
  const revert: (...args: [...Parameters<Handler>, LandingDiff]) => unknown =
    changeStoryHandlers['change_story.revert_patch']!;
  return (ctx, p, c) => revert(ctx, p, c, diff);
}

export const changeStoryHandlers: Handlers = {
  // Its diff is read before the transaction, by prepareRevertPatch.
  'change_story.revert_patch': (ctx, p, c, diff?: LandingDiff) => {
    userOnly(p);
    const input = inputSchemas['change_story.revert_patch'].parse(c.input);
    revision(ctx, c);
    const story = ctx.store.must<ChangeStory>('change_stories', input.story_id);
    projectAccess(ctx, p, story.project_id, c.type);
    requireThat(
      story.state === 'ready' && story.result,
      'invalid_state',
      'Change story is not ready',
    );
    const cards = story.result.cards;
    const card = cards[input.card];
    requireThat(card, 'invalid_input', `card must be below ${cards.length}`);
    const number = input.card + 1;
    requireThat(
      card.shared_with.length === 0,
      'invalid_state',
      `Card ${number} shares hunks with card ${card.shared_with.map((index) => index + 1).join(', ')}; it cannot be reverted alone`,
    );
    const directory = path.join(path.dirname(ctx.files.directory), 'change-story-patches');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${story.id}-card${number}.patch`);
    writeFileSync(file, cardPatch(diff!, card.hunks));
    const q = quote(story.source);
    // One chained line: pasted lines run on after a failure. apply --3way stages only the patch.
    return {
      path: file,
      commands: [
        [
          `test -z "$(git -C ${q} status --porcelain)"`,
          `git -C ${q} switch -c pantheon/revert-${story.to_sha.slice(0, 7)}-card${number}`,
          `git -C ${q} apply -R --3way ${quote(file)}`,
          `git -C ${q} commit -m ${quote(`revert: ${card.title}`)}`,
        ].join(' && '),
      ],
    };
  },
};

/** The session has no live process, queued or running turn, or pending stop left. */
export function sessionEnded(ctx: ControlContext, sessionId: string): boolean {
  const session = ctx.store.must<Session>('sessions', sessionId);
  return (
    !session.stop_pending &&
    !session.process_identity &&
    !['running', 'reconciling'].includes(session.state) &&
    ![...ctx.handles.values()].some((handle) => handle.platform_session_id === sessionId) &&
    !ctx.store
      .list<SessionTurn>('session_turns')
      .some((turn) => turn.session_id === sessionId && ['queued', 'running'].includes(turn.state))
  );
}

export function tickChangeStories(ctx: ControlContext): void {
  for (const story of ctx.store.list<ChangeStory>('change_stories')) {
    if (story.state !== 'running') continue;
    const reason =
      ctx.store.now() >= story.deadline!
        ? 'story_window_expired'
        : sessionEnded(ctx, story.session_id!)
          ? 'story_missing'
          : undefined;
    if (!reason) continue;
    const next = ctx.store.update<ChangeStory>(
      'change_stories',
      { ...story, state: 'failed', reason },
      story.revision,
    );
    ctx.store.event('change_story.failed', next, next.project_id, { reason });
  }
}
