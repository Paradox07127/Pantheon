import { expect, it } from 'vitest';
import {
  APP_DOM_LIMIT,
  USER_STYLE_LIMIT,
  appDebugTools,
  inputSchemas,
  leadToolEffects,
  querySchemas,
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
  ['style.read', {}, true],
  ['style.read', { css: '' }, false],
  ['style.set', { css: '' }, true],
  ['style.set', { css: '[data-debug-region="sidebar"]{width:240px}' }, true],
  ['style.set', { css: 'a{background:url(data:image/png;base64,AAAA)}' }, true],
  ['style.set', { css: "a{background:url( 'DATA:image/png;base64,AAAA')}" }, true],
  ['style.set', { css: 'x'.repeat(USER_STYLE_LIMIT) }, true],
  ['style.set', { css: 'x'.repeat(USER_STYLE_LIMIT + 1) }, false],
  ['style.set', { css: '@import "https://example.com/a.css";' }, false],
  ['style.set', { css: '@IMPORT url(data:text/css,a{})' }, false],
  ['style.set', { css: 'a{background:url(https://example.com/a.png)}' }, false],
  ['style.set', { css: 'a{background:image-set("https://example.com/a.png" 1x)}' }, false],
  ['style.set', { css: 'a{background:-webkit-image-set("https://example.com/a.png" 1x)}' }, false],
  ['style.set', { css: 'a{background:url("//example.com/a.png")}' }, false],
  ['style.set', { css: 'a{background:url(a.png)}' }, false],
  ['style.set', { css: 'a{background:u\\72l(https://example.com/a.png)}' }, false],
  ['style.set', {}, false],
  ['style.enable', { enabled: false }, true],
  ['style.enable', { enabled: 'no' }, false],
  ['style.enable', {}, false],
  ['style.clear', {}, true],
  ['style.clear', { css: '' }, false],
] as const)('parses %s %j: %s', (type, input, ok) => {
  expect(parses(type, input)).toBe(ok);
});

it('fills in the default number of log lines', () => {
  expect(inputSchemas['app.logs'].parse({})).toEqual({ lines: 200 });
});

it('reads the user stylesheet as a query with no parameters', () => {
  expect(querySchemas['style.read'].safeParse({}).success).toBe(true);
  expect(querySchemas['style.read'].safeParse({ revision: '1' }).success).toBe(false);
});

it('names why a stylesheet that would load from outside is refused', () => {
  const result = inputSchemas['style.set'].safeParse({
    css: '@import "x.css"; a{background:url(https://example.com/a.png)}',
  });
  expect(result.success).toBe(false);
  expect(result.error!.issues.map((issue) => issue.message)).toEqual([
    'stylesheet uses @import',
    'stylesheet url(https://example.com/a.png) must be a data: URL',
  ]);
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
    style_read: 'style.read',
    style_set: 'style.set',
  });
  for (const role of ['planner', 'lead', 'worker'] as const)
    expect(sessionTools[role], role).toMatchObject(appDebugTools);
  expect(Object.values(sessionTools.reviewer)).not.toContain('app.errors');
  expect(leadToolEffects).toMatchObject({
    app_errors: 'read',
    app_screenshot: 'read',
    app_dom: 'read',
    app_logs: 'read',
    style_read: 'read',
    style_set: 'write',
  });
});
