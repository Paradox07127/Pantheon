import { expect, it } from 'vitest';
import {
  APP_DOM_LIMIT,
  appDebugTools,
  inputSchemas,
  leadToolEffects,
  sessionTools,
  type CommandType,
} from '@pantheon/protocol';

const parses = (type: CommandType, input: unknown) => inputSchemas[type].safeParse(input).success;

it.each([
  ['app.errors', {}, true],
  ['app.errors', { extra: 1 }, false],
  ['app.screenshot', {}, true],
  ['app.screenshot', { selector: 'main' }, false],
  ['app.dom', {}, true],
  ['app.dom', { selector: '[data-debug-region="sidebar"]' }, true],
  ['app.dom', { selector: '' }, false],
  ['app.dom', { selector: 'a'.repeat(200) }, true],
  ['app.dom', { selector: 'a'.repeat(201) }, false],
  ['app.logs', {}, true],
  ['app.logs', { lines: 1, grep: 'error' }, true],
  ['app.logs', { lines: 500 }, true],
  ['app.logs', { lines: 0 }, false],
  ['app.logs', { lines: 501 }, false],
  ['app.logs', { lines: 2.5 }, false],
  ['app.logs', { grep: '' }, false],
  ['app.logs', { grep: 'x'.repeat(201) }, false],
] as const)('parses %s %j: %s', (type, input, ok) => {
  expect(parses(type, input)).toBe(ok);
});

it('fills in the default number of log lines', () => {
  expect(inputSchemas['app.logs'].parse({})).toEqual({ lines: 200 });
});

it('takes an app answer as errors, a dom or a page, and only one of them', () => {
  const result = inputSchemas['browser.result'];
  const dom = {
    html: '<main data-debug-region="board"></main>',
    regions: [{ name: 'board', rect: { x: 0, y: 40, width: 800, height: 600 } }],
  };
  expect(result.safeParse({ request_id: 'r', errors: [{ message: 'boom' }] }).success).toBe(true);
  expect(result.safeParse({ request_id: 'r', errors: [] }).success).toBe(true);
  expect(result.safeParse({ request_id: 'r', dom }).success).toBe(true);
  expect(
    result.safeParse({ request_id: 'r', dom: { ...dom, html: 'x'.repeat(APP_DOM_LIMIT + 1) } })
      .success,
  ).toBe(false);
  expect(
    result.safeParse({ request_id: 'r', dom: { ...dom, regions: [{ name: 'board' }] } }).success,
  ).toBe(false);
  expect(result.safeParse({ request_id: 'r', errors: ['boom'] }).success).toBe(false);
  expect(result.safeParse({ request_id: 'r', errors: [], dom }).success).toBe(false);
  expect(
    result.safeParse({
      request_id: 'r',
      dom,
      error: { code: 'browser_not_open', message: 'No window' },
    }).success,
  ).toBe(false);
});

it('offers the app tools to every role an app debug session can have, but not to reviewers', () => {
  expect(appDebugTools).toEqual({
    app_errors: 'app.errors',
    app_screenshot: 'app.screenshot',
    app_dom: 'app.dom',
    app_logs: 'app.logs',
  });
  for (const role of ['planner', 'lead', 'worker'] as const)
    expect(sessionTools[role], role).toMatchObject(appDebugTools);
  expect(Object.values(sessionTools.reviewer)).not.toContain('app.errors');
  expect(leadToolEffects).toMatchObject({
    app_errors: 'read',
    app_screenshot: 'read',
    app_dom: 'read',
    app_logs: 'read',
  });
});
