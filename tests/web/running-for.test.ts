import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { RunningFor, RUNNING } from '@/components/RunningFor';
import { StateGlyph } from '@/components/SessionStateIcon';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 19, 15, 40));
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

it('says what is running and for how many whole seconds, counting on', () => {
  const since = Date.now() - 12_400;
  const h = mount(() => RunningFor({ label: RUNNING.writing, since }));
  expect(nodes(h.value).some((n) => n.type === StateGlyph && n.props.name === 'running')).toBe(
    true,
  );
  expect(text(h.value)).toContain(zh('components.running.writing'));
  expect(text(h.value)).toContain('12 秒');
  vi.advanceTimersByTime(52_000);
  h.render();
  expect(text(h.value)).toContain('1 分 4 秒');
});

it('shows only what is running when its start is unknown', () => {
  const h = mount(() => RunningFor({ label: RUNNING.measuring, since: null }));
  expect(text(h.value)).not.toContain('秒');
  expect(text(h.value)).toContain(zh('components.running.measuring'));
  expect(RUNNING.redrawing).toBe(zh('components.running.redrawing'));
});
