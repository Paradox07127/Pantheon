import { expect, it } from 'vitest';
import { activeSessions, isDevProcess, ownsDaemon } from '../../scripts/relaunch.mjs';

const repo = '/work/Pantheon';
const electron = `${repo}/node_modules/.pnpm/electron@39.2.0/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;

it('picks the dev Electron, electron-vite and the watching tsc of this repo', () => {
  expect(isDevProcess(`${electron} .`, repo)).toBe(true);
  expect(
    isDevProcess(`${repo}/apps/desktop/.dev/Pantheon Dev.app/Contents/MacOS/Electron .`, repo),
  ).toBe(true);
  expect(
    isDevProcess(
      `node ${repo}/node_modules/.pnpm/electron-vite@5.0.0/node_modules/electron-vite/bin/electron-vite.js dev --watch`,
      repo,
    ),
  ).toBe(true);
  expect(
    isDevProcess(
      `node ${repo}/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -b --watch --preserveWatchOutput`,
      repo,
    ),
  ).toBe(true);
});

it('leaves acceptance windows, helpers, one-off builds, worktrees and other repos alone', () => {
  expect(isDevProcess(`${electron} ${repo}/apps/desktop --remote-debugging-port=55090`, repo)).toBe(
    false,
  );
  expect(
    isDevProcess(
      `${repo}/node_modules/.pnpm/electron@39.2.0/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer`,
      repo,
    ),
  ).toBe(false);
  expect(
    isDevProcess(
      `node ${repo}/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -b`,
      repo,
    ),
  ).toBe(false);
  expect(
    isDevProcess(
      `node ${repo}/.claude/worktrees/agent-1/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -b --watch`,
      repo,
    ),
  ).toBe(false);
  expect(
    isDevProcess(
      `/work/Other/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
      repo,
    ),
  ).toBe(false);
});

it('owns only the daemon this repo starts for the given data directory', () => {
  const dir = '/data/Application Support/Pantheon';
  expect(
    ownsDaemon(
      `node ${repo}/apps/daemon/dist/main.js --data-dir ${dir} --allow-fixture`,
      repo,
      dir,
    ),
  ).toBe(true);
  expect(ownsDaemon(`node ${repo}/apps/daemon/dist/main.js --data-dir ${dir}`, repo, dir)).toBe(
    true,
  );
  expect(
    ownsDaemon(`node ${repo}/apps/daemon/dist/main.js --data-dir ${dir} --verbose`, repo, dir),
  ).toBe(false);
  expect(
    ownsDaemon(
      `node ${repo}/.claude/worktrees/a/apps/daemon/dist/main.js --data-dir ${dir} --allow-fixture`,
      repo,
      dir,
    ),
  ).toBe(false);
  expect(
    ownsDaemon(
      `node ${repo}/apps/daemon/dist/main.js --data-dir /data/other --allow-fixture`,
      repo,
      dir,
    ),
  ).toBe(false);
});

it('counts the sessions a restart would cut off', () => {
  expect(
    activeSessions({
      sessions: [
        { state: 'running' },
        { state: 'reconciling' },
        { state: 'open', stop_pending: true },
        { state: 'open', process_identity: { pid: 1 } },
        { state: 'open' },
        { state: 'closed' },
      ],
    }),
  ).toBe(4);
});
