import { expect, it, vi } from 'vitest';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const APP_MIME = 'text/html;profile=mcp-app';

async function liveSession(contents?: unknown[]) {
  const f = await workbenchFixture();
  const readMcpResource = vi.fn(async () => ({ contents }));
  if (contents) Object.assign(f.adapter, { readMcpResource });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.control.handles.size > 0,
    () => f.control.tick(),
  );
  const read = () =>
    f.control.mcpAppResource(user, {
      session_id: session.id,
      server: 'charts',
      uri: 'ui://charts/plot',
    });
  return { f, read, readMcpResource };
}

it('returns the HTML text of the interface item through the live session', async () => {
  const { f, read, readMcpResource } = await liveSession([
    { uri: 'ui://charts/plot', mimeType: 'text/plain', text: 'not this' },
    { uri: 'ui://charts/plot', mimeType: APP_MIME, text: '<p>chart</p>' },
  ]);
  expect(await read()).toEqual({ html: '<p>chart</p>', tool_calls: false });
  expect(readMcpResource).toHaveBeenCalledWith(
    [...f.control.handles.values()][0],
    'charts',
    'ui://charts/plot',
  );
});

it('decodes a base64 blob as UTF-8', async () => {
  const { read } = await liveSession([
    {
      uri: 'ui://charts/plot',
      mimeType: APP_MIME,
      blob: Buffer.from('<p>图表</p>').toString('base64'),
    },
  ]);
  expect(await read()).toEqual({ html: '<p>图表</p>', tool_calls: false });
});

it('refuses a resource without interface content', async () => {
  const { read } = await liveSession([
    { uri: 'ui://charts/plot', mimeType: 'text/html', text: '<p>chart</p>' },
  ]);
  await expect(read()).rejects.toMatchObject({ code: 'invalid_input' });
});

it('keeps only the known sandbox settings of the item _meta.ui', async () => {
  const { read } = await liveSession([
    {
      uri: 'ui://charts/plot',
      mimeType: APP_MIME,
      text: '<p>chart</p>',
      _meta: {
        ui: {
          csp: {
            connectDomains: ['https://api.example'],
            resourceDomains: ['https://cdn.example'],
            frameDomains: ['https://frame.example'],
            baseUriDomains: ['https://base.example'],
            scriptDomains: ['https://other.example'],
            imgDomains: 'https://img.example',
          },
          permissions: { camera: {}, clipboardWrite: {}, usb: {} },
          prefersBorder: false,
          domain: 'charts.example',
          visibility: ['app'],
        },
        other: { key: 'value' },
      },
    },
  ]);
  expect(await read()).toEqual({
    html: '<p>chart</p>',
    csp: {
      connectDomains: ['https://api.example'],
      resourceDomains: ['https://cdn.example'],
      frameDomains: ['https://frame.example'],
      baseUriDomains: ['https://base.example'],
    },
    permissions: { camera: {}, clipboardWrite: {} },
    prefers_border: false,
    domain: 'charts.example',
    tool_calls: false,
  });
});

it('reports an adapter that cannot read interface resources', async () => {
  const { read } = await liveSession();
  await expect(read()).rejects.toMatchObject({ code: 'unsupported_capability' });
});
