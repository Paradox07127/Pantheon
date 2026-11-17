import {
  id,
  requireThat,
  type ChangeStory,
  type Principal,
  type Project,
  type RangeStory,
  type Session,
  type SessionTurn,
  type StoryResult,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import {
  gitFolderAsync,
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
  type Preparers,
} from './context.js';
import { runtime } from './admission.js';
import { sessionEnded, STORY_WALL_TIME_MS } from './change-story.js';
import { runGit } from './git.js';

const BRIEF_BOUND = 400000;
const COMMIT_BOUND = 300;

/** One session.merged event in the range, with what the brief says about it. */
interface RangeMerge {
  at: number;
  title: string;
  branch: string | null;
  files: number | null;
  overall?: StoryResult['overall'];
}

function rangeMerges(ctx: ControlContext, projectId: string, from: number, to: number) {
  // Keyed by session and the range the story explains, so a merge gets only a story of its own range.
  const stories = new Map<string, ChangeStory>();
  for (const story of ctx.store.list<ChangeStory>('change_stories')) {
    const sessionId = story.workbench_session_id;
    if (story.project_id !== projectId || story.state !== 'ready' || !sessionId) continue;
    const key = `${sessionId} ${story.from_sha} ${story.to_sha}`;
    const newest = stories.get(key);
    if (!newest || story.created_at > newest.created_at) stories.set(key, story);
  }
  return ctx.store
    .kindEvents(projectId, ['session.merged'])
    .filter((event) => event.created_at >= from && event.created_at < to)
    .map((event): RangeMerge => {
      const payload = event.payload as {
        branch?: string;
        files?: number;
        from_sha?: string;
        to_sha?: string;
      };
      const overall = stories.get(`${event.aggregate_id} ${payload.from_sha} ${payload.to_sha}`)
        ?.result?.overall;
      return {
        at: event.created_at,
        title: ctx.store.get<Session>('sessions', event.aggregate_id)?.title ?? '',
        branch: payload.branch ?? null,
        files: payload.files ?? null,
        ...(overall ? { overall } : {}),
      };
    });
}

/** One main-line commit in the range, with what the brief says about it. */
export interface RangeCommit {
  sha: string;
  /** Committer time; the range is matched on it. */
  at: number;
  authored_at: number;
  subject: string;
  files: number;
}

/**
 * Main-line (first-parent) commits of HEAD in each git root committed in [from, to), newest first;
 * none when the range has merges, which the story tells instead.
 */
export async function rangeCommits(
  ctx: ControlContext,
  project: Project,
  from: number,
  to: number,
): Promise<RangeCommit[]> {
  if (rangeMerges(ctx, project.id, from, to).length > 0) return [];
  const git = await Promise.all(project.roots.map(gitFolderAsync));
  const logs = await Promise.all(
    project.roots
      .filter((_, index) => git[index])
      .map(async (root) => {
        // A HEAD without a commit lists nothing.
        const log = await runGit(
          root,
          [
            'log',
            '--first-parent',
            '--ignore-missing',
            `--since=@${Math.floor(from / 1000)}`,
            `--until=@${Math.ceil(to / 1000)}`,
            '--name-only',
            '--diff-merges=first-parent',
            '--format=%x1e%h%x1f%ct%x1f%at%x1f%s',
            'HEAD',
            '--',
          ],
          undefined,
          true,
        );
        requireThat(
          log.exit_code === 0,
          'git_failed',
          `Cannot read commits in ${root}: ${log.error ?? log.stderr.toString()}`,
        );
        return log;
      }),
  );
  const commits: RangeCommit[] = [];
  for (const log of logs) {
    for (const entry of log.stdout.toString().split('\x1e').slice(1)) {
      const [header, ...files] = entry.split('\n');
      const [sha, at, authored, subject] = header!.split('\x1f');
      const time = Number(at) * 1000;
      if (time < from || time >= to) continue;
      commits.push({
        sha: sha!,
        at: time,
        authored_at: Number(authored) * 1000,
        subject: subject ?? '',
        files: files.filter(Boolean).length,
      });
    }
  }
  return commits.sort((a, b) => b.at - a.at);
}

/** The whole input of a read-only session that explains what was merged or committed in one range. */
export function renderRangeBrief(
  from: number,
  to: number,
  merges: RangeMerge[],
  commits: RangeCommit[] = [],
): string {
  const source = merges.length > 0 ? 'merges' : 'commits';
  const range = `Range: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`;
  const lines = ['# Range story'];
  if (source === 'merges') {
    lines.push(`${range}, ${merges.length} merges.`, '', '## Merges');
    for (const merge of merges) {
      lines.push(
        '',
        `### ${merge.title || 'Untitled session'}`,
        `Merged: ${new Date(merge.at).toISOString()}; branch: ${merge.branch ?? 'unknown'}; files changed: ${merge.files ?? 'unknown'}.`,
      );
      if (merge.overall) {
        for (const item of merge.overall.before) lines.push(`Before: ${item}`);
        for (const item of merge.overall.after) lines.push(`After: ${item}`);
      }
    }
  } else {
    const omitted = commits.length - COMMIT_BOUND;
    lines.push(
      omitted > 0
        ? `${range}, ${commits.length} commits; the oldest ${omitted} are left out and the newest ${COMMIT_BOUND} listed.`
        : `${range}, ${commits.length} commits.`,
      '',
      '## Commits',
      '',
    );
    for (const commit of commits.slice(0, COMMIT_BOUND))
      lines.push(
        `- ${commit.sha} ${new Date(commit.authored_at).toISOString()}: ${commit.subject} (files changed: ${commit.files})`,
      );
  }
  const verb = source === 'merges' ? 'merged' : 'committed';
  const unit = source === 'merges' ? 'merge' : 'commit';
  lines.push(
    '',
    '## How to answer',
    '- Answer by calling the `range_story_submit` tool with `lines`: 1 to 6 lines, each at most 280 characters.',
    `- Together the lines are one paragraph on what the range ${verb}, for its owner.`,
    `- Group related ${unit}s by what they changed for the user; do not list every ${unit}.`,
    '- Give no scores and no risk ratings.',
    '- When the tool returns errors, fix what they name and submit again.',
  );
  return `${lines.join('\n')}\n`;
}

function createRangeSession(
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
    range_story: { story_id: storyId },
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
  ctx.store.event('session.opened', session, project.id, { purpose: 'range_story' });
  ctx.store.event('turn.queued', turn, project.id, { purpose: 'range_story' });
  return session;
}

export function rangeStoryList(ctx: ControlContext, p: Principal, projectId: string): RangeStory[] {
  projectAccess(ctx, p, projectId, 'project.read');
  return ctx.store
    .list<RangeStory>('range_stories')
    .filter((story) => story.project_id === projectId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Starts a story of the range's merges, or of its main-line commits, read with rangeCommits, when
 * nothing was merged.
 */
export function startRangeStory(
  ctx: ControlContext,
  project: Project,
  from: number,
  to: number,
  cause: string,
  mainLine: RangeCommit[],
): RangeStory {
  const merges = rangeMerges(ctx, project.id, from, to);
  const commits = merges.length > 0 ? [] : mainLine;
  requireThat(
    merges.length > 0 || commits.length > 0,
    'invalid_input',
    'No merges or commits in the range',
  );
  const brief = renderRangeBrief(from, to, merges, commits);
  const base = {
    id: id(),
    revision: 1,
    project_id: project.id,
    from,
    to,
    lines: [],
    created_at: new Date(ctx.store.now()).toISOString(),
    source: merges.length > 0 ? ('merges' as const) : ('commits' as const),
  };
  if (brief.length > BRIEF_BOUND) {
    const story: RangeStory = {
      ...base,
      state: 'failed',
      session_id: null,
      error: 'brief_too_large',
    };
    ctx.store.insert('range_stories', story);
    return story;
  }
  const runtimes = [...ctx.adapters.keys()];
  const runtimeName = runtimes.includes('claude') ? 'claude' : runtimes[0]!;
  const session = createRangeSession(ctx, project, base.id, runtimeName, brief);
  const story: RangeStory = { ...base, state: 'running', session_id: session.id };
  ctx.store.insert('range_stories', story);
  ctx.store.event('range_story.started', story, project.id, { session_id: session.id }, cause);
  return story;
}

function startTarget(ctx: ControlContext, p: Principal, c: Command) {
  userOnly(p);
  const input = inputSchemas['range_story.start'].parse(c.input);
  revision(ctx, c);
  projectAccess(ctx, p, input.project_id, c.type);
  return { input, project: ctx.store.must<Project>('projects', input.project_id) };
}

export const rangeStoryPreparers: Preparers = {
  'range_story.start': async (ctx, p, c) => {
    const { input, project } = startTarget(ctx, p, c);
    const commits = await rangeCommits(ctx, project, input.from, input.to);
    return (ctx, p, c) => {
      const { input, project } = startTarget(ctx, p, c);
      return startRangeStory(ctx, project, input.from, input.to, c.command_id, commits);
    };
  },
};

export const rangeStoryHandlers: Handlers = {
  'range_story.submit': (ctx, p, c) => {
    const input = inputSchemas['range_story.submit'].parse(c.input);
    revision(ctx, c);
    const story = ctx.store.must<RangeStory>('range_stories', input.story_id);
    projectAccess(ctx, p, story.project_id, c.type);
    const session = p.session_id ? ctx.store.get<Session>('sessions', p.session_id) : undefined;
    requireThat(
      session?.range_story?.story_id === story.id && story.session_id === session.id,
      'permission_denied',
      'Bound range story session required',
    );
    requireThat(story.state === 'running', 'invalid_state', 'Range story is not running');
    const next = ctx.store.update<RangeStory>(
      'range_stories',
      { ...story, state: 'ready', lines: input.lines },
      story.revision,
    );
    ctx.store.event(
      'range_story.ready',
      next,
      next.project_id,
      { session_id: session.id },
      c.command_id,
    );
    return next;
  },
};

export function tickRangeStories(ctx: ControlContext): void {
  for (const story of ctx.store.list<RangeStory>('range_stories')) {
    if (story.state !== 'running') continue;
    const error =
      ctx.store.now() >= Date.parse(story.created_at) + STORY_WALL_TIME_MS
        ? 'story_window_expired'
        : sessionEnded(ctx, story.session_id!)
          ? 'story_missing'
          : undefined;
    if (!error) continue;
    const next = ctx.store.update<RangeStory>(
      'range_stories',
      { ...story, state: 'failed', error },
      story.revision,
    );
    ctx.store.event('range_story.failed', next, next.project_id, { error });
  }
}
