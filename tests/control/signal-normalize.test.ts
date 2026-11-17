import { expect, it } from 'vitest';
import {
  appErrorFingerprint,
  firstAppFrame,
  normalizeMessage,
} from '../../packages/control/dist/signal-normalize.js';

const stack = (message: string, ...frames: string[]) =>
  [message, ...frames.map((frame) => `    at ${frame}`)].join('\n');

const appStack = (message: string, line = 12) =>
  stack(
    message,
    'commitRoot (http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=4f2a9c1e:9012:7)',
    `renderPanel (http://localhost:5173/src/screens/board/Panel.tsx?t=1763372000123:${line}:9)`,
    'App (http://localhost:5173/src/App.tsx:40:3)',
  );

it('gives messages that differ only in numbers, a hash, a URL or a quoted string one fingerprint', () => {
  const pairs = [
    ['Task 41 failed after 3 tries', 'Task 7 failed after 12 tries'],
    ['Commit 9f3c2ab1e not found', 'Commit 04d8e7c6b2 not found'],
    [
      'Session 0b3e9a14-1c2d-4e5f-8a9b-0c1d2e3f4a5b closed',
      'Session e1f2a3b4-c5d6-4e7f-8091-a2b3c4d5e6f7 closed',
    ],
    [
      'Failed to fetch https://example.test/v1/board?x=1',
      'Failed to fetch http://127.0.0.1:4321/v1/events',
    ],
    [
      `Cannot read properties of undefined (reading 'title')`,
      `Cannot read properties of undefined (reading "name")`,
    ],
  ] as const;
  for (const [a, b] of pairs) {
    expect(normalizeMessage(a), a).toBe(normalizeMessage(b));
    expect(appErrorFingerprint({ message: `TypeError: ${a}`, stack: appStack(a) })).toBe(
      appErrorFingerprint({ message: `TypeError: ${b}`, stack: appStack(b, 30) }),
    );
  }
  expect(normalizeMessage("Can't open the panel")).toBe("Can't open the panel");
});

it('tells errors apart by their type and by the first frame in the app source', () => {
  const message = 'TypeError: x is undefined';
  const here = appErrorFingerprint({ message, stack: appStack(message) });
  const elsewhere = appErrorFingerprint({
    message,
    stack: stack(
      message,
      'commitRoot (http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=4f2a9c1e:9012:7)',
      'openDrawer (http://localhost:5173/src/screens/sessions/Drawer.tsx:88:2)',
    ),
  });
  expect(here).not.toBe(elsewhere);
  expect(appErrorFingerprint({ message: 'RangeError: x is undefined' })).not.toBe(
    appErrorFingerprint({ message }),
  );
});

it('skips frames in dependencies and hashed chunks when it looks for the app frame', () => {
  expect(firstAppFrame(appStack('Error: boom'))).toBe('renderPanel /src/screens/board/Panel.tsx');
  expect(
    firstAppFrame(
      stack(
        'Error: boom',
        'file:///Applications/Pantheon.app/Contents/Resources/renderer/assets/index-B4x9zQ2k.js:1:23456',
        'run (/work/pantheon/node_modules/zustand/esm/index.mjs:3:1)',
      ),
    ),
  ).toBeUndefined();
  expect(firstAppFrame(undefined)).toBeUndefined();
});
