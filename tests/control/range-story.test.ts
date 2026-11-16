import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ChangeStory, Principal, RangeStory, Session, Workspace } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const HOUR = 60 * 60 * 1000;

/** A workbench session whose commit has been merged into the source and whose worktree is removed. */
async function mergedSession() {
  const w = workbenchFixture();
  git(w.source, 'config', 'user.name', 'Source User');
  git(w.source, 'config', 'user.email', 'source@example.invalid');
  const session = w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'merged\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  w.call(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => w.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => w.control.tick(),
  );
  const now = w.store.now();
  const startStory = () =>
    w.call<RangeStory>('range_story.start', {
      project_id: w.project.id,
      from: now - HOUR,
      to: now + HOUR,
    });
  return { w, session: w.store.must<Session>('sessions', session.id), startStory };
}

function storyPrincipal(w: ReturnType<typeof workbenchFixture>, story: RangeStory): Principal {
  return {
    id: `session:${story.session_id}`,
    role: 'planner',
    project_id: w.project.id,
    session_id: story.session_id!,
    expires_at: w.store.now() + 60000,
  };
}

it('starts a read-only session whose brief lists the sessions merged in the range', async () => {
  const { w, session, startStory } = await mergedSession();
  const story = startStory();
  expect(story).toMatchObject({ project_id: w.project.id, state: 'running', lines: [] });
  expect(story.session_id).not.toBeNull();
  expect(w.store.must<Session>('sessions', story.session_id!).range_story).toEqual({
    story_id: story.id,
  });
  expect(session.title).toBeTruthy();
  expect(w.turns(story.session_id!)[0]!.input).toContain(`### ${session.title}`);
});

it('leaves out the change story of another range of the merged session', async () => {
  const { w, session, startStory } = await mergedSession();
  const merged = w.store.kindEvents(w.project.id, ['session.merged'])[0]!.payload as {
    to_sha: string;
  };
  w.store.insert<ChangeStory>('change_stories', {
    id: 'earlier-range-story',
    revision: 1,
    project_id: w.project.id,
    workbench_session_id: session.id,
    source: w.source,
    from_sha: '1'.repeat(40),
    to_sha: merged.to_sha,
    state: 'ready',
    created_at: w.store.now(),
    result: {
      overall: { before: ['Earlier range before'], after: ['Earlier range after'] },
      cards: [],
      noise: [],
      uninterpreted: [],
      hunk_total: 0,
      unmatched_acceptance: [],
    },
  });
  const brief = w.turns(startStory().session_id!)[0]!.input;
  expect(brief).toContain(`### ${session.title}`);
  expect(brief).not.toContain('Earlier range');
});

it('refuses a range without merges', () => {
  const w = workbenchFixture();
  const now = w.store.now();
  expect(() =>
    w.call('range_story.start', { project_id: w.project.id, from: now - HOUR, to: now + HOUR }),
  ).toThrow(expect.objectContaining({ code: 'invalid_input' }));
});

it('refuses a submission from a session the story did not start', async () => {
  const { w, startStory } = await mergedSession();
  const story = startStory();
  const other = startStory();
  expect(() =>
    w.call(
      'range_story.submit',
      { story_id: story.id, lines: ['Answers were merged'] },
      null,
      storyPrincipal(w, other),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(w.store.must<RangeStory>('range_stories', story.id).state).toBe('running');
});

it('lists the submitted lines once the bound session submits them', async () => {
  const { w, startStory } = await mergedSession();
  const story = startStory();
  const lines = ['The answer file now reads merged.', 'Nothing else changed.'];
  w.call('range_story.submit', { story_id: story.id, lines }, null, storyPrincipal(w, story));
  expect(w.control.rangeStoryList(user, w.project.id)).toEqual([
    expect.objectContaining({ id: story.id, state: 'ready', lines }),
  ]);
});

it('accepts at most six submitted lines', () => {
  const schema = inputSchemas['range_story.submit'];
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index}`);
  expect(schema.safeParse({ story_id: 'story', lines: lines(6) }).success).toBe(true);
  expect(schema.safeParse({ story_id: 'story', lines: lines(7) }).success).toBe(false);
});
