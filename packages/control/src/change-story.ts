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
} from '@pantheon/domain';
import { inputSchemas, USER_PRINCIPAL_ID, type LandingDiff } from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { runtime } from './admission.js';
import { runGit } from './git.js';
import { checkedSource } from './source-git.js';
import { rangeDiffSync, rangeDiffWithSyncBounds, sessionRange } from './landing-diff.js';
import { cardPatch, checkStory } from './change-story-check.js';
import { renderStoryBrief } from './change-story-brief.js';
import { storyContext } from './change-story-evidence.js';

export const STORY_WALL_TIME_MS = 30 * 60 * 1000;
const BRIEF_BOUND = 400000;

// A path or message with spaces or quotes must reach git as one argument when pasted into a shell.
const quote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The project, range and brief of what change_story.start explains. */
function storyTarget(
  ctx: ControlContext,
  p: Principal,
  input: { session_id: string },
  action: string,
) {
  const session = ctx.store.must<Session>('sessions', input.session_id);
  projectAccess(ctx, p, session.project_id, action);
  const range = sessionRange(ctx, session);
  requireThat(range.from_sha !== range.to_sha, 'invalid_state', 'No committed changes to explain');
  const context = storyContext(ctx, session, range.to_sha);
  return {
    project_id: session.project_id,
    range,
    fields: { workbench_session_id: session.id, context },
    diff: () => rangeDiffSync(ctx, p, session.project_id, range),
    brief: (diff: LandingDiff) => renderStoryBrief(context, diff, []),
  };
}

function storyDiff(ctx: ControlContext, p: Principal, story: ChangeStory): LandingDiff {
  return rangeDiffSync(ctx, p, story.project_id, story);
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

function outdated(
  ctx: ControlContext,
  story: ChangeStory,
  cache: Map<string, string | null>,
): boolean {
  if (!story.workbench_session_id) return true;
  const key = story.workbench_session_id;
  const saved = hash({
    source: story.source,
    from_sha: story.from_sha,
    to_sha: story.to_sha,
    context: story.context,
  });
  if (cache.has(key)) return cache.get(key) !== saved;
  const session =
    story.workbench_session_id && ctx.store.get<Session>('sessions', story.workbench_session_id);
  if (!session) {
    cache.set(key, null);
    return true;
  }
  try {
    const range = sessionRange(ctx, session);
    const current = hash({ ...range, context: storyContext(ctx, session, range.to_sha) });
    cache.set(key, current);
    return current !== saved;
  } catch {
    cache.set(key, null);
    return true;
  }
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

export function changeStoryList(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ChangeStory[] {
  projectAccess(ctx, p, projectId, 'project.read');
  const cache = new Map<string, string | null>();
  return ctx.store
    .list<ChangeStory>('change_stories')
    .filter((story) => story.project_id === projectId)
    .map((story) => ({ ...story, outdated: outdated(ctx, story, cache) }));
}

export const changeStoryHandlers: Handlers = {
  'change_story.start': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['change_story.start'].parse(c.input);
    revision(ctx, c);
    const target = storyTarget(ctx, p, input, c.type);
    const existing = ctx.store
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
    if (existing) return existing;
    const project = ctx.store.must<Project>('projects', target.project_id);
    const diff = target.diff();
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
  },
  'change_story.submit': (ctx, p, c) => {
    const { story_id, ...submission } = inputSchemas['change_story.submit'].parse(c.input);
    revision(ctx, c);
    const { story, session } = boundStory(ctx, p, story_id, c.type);
    // The session may not read workspaces; the diff is read as the user who started the story.
    const owner: Principal = { id: USER_PRINCIPAL_ID, role: 'user' };
    const diff = storyDiff(ctx, owner, story);
    const source = checkedSource(ctx, owner, story.project_id, story.source);
    const checked = checkStory({
      diff,
      task: { acceptance: story.context?.acceptance ?? [] },
      gates: story.context?.checks.state === 'recorded' ? story.context.checks.results : [],
      submission,
      show: (sha, file) => {
        const shown = runGit(source, ['show', `${sha}:${file}`]);
        return shown.exit_code === 0 ? shown.stdout.toString() : null;
      },
    });
    if (!checked.ok) throw new DomainError('invalid_input', checked.errors.join('\n'));
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
  },
  'change_story.revert_patch': (ctx, p, c) => {
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
    const diff = storyDiff(ctx, p, story);
    const directory = path.join(path.dirname(ctx.files.directory), 'change-story-patches');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${story.id}-card${number}.patch`);
    writeFileSync(file, cardPatch(diff, card.hunks));
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
