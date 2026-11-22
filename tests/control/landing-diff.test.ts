import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { LandingDiff } from '@pantheon/protocol';
import { renderStoryBrief } from '../../packages/control/src/change-story-brief.js';
import { id, type Session, type SessionTurn } from '@pantheon/domain';
import { rangeDiffWithSyncBounds, sessionGoal } from '../../packages/control/src/landing-diff.js';
import { notifySession } from '../../packages/control/src/session-wake.js';
import { git, workbenchFixture } from './workbench-fixture.js';
import { settle, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

/** The change one commit made against its parent, as a landing reads it. */
function commitDiff(f: Fixture, sha: string): Promise<LandingDiff> {
  const root = f.project.roots[0]!;
  return rangeDiffWithSyncBounds(f.control['ctx'], user, f.project.id, {
    source: root,
    from_sha: git(root, 'rev-parse', `${sha}^`),
    to_sha: sha,
  });
}

it('splits a commit into hunks whatever color the checkout configures', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  git(root, 'config', 'color.ui', 'always');
  writeFileSync(path.join(root, 'answer.txt'), 'base\nsecond\n');
  git(root, 'commit', '--quiet', '-am', 'Second');
  const diff = await commitDiff(f, git(root, 'rev-parse', 'HEAD'));
  expect(diff.hunks).toHaveLength(1);
  expect(diff.hunks[0]!.text).toContain('+second');
});

function commitFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), contents);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Change files');
  return git(root, 'rev-parse', 'HEAD');
}

const marks = (diff: LandingDiff) => diff.hunks.map((hunk) => [hunk.file, hunk.noise]);

it('marks only indentation and blank lines as whitespace, not a split line or space inside one', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  commitFiles(root, {
    'layout.js': 'function g() {\nreturn 1;\n}\n',
    'literal.js': 'const s = "a b";\n',
    'returned.js': 'function f() {\n  return value;\n}\n',
    'run.sh': 'echo cleanup rm -rf "$TARGET"\n',
  });
  const sha = commitFiles(root, {
    'layout.js': 'function g() {\n\n  return 1;\n}\n',
    'literal.js': 'const s = "a  b";\n',
    'returned.js': 'function f() {\n  return\n  value;\n}\n',
    'run.sh': 'echo cleanup\nrm -rf "$TARGET"\n',
  });
  expect(marks(await commitDiff(f, sha))).toEqual([
    ['layout.js', 'whitespace'],
    ['literal.js', undefined],
    ['returned.js', undefined],
    ['run.sh', undefined],
  ]);
});

it('marks build output as generated only beside a change to other files', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  commitFiles(root, { 'dist/index.js': 'run(1);\n', 'src/index.js': 'run(1);\n' });
  const alone = commitFiles(root, { 'dist/index.js': 'run(2);\n' });
  const beside = commitFiles(root, { 'dist/index.js': 'run(3);\n', 'src/index.js': 'run(3);\n' });
  expect(marks(await commitDiff(f, alone))).toEqual([['dist/index.js', undefined]]);
  expect(marks(await commitDiff(f, beside))).toEqual([
    ['dist/index.js', 'generated'],
    ['src/index.js', undefined],
  ]);
});

it('asks the story to tell a moved block that may run differently in a card', async () => {
  const f = await workbenchFixture();
  const root = f.project.roots[0]!;
  const calls = 'sendEmail(user);\nchargeCard(user);\nlogAudit(user);\n';
  commitFiles(root, { 'a.js': `start();\n${calls}end();\n` });
  const sha = commitFiles(root, { 'a.js': 'start();\nend();\n', 'unused.js': calls });
  const diff = await commitDiff(f, sha);
  expect(marks(diff)).toEqual([
    ['a.js', 'moved'],
    ['unused.js', 'moved'],
  ]);
  const brief = renderStoryBrief({ goal: 'Tidy the module', acceptance: [] }, diff, []);
  expect(brief).not.toContain('change no behavior');
  expect(brief).toContain(
    'put them in `noise` only when the lines still run at the same points, else in a card',
  );
});

/** A settled session that received each message as its own turn. */
async function askedSession(f: Fixture, messages: string[]) {
  const session = await f.create(messages[0]);
  await settle(f, session);
  for (const input of messages.slice(1)) {
    await f.call(
      'session.send',
      { session_id: session.id, input },
      f.store.must<Session>('sessions', session.id).revision,
    );
    await settle(f, session);
  }
  return f.store.must<Session>('sessions', session.id);
}

/** The requests a session's goal carries, below its title line. */
const goalOf = (f: Fixture, session: Session) =>
  sessionGoal(f.control['ctx'], f.store.must<Session>('sessions', session.id)).split('\n').slice(1);

it("puts a session's later requests in its goal after the first", async () => {
  const f = await workbenchFixture();
  const session = await askedSession(f, ['Explain the layout', 'Rename the answer file']);
  expect(goalOf(f, session)).toEqual(['Explain the layout', 'Rename the answer file']);
});

it('starts the goal from the requests after the last landing', async () => {
  const f = await workbenchFixture();
  const session = await askedSession(f, ['Write the parser']);
  f.store.event('session.merged', session, f.project.id, {});
  await f.call(
    'session.send',
    { session_id: session.id, input: 'Add parser error messages' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await settle(f, session);
  expect(goalOf(f, session)).toEqual(['Add parser error messages']);
});

it("leaves Pantheon's notices out of the goal, and keeps the first request when only they follow a landing", async () => {
  const f = await workbenchFixture();
  const session = await askedSession(f, ['Write the parser', 'Add parser error messages']);
  notifySession(f.control['ctx'], session.id, 'Review finished: pass', 'review-notice');
  await settle(f, session);
  expect(goalOf(f, session)).toEqual(['Write the parser', 'Add parser error messages']);
  f.store.event('session.merged', session, f.project.id, {});
  notifySession(f.control['ctx'], session.id, 'Landing checks passed', 'landing-notice');
  await settle(f, session);
  expect(goalOf(f, session)).toEqual(['Write the parser']);
});

it('leaves a notice stored with the earlier tracker origin out of the goal', async () => {
  const f = await workbenchFixture();
  const session = await askedSession(f, ['Write the parser']);
  f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: 'Review finished: pass',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    origin: 'tracker',
  });
  expect(goalOf(f, session)).toEqual(['Write the parser']);
});
