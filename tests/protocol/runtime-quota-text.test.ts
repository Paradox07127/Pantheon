import { expect, it } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { setLocaleSync } from '@/i18n';
import { blockerTexts } from '@/lib/daemon-text';
import { zhCatalog } from '../web/i18n-setup.js';

it('translates the runtime quota wait code in English and Simplified Chinese', () => {
  const row = {
    blockers: ['Queued: waiting for runtime quota'],
    blocker_codes: [{ code: 'queued' }],
    dispatch_wait: 'runtime_limited',
  } as Pick<BoardModel['tasks'][number], 'blockers' | 'blocker_codes' | 'dispatch_wait'>;
  setLocaleSync('en', {});
  expect(blockerTexts(row)).toEqual(['Queued: waiting for runtime quota']);
  setLocaleSync('zh-CN', zhCatalog());
  expect(blockerTexts(row)).toEqual(['排队中：等待运行时额度恢复']);
});
