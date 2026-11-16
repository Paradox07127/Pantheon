import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

// Only a plain https origin goes into the policy header.
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/;

/** Whether hosts is a list of https origins a page may be allowed to reach. */
export const visualHosts = (hosts: unknown): hosts is string[] =>
  Array.isArray(hosts) &&
  hosts.every((host) => typeof host === 'string' && HTTPS_ORIGIN.test(host));

export class VisualPages {
  private pages = new Map<string, { owner: BrowserWindow; html: string; hosts: string[] }>();
  private windows = new Map<BrowserWindow, Set<string>>();

  constructor(private libraries: string) {}

  /** hosts must have passed visualHosts. */
  serve(owner: BrowserWindow, html: string, hosts: string[] = []): { url: string } {
    let own = this.windows.get(owner);
    if (!own) {
      own = new Set();
      this.windows.set(owner, own);
      owner.once('closed', () => {
        for (const id of this.windows.get(owner)!) this.pages.delete(id);
        this.windows.delete(owner);
      });
    }
    // Each window retains at most 200 pages, in creation order.
    if (own.size === 200) {
      const oldest = own.values().next().value!;
      own.delete(oldest);
      this.pages.delete(oldest);
    }
    const id = randomUUID();
    own.add(id);
    this.pages.set(id, { owner, html, hosts });
    return { url: `pantheon-visual://${id}/` };
  }

  owns(owner: BrowserWindow, url: string): boolean {
    const parsed = new URL(url);
    return parsed.protocol === 'pantheon-visual:' && this.pages.get(parsed.host)?.owner === owner;
  }

  async respond(request: { url: string }): Promise<Response> {
    const url = new URL(request.url);
    const page = this.pages.get(url.host);
    if (!page) return new Response(null, { status: 404 });
    if (url.pathname === '/libraries/charts.js')
      return new Response(new Uint8Array(await readFile(path.join(this.libraries, 'charts.js'))), {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    if (url.pathname !== '/') return new Response(null, { status: 404 });
    // Each allowed host opens every kind of request to it alone.
    const at = page.hosts.map((host) => ` ${host}`).join('');
    return new Response(page.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // No self wildcard: only the chart bundle may supply external script, never another page.
        'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline' pantheon-visual://${url.host}/libraries/charts.js${at}; style-src 'unsafe-inline'${at}; img-src${at} data: blob:; font-src${at} data:${at ? `; connect-src${at}` : ''}; base-uri 'none'; form-action 'none'`,
      },
    });
  }
}
