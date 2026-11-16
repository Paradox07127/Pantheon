import { expect, it } from 'vitest';
import { sleepGuard } from '../../apps/desktop/src/main/window.js';

function fakeBlocker() {
  const held = new Set<number>();
  let next = 0;
  return {
    held,
    start(type: 'prevent-app-suspension' | 'prevent-display-sleep') {
      expect(type).toBe('prevent-app-suspension');
      held.add(++next);
      return next;
    },
    stop(id: number) {
      return held.delete(id);
    },
  };
}

it('holds one blocker while the switch is on and a session runs, and releases it otherwise', () => {
  const blocker = fakeBlocker();
  const keepAwake = sleepGuard(blocker);
  keepAwake({ enabled: true, running: 0 });
  expect(blocker.held.size).toBe(0);
  keepAwake({ enabled: true, running: 2 });
  keepAwake({ enabled: true, running: 1 });
  expect([...blocker.held]).toEqual([1]);
  keepAwake({ enabled: true, running: 0 });
  expect(blocker.held.size).toBe(0);
  keepAwake({ enabled: true, running: 1 });
  expect([...blocker.held]).toEqual([2]);
  keepAwake({ enabled: false, running: 1 });
  expect(blocker.held.size).toBe(0);
  keepAwake({ enabled: false, running: 3 });
  expect(blocker.held.size).toBe(0);
});
