import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { appCsp, AppPages } from '../../apps/desktop/src/main/mcp-app.js';

const DEFAULT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; object-src 'none'";

it('uses the restrictive default policy when the app declares none', () => {
  expect(appCsp()).toBe(DEFAULT_CSP);
});

it('maps each declared domain list to its own directives', () => {
  const policy = appCsp({
    resourceDomains: ['https://cdn.example.com'],
    connectDomains: ['https://api.example.com', 'wss://live.example.com'],
    frameDomains: ['https://player.example.com'],
    baseUriDomains: ['https://base.example.com'],
  });
  const directives = new Map(
    policy.split('; ').map((part) => [part.split(' ')[0]!, part.slice(part.indexOf(' ') + 1)]),
  );
  expect(Object.fromEntries(directives)).toEqual({
    'default-src': "'none'",
    'script-src': "'self' 'unsafe-inline' https://cdn.example.com",
    'style-src': "'self' 'unsafe-inline' https://cdn.example.com",
    'img-src': "'self' data: https://cdn.example.com",
    'font-src': "'self' https://cdn.example.com",
    'media-src': "'self' data: https://cdn.example.com",
    'connect-src': 'https://api.example.com wss://live.example.com',
    'frame-src': 'https://player.example.com',
    'base-uri': 'https://base.example.com',
    'object-src': "'none'",
  });
  const empty = appCsp({});
  expect(empty).not.toContain('font-src');
  expect(empty).toContain("connect-src 'none'");
  expect(empty).toContain("frame-src 'none'");
  expect(empty).toContain("base-uri 'self'");
  expect(empty).toContain("default-src 'none'");
  expect(empty).toContain("object-src 'none'");
});

it('drops domain entries that could break out of a directive or are not https or wss', () => {
  const policy = appCsp({
    resourceDomains: [
      "https://a.example.com; script-src 'unsafe-eval'",
      'https://b.example.com,https://c.example.com',
      "https://'unsafe-eval'",
      'https://d.example.com https://e.example.com',
      'https://f.example.com\nscript-src *',
      'http://g.example.com',
      'javascript:alert(1)',
      'h.example.com',
      'https://*.example.com',
    ],
    connectDomains: ['"https://i.example.com"', 'wss://j.example.com'],
  });
  expect(policy).toContain("script-src 'self' 'unsafe-inline' https://*.example.com;");
  expect(policy).toContain('connect-src wss://j.example.com;');
  for (const dropped of ['unsafe-eval', 'b.example', 'c.example', 'd.example', 'f.example'])
    expect(policy).not.toContain(dropped);
  for (const dropped of ['g.example', 'javascript', 'h.example', 'i.example'])
    expect(policy).not.toContain(dropped);
});

it('drops domain entries with characters a header value cannot carry', () => {
  const policy = appCsp({
    resourceDomains: ['https://中文.example', 'https://a\u0000b.example', 'https://ok.example'],
  });
  expect(policy).toContain("script-src 'self' 'unsafe-inline' https://ok.example;");
  expect(policy).not.toContain('中文');
  expect(policy).not.toContain('a\u0000b');
  expect(() => new Headers({ 'Content-Security-Policy': policy })).not.toThrow();
});

it('lets an app page frame only the https origins its frameDomains name', () => {
  const pages = new AppPages();
  const owner = new EventEmitter() as BrowserWindow;
  const page = pages.serve(owner, {
    html: 'app',
    csp: { frameDomains: ['https://player.example.com'] },
  });
  const plain = pages.serve(owner, { html: 'plain' });
  expect(pages.frames(page, 'https://player.example.com/embed/1')).toBe(true);
  expect(pages.frames(page, 'http://player.example.com/')).toBe(false);
  expect(pages.frames(page, 'https://other.example.com/')).toBe(false);
  expect(pages.frames(plain, 'https://player.example.com/')).toBe(false);
});

it('serves each app page on its own origin with its policy header and evicts and releases pages', async () => {
  const pages = new AppPages();
  const owner = new EventEmitter() as BrowserWindow;
  const other = new EventEmitter() as BrowserWindow;
  const html = '<h1>App</h1>';
  const first = pages.serve(owner, { html, csp: { connectDomains: ['https://api.example.com'] } });
  const second = pages.serve(owner, { html: 'second' });
  expect(first.startsWith('pantheon-app://')).toBe(true);
  expect(new URL(first).host).not.toBe(new URL(second).host);
  expect(pages.owns(owner, first)).toBe(true);
  expect(pages.owns(other, first)).toBe(false);
  const response = await pages.respond({ url: first });
  expect(await response.text()).toBe(html);
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Content-Security-Policy')).toBe(
    appCsp({ connectDomains: ['https://api.example.com'] }),
  );
  expect((await pages.respond({ url: second })).headers.get('Content-Security-Policy')).toBe(
    DEFAULT_CSP,
  );
  for (const suffix of ['libraries/charts.js', 'index.html', 'other'])
    expect((await pages.respond({ url: first + suffix })).status).toBe(404);
  for (let index = 0; index < 199; index++) pages.serve(owner, { html: String(index) });
  expect((await pages.respond({ url: first })).status).toBe(404);
  expect((await pages.respond({ url: second })).status).toBe(200);
  pages.release(other, second);
  expect((await pages.respond({ url: second })).status).toBe(200);
  pages.release(owner, second);
  expect((await pages.respond({ url: second })).status).toBe(404);
  expect(pages.owns(owner, second)).toBe(false);
  const third = pages.serve(owner, { html: 'third' });
  owner.emit('closed');
  expect((await pages.respond({ url: third })).status).toBe(404);
});
