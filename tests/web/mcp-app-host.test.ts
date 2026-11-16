import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { App } from '../../apps/web/node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js';
import { InMemoryTransport } from '../../apps/web/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import { createAppHost, loadAppHost, type AppHostDeps } from '@/components/mcp-app/host';
import { hostStyles } from '@/components/mcp-app/host-styles';

type DisplayMode = 'inline' | 'fullscreen' | 'pip';
type Received = { method: string; params: unknown };

// Each view set up, closed after its test.
let apps: App[] = [];

function setup(
  views: {
    modes?: DisplayMode[];
    deps?: Partial<AppHostDeps>;
    permissions?: Parameters<typeof createAppHost>[0]['permissions'];
  } = {},
) {
  const deps = {
    sendMessage: vi.fn(async (_text: string) => {}),
    setModelContext: vi.fn(async (_text: string) => {}),
    userGesture: vi.fn(() => true),
    openLink: vi.fn(async (_url: string) => true),
    setDisplayMode: vi.fn((mode: DisplayMode) => mode),
    onSize: vi.fn(),
    log: vi.fn(),
    ...views.deps,
  };
  const host = createAppHost({
    toolCallId: 'call-weather',
    toolName: 'show_weather',
    server: 'weather',
    hostContext: {
      theme: 'light',
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { maxHeight: 600, width: 640 },
      locale: 'en-US',
      timeZone: 'Europe/London',
      platform: 'desktop',
      styles: { variables: { '--color-background-primary': '#fff' } },
    },
    csp: { connectDomains: ['https://api.example.com'] },
    permissions: views.permissions,
    deps,
  });
  const app = new App(
    { name: 'weather-view', version: '1.0.0' },
    views.modes ? { availableDisplayModes: views.modes } : {},
    { autoResize: false },
  );
  const received: Received[] = [];
  app.addEventListener('toolinput', (params) => received.push({ method: 'tool-input', params }));
  app.addEventListener('toolresult', (params) => received.push({ method: 'tool-result', params }));
  app.addEventListener('toolcancelled', (params) =>
    received.push({ method: 'tool-cancelled', params }),
  );
  const [hostSide, viewSide] = InMemoryTransport.createLinkedPair();
  const start = async () => {
    await host.connect(hostSide);
    await app.connect(viewSide);
  };
  apps.push(app);
  return { host, app, deps, received, start };
}

beforeAll(async () => {
  await loadAppHost();
});

const RESULT = { content: [{ type: 'text', text: 'Sunny' }], structuredContent: { temp: 21 } };

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps = [];
});

describe('MCP App host bridge', () => {
  it('answers the handshake with the host context and no server tools', async () => {
    const { app, start } = setup();
    await start();
    const context = app.getHostContext();
    expect(context?.theme).toBe('light');
    expect(context?.displayMode).toBe('inline');
    expect(context?.availableDisplayModes).toEqual(['inline', 'fullscreen']);
    expect(context?.platform).toBe('desktop');
    expect(context?.styles?.variables).toEqual({ '--color-background-primary': '#fff' });
    expect(context?.toolInfo).toMatchObject({ id: 'call-weather', tool: { name: 'show_weather' } });
    const capabilities = app.getHostCapabilities();
    expect(capabilities?.serverTools).toBeUndefined();
    expect(capabilities?.serverResources).toBeUndefined();
    expect(capabilities?.openLinks).toEqual({});
    expect(capabilities?.sandbox?.csp).toEqual({ connectDomains: ['https://api.example.com'] });
  });

  it('names the host with the web package version in the handshake', async () => {
    const { version } = JSON.parse(readFileSync('apps/web/package.json', 'utf8'));
    const { app, start } = setup();
    await start();
    expect(app.getHostVersion()).toEqual({ name: 'Pantheon', version });
  });

  it('keeps a context change made before the view starts for its handshake', async () => {
    const { host, app, start } = setup();
    host.setContext({ theme: 'dark' });
    await start();
    expect(app.getHostContext()?.theme).toBe('dark');
    const changed = new Promise((resolve) => app.addEventListener('hostcontextchanged', resolve));
    host.setContext({ displayMode: 'fullscreen' });
    expect(await changed).toEqual({ displayMode: 'fullscreen' });
  });

  it('holds tool input and result until the view is initialized, then sends each once', async () => {
    const { host, app, received, start } = setup();
    host.feed({ input: { city: 'London' } });
    host.feed({ result: { ok: true, app_result: RESULT } });
    expect(received).toEqual([]);
    await start();
    await vi.waitFor(() => expect(received).toHaveLength(2));
    host.feed({ result: { ok: true, app_result: RESULT } });
    host.feed({ input: { city: 'Paris' } });
    await app.requestDisplayMode({ mode: 'inline' });
    expect(received).toEqual([
      { method: 'tool-input', params: { arguments: { city: 'London' } } },
      { method: 'tool-result', params: RESULT },
    ]);
  });

  it('cancels the view when the tool fails without a result for it', async () => {
    const { host, app, received, start } = setup();
    await start();
    host.feed({ input: { city: 'London' } });
    host.feed({ result: { ok: false } });
    await vi.waitFor(() => expect(received).toHaveLength(2));
    await app.requestDisplayMode({ mode: 'inline' });
    expect(received.map((entry) => entry.method)).toEqual(['tool-input', 'tool-cancelled']);
  });

  it('turns ui/message content, one block or a list, into one message', async () => {
    const { app, deps, start } = setup();
    await start();
    expect(
      await app.sendMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'Plan a trip' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'to London' },
        ],
      }),
    ).toEqual({});
    expect(
      await app.sendMessage({
        role: 'user',
        content: { type: 'text', text: 'Book it' },
      } as never),
    ).toEqual({});
    expect(vi.mocked(deps.sendMessage).mock.calls).toEqual([
      ['Plan a trip\n\nto London'],
      ['Book it'],
    ]);
    expect(
      await app.sendMessage({
        role: 'user',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      }),
    ).toEqual({ isError: true });
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports a message the session refused as an error', async () => {
    const { app, start } = setup({
      deps: { sendMessage: vi.fn(async () => Promise.reject(new Error('session ended'))) },
    });
    await start();
    expect(
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Hi' }] }),
    ).toEqual({ isError: true });
  });

  it('gives the model context text and structured content as JSON', async () => {
    const { app, deps, start } = setup();
    await start();
    expect(
      await app.updateModelContext({
        content: [{ type: 'text', text: 'Viewing London' }],
        structuredContent: { city: 'London', days: 3 },
      }),
    ).toEqual({});
    expect(deps.setModelContext).toHaveBeenCalledWith(
      'Viewing London\n\n{"city":"London","days":3}',
    );
  });

  it('refuses tool calls from the view and forwards nothing', async () => {
    const { app, deps, start } = setup();
    await start();
    await expect(app.callServerTool({ name: 'show_weather', arguments: {} })).rejects.toThrow(
      /tool/i,
    );
    for (const dep of Object.values(deps)) expect(dep).not.toHaveBeenCalled();
  });

  it('lets the view call tools of its server when the host can', async () => {
    const callTool = vi.fn<NonNullable<AppHostDeps['callTool']>>(async () => ({
      content: [{ type: 'text', text: 'Sunny' }],
      structuredContent: { temp: 21 },
    }));
    const { app, start } = setup({ deps: { callTool } });
    await start();
    expect(app.getHostCapabilities()?.serverTools).toEqual({});
    expect(await app.callServerTool({ name: 'refresh', arguments: { week: 2 } })).toEqual(RESULT);
    expect(callTool).toHaveBeenCalledWith('refresh', { week: 2 });
  });

  it('answers a tool call the host refused with an error', async () => {
    const callTool = vi.fn<NonNullable<AppHostDeps['callTool']>>(async () =>
      Promise.reject(new Error('refresh is not callable')),
    );
    const { app, start } = setup({ deps: { callTool } });
    await start();
    await expect(app.callServerTool({ name: 'refresh', arguments: {} })).rejects.toThrow(
      'refresh is not callable',
    );
  });

  it('switches display mode only to one both sides list', async () => {
    const declared = setup({ modes: ['inline', 'fullscreen'] });
    await declared.start();
    expect(await declared.app.requestDisplayMode({ mode: 'fullscreen' })).toEqual({
      mode: 'fullscreen',
    });
    expect(declared.deps.setDisplayMode).toHaveBeenCalledWith('fullscreen');
    expect(await declared.app.requestDisplayMode({ mode: 'pip' })).toEqual({ mode: 'fullscreen' });
    expect(declared.deps.setDisplayMode).toHaveBeenCalledTimes(1);

    const undeclared = setup();
    await undeclared.start();
    expect(await undeclared.app.requestDisplayMode({ mode: 'fullscreen' })).toEqual({
      mode: 'inline',
    });
    expect(undeclared.deps.setDisplayMode).not.toHaveBeenCalled();
  });

  it('answers a refused link with an error', async () => {
    const { app, deps, start } = setup({ deps: { openLink: vi.fn(async () => false) } });
    await start();
    await expect(app.openLink({ url: 'file:///etc/passwd' })).rejects.toMatchObject({
      code: -32000,
    });
    expect(deps.openLink).toHaveBeenCalledWith('file:///etc/passwd');
  });

  it('refuses a link the user did not click or type for in the frame', async () => {
    const { app, deps, start } = setup({ deps: { userGesture: vi.fn(() => false) } });
    await start();
    await expect(app.openLink({ url: 'https://example.com/' })).rejects.toMatchObject({
      code: -32000,
    });
    expect(deps.openLink).not.toHaveBeenCalled();
  });

  it('tells the view it has no camera, microphone or location', async () => {
    const { app, start } = setup({
      permissions: { camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} },
    });
    await start();
    expect(app.getHostCapabilities()?.sandbox?.permissions).toEqual({ clipboardWrite: {} });
  });

  it('hands log messages and size changes to the host', async () => {
    const { app, deps, start } = setup();
    await start();
    await app.sendLog({ level: 'info', logger: 'view', data: 'ready' });
    await app.sendSizeChanged({ width: 320, height: 240 });
    await vi.waitFor(() => expect(deps.onSize).toHaveBeenCalledWith(320, 240));
    expect(deps.log).toHaveBeenCalledWith({
      server: 'weather',
      level: 'info',
      logger: 'view',
      data: 'ready',
    });
  });

  it('sends teardown and closes once the view answers', async () => {
    const { host, app, start } = setup();
    const teardown = vi.fn(async () => ({}));
    app.onteardown = teardown;
    const closed = vi.fn();
    app.onclose = closed;
    await start();
    await host.teardown();
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalled();
  });

  it('stops waiting for a silent view within 500 ms', async () => {
    const { host, app, start } = setup();
    const teardown = vi.fn(() => new Promise<Record<string, never>>(() => {}));
    app.onteardown = teardown;
    const closed = vi.fn();
    app.onclose = closed;
    await start();
    const began = Date.now();
    await host.teardown();
    expect(Date.now() - began).toBeLessThan(700);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalled();
  });
});

describe('hostStyles', () => {
  it('maps the app tokens to the standard names and leaves out empty ones', () => {
    const tokens: Record<string, string> = {
      '--sf': '#FFFFFF',
      '--tx': ' #1A1A18',
      '--bd': 'rgba(20,20,18,.14)',
      '--focus-ring': '#1A1A18',
      '--font-sans': "'Geist Variable', sans-serif",
      '--fs-sm': '13px',
      '--r-md': '10px',
    };
    const styles = hostStyles((token) => tokens[token] ?? '');
    expect(styles).toEqual({
      '--color-background-primary': '#FFFFFF',
      '--color-text-primary': '#1A1A18',
      '--color-border-primary': 'rgba(20,20,18,.14)',
      '--color-ring-primary': '#1A1A18',
      '--font-sans': "'Geist Variable', sans-serif",
      '--font-text-sm-size': '13px',
      '--border-radius-md': '10px',
    });
  });
});
