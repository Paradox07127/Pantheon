import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startDaemon } from '@pantheon/daemon';
import { command, USER_PRINCIPAL_ID, type BrowserRequest } from '@pantheon/protocol';
import type { Project, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { user } from '../helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A daemon with one open conversation session and the session's MCP tools client. */
async function sessionTools(extra: Partial<Session> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-browser-tools-'));
  mkdirSync(path.join(root, 'project'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60_000,
  });
  cleanup.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'browser', roots: [path.join(root, 'project')] }),
  )) as Project;
  const session = daemon.store.insert<Session>('sessions', {
    id: 'browsing-session',
    revision: 1,
    project_id: project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    ...extra,
  });
  const ctx = (daemon.control as unknown as { ctx: ControlContext }).ctx;
  const credential = ctx.issueSessionCredential!(session.id, 'planner');
  const client = new Client({ name: 'browser-tools-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
      env: {
        ...(process.env as Record<string, string>),
        PANTHEON_DAEMON_URL: credential.daemon_url,
        PANTHEON_SESSION_TOKEN_FILE: credential.token_file,
      },
    }),
  );
  cleanup.push(() => client.close());
  return { daemon, session, client };
}

/** Subscribes to the event socket as the app's windows do; browser makes it the window that answers. */
async function desktopWindow(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  answer?: (request: BrowserRequest) => Record<string, unknown>,
) {
  const socket = new WebSocket(daemon.url.replace('http:', 'ws:') + '/v1/events/ws');
  const requests: BrowserRequest[] = [];
  const subscribed = new Promise<void>((resolve) =>
    socket.addEventListener('message', (e) => {
      const frame = JSON.parse(String(e.data));
      if (frame.type === 'subscribed') resolve();
      if (frame.type !== 'browser.request' || !answer) return;
      requests.push(frame.request);
      void fetch(new URL('/v1/commands', daemon.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          command(USER_PRINCIPAL_ID, 'browser.result', {
            request_id: frame.request.request_id,
            ...answer(frame.request),
          }),
        ),
      });
    }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(
    JSON.stringify({ token: daemon.token, cursor: daemon.store.cursor(), browser: !!answer }),
  );
  await subscribed;
  cleanup.push(async () => socket.close());
  return requests;
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { type: string; text?: string }[]).find((part) => part.type === 'text')!.text!;

it('opens the page in the desktop window and returns the url and title it ended on', async () => {
  const f = await sessionTools();
  const requests = await desktopWindow(f.daemon, () => ({
    page: { url: 'https://example.com/landing', title: 'Example' },
  }));
  const opened = await f.client.callTool({
    name: 'browser_open',
    arguments: { url: 'https://example.com/' },
  });
  expect(opened.isError, text(opened)).toBeFalsy();
  expect(text(opened)).toBe('URL: https://example.com/landing\nTitle: Example');
  expect(requests).toEqual([
    {
      request_id: expect.any(String),
      session_id: f.session.id,
      action: 'open',
      url: 'https://example.com/',
    },
  ]);
});

it('returns the page text with a note when it was cut, and the screenshot as a PNG image', async () => {
  const f = await sessionTools();
  const requests = await desktopWindow(f.daemon, (request) => ({
    page:
      request.action === 'read'
        ? { url: 'https://example.com/', title: 'Example', text: 'Hello', truncated: true }
        : { url: 'https://example.com/', title: 'Example', png: PIXEL },
  }));
  const read = await f.client.callTool({ name: 'browser_read', arguments: {} });
  expect(read.isError, text(read)).toBeFalsy();
  expect(text(read)).toBe(
    'URL: https://example.com/\nTitle: Example\n\nHello\n\n[Text truncated at 50000 characters]',
  );
  const shot = await f.client.callTool({ name: 'browser_screenshot', arguments: {} });
  expect(shot.isError, text(shot)).toBeFalsy();
  expect(shot.content).toEqual([
    { type: 'image', data: PIXEL, mimeType: 'image/png' },
    { type: 'text', text: 'URL: https://example.com/\nTitle: Example' },
  ]);
  expect(requests.map((request) => request.action)).toEqual(['read', 'screenshot']);
});

it('passes on the reason the desktop window could not answer', async () => {
  const f = await sessionTools();
  await desktopWindow(f.daemon, () => ({
    error: { code: 'browser_not_open', message: 'No page is open' },
  }));
  const read = await f.client.callTool({ name: 'browser_read', arguments: {} });
  expect(read.isError).toBe(true);
  expect(text(read)).toBe('Refused browser_read: browser_not_open — No page is open');
});

it('refuses every browser tool at once while no desktop window answers browser requests', async () => {
  const f = await sessionTools();
  // A window that only follows events, as the web app does, does not answer them.
  await desktopWindow(f.daemon);
  for (const [name, args] of [
    ['browser_open', { url: 'https://example.com/' }],
    ['browser_read', {}],
    ['browser_screenshot', {}],
  ] as const) {
    const started = Date.now();
    const result = await f.client.callTool({ name, arguments: args });
    expect(result.isError, name).toBe(true);
    expect(text(result)).toMatch(
      /^Refused browser_\w+: browser_unavailable — browser unavailable: no desktop window is connected$/,
    );
    expect(Date.now() - started, name).toBeLessThan(5000);
  }
});

it('refuses a page that is not http or https without asking the desktop window', async () => {
  const f = await sessionTools();
  const requests = await desktopWindow(f.daemon, () => ({
    page: { url: 'file:///etc/passwd', title: '' },
  }));
  const opened = await f.client.callTool({
    name: 'browser_open',
    arguments: { url: 'file:///etc/passwd' },
  });
  expect(opened.isError).toBe(true);
  expect(text(opened)).toMatch(/^Refused browser_open: invalid_request/);
  expect(requests).toEqual([]);
});

const appTools = ['app_errors', 'app_screenshot', 'app_dom', 'app_logs'];

it('lists the app tools to an app debug session only', async () => {
  const names = async (extra: Partial<Session>) => {
    const f = await sessionTools(extra);
    return (await f.client.listTools()).tools.map((tool) => tool.name);
  };
  expect(await names({ app_debug: true })).toEqual(expect.arrayContaining(appTools));
  const ordinary = await names({});
  for (const name of appTools) expect(ordinary).not.toContain(name);
  expect(ordinary).toContain('browser_read');
});

it('asks the desktop window for the app errors, its DOM and a screenshot and returns its answers', async () => {
  const f = await sessionTools({ app_debug: true });
  const dom = {
    html: '<aside data-debug-region="sidebar"></aside>',
    regions: [{ name: 'sidebar', rect: { x: 0, y: 0, width: 240, height: 800 } }],
  };
  const errors = [{ message: 'Cannot read properties of undefined', at: 1 }];
  const requests = await desktopWindow(f.daemon, (request) =>
    request.action === 'app_errors'
      ? { errors }
      : request.action === 'app_dom'
        ? { dom }
        : { page: { url: 'app://pantheon/', title: 'Pantheon', png: PIXEL } },
  );
  const read = await f.client.callTool({ name: 'app_errors', arguments: {} });
  expect(read.isError, text(read)).toBeFalsy();
  expect(JSON.parse(text(read))).toEqual(errors);
  const region = await f.client.callTool({
    name: 'app_dom',
    arguments: { selector: '[data-debug-region="sidebar"]' },
  });
  expect(region.isError, text(region)).toBeFalsy();
  expect(JSON.parse(text(region))).toEqual(dom);
  const shot = await f.client.callTool({ name: 'app_screenshot', arguments: {} });
  expect(shot.isError, text(shot)).toBeFalsy();
  expect(shot.content).toEqual([
    { type: 'image', data: PIXEL, mimeType: 'image/png' },
    { type: 'text', text: 'URL: app://pantheon/\nTitle: Pantheon' },
  ]);
  expect(requests).toEqual([
    { request_id: expect.any(String), session_id: f.session.id, action: 'app_errors' },
    {
      request_id: expect.any(String),
      session_id: f.session.id,
      action: 'app_dom',
      selector: '[data-debug-region="sidebar"]',
    },
    { request_id: expect.any(String), session_id: f.session.id, action: 'app_screenshot' },
  ]);
});

it('refuses a window answer that does not fit the app request', async () => {
  const f = await sessionTools({ app_debug: true });
  await desktopWindow(f.daemon, () => ({ page: { url: 'app://pantheon/', title: 'Pantheon' } }));
  const region = await f.client.callTool({ name: 'app_dom', arguments: {} });
  expect(region.isError).toBe(true);
  expect(text(region)).toBe(
    'Refused app_dom: browser_invalid_answer — The desktop window answered app_dom without dom',
  );
});

it('refuses every app window tool at once while no desktop window answers browser requests', async () => {
  const f = await sessionTools({ app_debug: true });
  await desktopWindow(f.daemon);
  for (const name of ['app_errors', 'app_screenshot', 'app_dom']) {
    const result = await f.client.callTool({ name, arguments: {} });
    expect(result.isError, name).toBe(true);
    expect(text(result)).toBe(
      `Refused ${name}: browser_unavailable — browser unavailable: no desktop window is connected`,
    );
  }
});
