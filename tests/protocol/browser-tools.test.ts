import { expect, it } from 'vitest';
import {
  BROWSER_TEXT_LIMIT,
  inputSchemas,
  leadToolEffects,
  sessionTools,
} from '@pantheon/protocol';

it('accepts only http and https addresses for the page a session opens', () => {
  const open = inputSchemas['browser.open'];
  for (const url of ['http://localhost:3000/', 'https://example.com/docs?q=1'])
    expect(open.safeParse({ url }).success, url).toBe(true);
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hello',
    'chrome://settings',
    'ftp://example.com/file',
    'example.com',
  ])
    expect(open.safeParse({ url }).success, url).toBe(false);
  expect(open.safeParse({ url: 'https://example.com', extra: 1 }).success).toBe(false);
});

it('offers the browser tools to conversation, lead and task sessions but not to reviewers', () => {
  const browserTools = {
    browser_open: 'browser.open',
    browser_read: 'browser.read',
    browser_screenshot: 'browser.screenshot',
  };
  for (const role of ['planner', 'lead', 'worker'] as const)
    expect(sessionTools[role], role).toMatchObject(browserTools);
  expect(Object.values(sessionTools.reviewer)).not.toContain('browser.open');
  expect(leadToolEffects).toMatchObject({
    browser_open: 'write',
    browser_read: 'read',
    browser_screenshot: 'read',
  });
});

it('takes a desktop answer with a page or an error, and page text within the limit', () => {
  const result = inputSchemas['browser.result'];
  const page = { url: 'https://example.com/', title: 'Example' };
  expect(result.safeParse({ request_id: 'r', page }).success).toBe(true);
  expect(
    result.safeParse({ request_id: 'r', error: { code: 'browser_not_open', message: 'No page' } })
      .success,
  ).toBe(true);
  expect(result.safeParse({ request_id: 'r' }).success).toBe(false);
  expect(
    result.safeParse({
      request_id: 'r',
      page: { ...page, text: 'x'.repeat(BROWSER_TEXT_LIMIT), truncated: true },
    }).success,
  ).toBe(true);
  expect(
    result.safeParse({
      request_id: 'r',
      page: { ...page, text: 'x'.repeat(BROWSER_TEXT_LIMIT + 1) },
    }).success,
  ).toBe(false);
});
