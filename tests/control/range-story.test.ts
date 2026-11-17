import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ChangeStory, Principal, RangeStory, Session, Workspace } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_READ_INSTRUCTIONS,
} from '../../packages/control/dist/memory.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const HOUR = 60 * 60 * 1000;

/** A workbench session whose commit has been merged into the source and whose worktree is removed. */
async function mergedSession() {
  const w = await workbenchFixture();
  git(w.source, 'config', 'user.name', 'Source User');
  git(w.source, 'config', 'user.email', 'source@example.invalid');
  const session = await w.create();
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
    w.call<Promise<RangeStory>>('range_story.start', {
      project_id: w.project.id,
      from: now - HOUR,
      to: now + HOUR,
    });
  return { w, session: w.store.must<Session>('sessions', session.id), startStory };
}

function storyPrincipal(
  w: Awaited<ReturnType<typeof workbenchFixture>>,
  story: RangeStory,
): Principal {
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
  const story = await startStory();
  expect(story).toMatchObject({
    project_id: w.project.id,
    state: 'running',
    lines: [],
    source: 'merges',
  });
  expect(story.session_id).not.toBeNull();
  expect(w.store.must<Session>('sessions', story.session_id!).range_story).toEqual({
    story_id: story.id,
  });
  expect(session.title).toBeTruthy();
  expect(w.turns(story.session_id!)[0]!.input).toContain(`### ${session.title}`);
});

it('tells the story session how to read project memory but not how to write it', async () => {
  const { w, startStory } = await mergedSession();
  const story = await startStory();
  await eventually(
    () => w.start.mock.calls.some(([spec]) => spec.platform_session_id === story.session_id),
    () => w.control.tick(),
  );
  const instructions = w.start.mock.calls.find(
    ([spec]) => spec.platform_session_id === story.session_id,
  )![0].control_instructions!;
  expect(instructions).not.toContain('memory_propose');
  expect(instructions).toContain(MEMORY_READ_INSTRUCTIONS);
  expect(instructions).not.toContain(MEMORY_INSTRUCTIONS);
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
  const brief = w.turns((await startStory()).session_id!)[0]!.input;
  expect(brief).toContain(`### ${session.title}`);
  expect(brief).not.toContain('Earlier range');
});

it('refuses a range without merges or commits', async () => {
  const w = await workbenchFixture();
  const now = w.store.now();
  await expect(async () =>
    w.call('range_story.start', {
      project_id: w.project.id,
      from: now - 48 * HOUR,
      to: now - 24 * HOUR,
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: 'invalid_input',
      message: expect.stringContaining('No merges or commits in the range'),
    }),
  );
});

it.each([
  { extra: 0, listed: 'Describe the answer file', omitted: undefined },
  { extra: 300, listed: 'Empty commit 300', omitted: 'the oldest 2 are left out' },
])(
  'explains the main-line commits of a range without merges ($extra extra commits)',
  async ({ extra, listed, omitted }) => {
    const w = await workbenchFixture();
    writeFileSync(path.join(w.source, 'answer.txt'), 'described\n');
    git(w.source, 'commit', '--quiet', '-am', 'Describe the answer file');
    for (let index = 1; index <= extra; index++)
      git(w.source, 'commit', '--quiet', '--allow-empty', '-m', `Empty commit ${index}`);
    const now = w.store.now();
    const story = await w.call<Promise<RangeStory>>('range_story.start', {
      project_id: w.project.id,
      from: now - HOUR,
      to: now + HOUR,
    });
    expect(story).toMatchObject({ state: 'running', source: 'commits' });
    const brief = w.turns(story.session_id!)[0]!.input;
    expect(brief).toContain(listed);
    if (omitted) expect(brief).toContain(omitted);
    else expect(brief).toMatch(/Describe the answer file \(files changed: 1\)/);
  },
);

it('refuses a submission from a session the story did not start', async () => {
  const { w, startStory } = await mergedSession();
  const story = await startStory();
  const other = await startStory();
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
  const story = await startStory();
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
