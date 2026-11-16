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
import { inputSchemas } from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { runtime } from './admission.js';
import { sessionEnded, STORY_WALL_TIME_MS } from './change-story.js';

const BRIEF_BOUND = 400000;

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

/** The whole input of a read-only session that explains what was merged in one range. */
export function renderRangeBrief(from: number, to: number, merges: RangeMerge[]): string {
  const lines = [
    '# Range story',
    `Range: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}, ${merges.length} merges.`,
    '',
    '## Merges',
  ];
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
  lines.push(
    '',
    '## How to answer',
    '- Answer by calling the `range_story_submit` tool with `lines`: 1 to 6 lines, each at most 280 characters.',
    '- Together the lines are one paragraph on what the range merged, for its owner.',
    '- Group related merges by what they changed for the user; do not list every merge.',
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

export const rangeStoryHandlers: Handlers = {
  'range_story.start': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['range_story.start'].parse(c.input);
    revision(ctx, c);
    projectAccess(ctx, p, input.project_id, c.type);
    const project = ctx.store.must<Project>('projects', input.project_id);
    const merges = rangeMerges(ctx, project.id, input.from, input.to);
    requireThat(merges.length > 0, 'invalid_input', 'No merges in the range');
    const brief = renderRangeBrief(input.from, input.to, merges);
    const base = {
      id: id(),
      revision: 1,
      project_id: project.id,
      from: input.from,
      to: input.to,
      lines: [],
      created_at: new Date(ctx.store.now()).toISOString(),
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
    ctx.store.event(
      'range_story.started',
      story,
      project.id,
      { session_id: session.id },
      c.command_id,
    );
    return story;
  },
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
