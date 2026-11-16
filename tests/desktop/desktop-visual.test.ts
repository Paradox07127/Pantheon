import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { visualHosts, VisualPages } from '../../apps/desktop/src/main/visual.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('serves the local chart bundle through each live page origin and refuses other files and expired origins', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-visual-'));
  roots.push(root);
  writeFileSync(path.join(root, 'charts.js'), 'window.PantheonCharts = {};');
  const pages = new VisualPages(root);
  const owner = new EventEmitter() as BrowserWindow;
  const other = new EventEmitter() as BrowserWindow;
  const { url } = pages.serve(owner, '<h1>Visual</h1>');
  expect(pages.owns(owner, url)).toBe(true);
  expect(pages.owns(other, url)).toBe(false);
  const asset = await pages.respond({ url: url + 'libraries/charts.js' });
  expect(asset.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
  expect(await asset.text()).toBe('window.PantheonCharts = {};');
  for (const suffix of [
    'charts.js',
    'libraries/private.js',
    'libraries/%2e%2e/private',
    'libraries/charts.js/extra',
  ])
    expect((await pages.respond({ url: url + suffix })).status).toBe(404);
  owner.emit('closed');
  expect(pages.owns(owner, url)).toBe(false);
  expect((await pages.respond({ url: url + 'libraries/charts.js' })).status).toBe(404);
});

it('accepts only https origins as hosts a page may reach', () => {
  expect(visualHosts([])).toBe(true);
  expect(visualHosts(['https://cdn.example.com', 'https://api.example.com:8443'])).toBe(true);
  for (const hosts of [
    ['http://cdn.example.com'],
    ['cdn.example.com'],
    ['https://cdn.example.com/path'],
    ["https://cdn.example.com; script-src 'unsafe-eval'"],
    ['https://*'],
    [1],
    'https://cdn.example.com',
    null,
  ])
    expect(visualHosts(hosts)).toBe(false);
});

it('opens the allowed hosts in the policy of that page only', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-visual-'));
  roots.push(root);
  const pages = new VisualPages(root);
  const owner = new EventEmitter() as BrowserWindow;
  const policy = async (url: string) =>
    (await pages.respond({ url })).headers.get('Content-Security-Policy')!;
  const offline = await policy(pages.serve(owner, '<p>offline</p>').url);
  expect(offline).not.toContain('connect-src');
  expect(offline).not.toContain('https:');
  const allowed = await policy(
    pages.serve(owner, '<p>online</p>', ['https://cdn.example.com']).url,
  );
  expect(allowed).toContain('connect-src https://cdn.example.com');
  expect(allowed).toContain('img-src https://cdn.example.com data: blob:');
  expect(allowed).toContain('font-src https://cdn.example.com data:');
  expect(allowed).toContain("style-src 'unsafe-inline' https://cdn.example.com");
  expect(allowed).toMatch(/script-src [^;]*charts\.js https:\/\/cdn\.example\.com;/);
  expect(allowed).toContain("default-src 'none'");
});
