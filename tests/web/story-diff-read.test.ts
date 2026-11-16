import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChangeStory } from '@pantheon/domain';
import type { LandingDiff } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ board: { status: { state: 'live' }, resync: 0 } }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({ useBoard: (selector: any) => selector(mock.board) }));
import { useChangeStoryDiff } from '@/data/change-story';

const story: ChangeStory = {
  id: 'story-a',
  revision: 1,
  project_id: 'project',
  source: '/repo',
  from_sha: 'before',
  to_sha: 'after',
  state: 'ready',
  created_at: 1,
};
const diff: LandingDiff = {
  source: '/repo',
  from_sha: 'before',
  to_sha: 'after',
  files: [],
  hunks: [],
  truncated: false,
};
beforeEach(() => {
  vi.stubGlobal('window', { pantheon: { query: vi.fn(async () => ({ ok: true, value: diff })) } });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('reads the story id and accepts only the exact frozen commit range', async () => {
  const host = mount(() => useChangeStoryDiff(story));
  await host.flush();
  expect(window.pantheon!.query).toHaveBeenCalledWith('change_story.diff', { story_id: 'story-a' });
  expect(host.value.data).toEqual(diff);
  vi.mocked(window.pantheon!.query).mockResolvedValueOnce({
    ok: true,
    value: { ...diff, to_sha: 'later' },
  });
  host.value.reload();
  host.render();
  await host.flush();
  expect(host.value.data).toBeNull();
  expect(host.value.error).toContain('读取结果不完整');
  vi.mocked(window.pantheon!.query).mockResolvedValueOnce({ ok: true, value: undefined });
  host.value.reload();
  host.render();
  await host.flush();
  expect(host.value.error).toContain('读取结果不完整');
});

it('drops the previous story diff immediately when the selected story changes', async () => {
  let selected = story;
  const host = mount(() => useChangeStoryDiff(selected));
  await host.flush();
  selected = { ...story, id: 'story-b', to_sha: 'newer' };
  vi.mocked(window.pantheon!.query).mockImplementationOnce(() => new Promise(() => {}));
  host.render();
  expect(host.value.data).toBeNull();
  expect(window.pantheon!.query).toHaveBeenLastCalledWith('change_story.diff', {
    story_id: 'story-b',
  });
});
