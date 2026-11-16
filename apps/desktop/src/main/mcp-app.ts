import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';

export interface AppCspInput {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

// An https or wss source of printable ASCII, which a header can carry, with nothing that could end the directive or add another source.
const APP_SOURCE = /^(https|wss):\/\/(?:(?![;,'"`])[!-~])+$/;

const sources = (domains: string[] = []): string =>
  domains
    .filter((domain) => APP_SOURCE.test(domain))
    .map((domain) => ` ${domain}`)
    .join('');

/** The Content-Security-Policy of an MCP App page; without csp it is the spec default. */
export const appCsp = (csp?: AppCspInput): string => {
  if (!csp)
    return "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; object-src 'none'";
  const resource = sources(csp.resourceDomains);
  const connect = sources(csp.connectDomains);
  const frame = sources(csp.frameDomains);
  const base = sources(csp.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline'${resource}`,
    `style-src 'self' 'unsafe-inline'${resource}`,
    `img-src 'self' data:${resource}`,
    ...(resource ? [`font-src 'self'${resource}`] : []),
    `media-src 'self' data:${resource}`,
    `connect-src${connect || " 'none'"}`,
    `frame-src${frame || " 'none'"}`,
    `base-uri${base || " 'self'"}`,
    "object-src 'none'",
  ].join('; ');
};

export class AppPages {
  private pages = new Map<string, { owner: BrowserWindow; html: string; csp?: AppCspInput }>();
  private windows = new Map<BrowserWindow, Set<string>>();

  serve(owner: BrowserWindow, input: { html: string; csp?: AppCspInput }): string {
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
    this.pages.set(id, { owner, html: input.html, csp: input.csp });
    return `pantheon-app://${id}/`;
  }

  release(owner: BrowserWindow, url: string): void {
    if (!this.owns(owner, url)) return;
    const id = new URL(url).host;
    this.pages.delete(id);
    this.windows.get(owner)!.delete(id);
  }

  owns(owner: BrowserWindow, url: string): boolean {
    const parsed = new URL(url);
    return parsed.protocol === 'pantheon-app:' && this.pages.get(parsed.host)?.owner === owner;
  }

  /** Whether the app page at page may frame url: an https URL whose origin its frameDomains name. */
  frames(page: string, url: string): boolean {
    const target = new URL(url);
    const domains = this.pages.get(new URL(page).host)?.csp?.frameDomains ?? [];
    return target.protocol === 'https:' && domains.includes(target.origin);
  }

  async respond(request: { url: string }): Promise<Response> {
    const url = new URL(request.url);
    const page = this.pages.get(url.host);
    if (!page || url.pathname !== '/') return new Response(null, { status: 404 });
    return new Response(page.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': appCsp(page.csp),
      },
    });
  }
}
