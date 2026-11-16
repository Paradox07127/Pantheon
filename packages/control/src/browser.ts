import { randomUUID } from 'node:crypto';
import { DomainError, requireThat, type Principal } from '@pantheon/domain';
import type { BrowserPage, BrowserRequest, inputSchemas } from '@pantheon/protocol';

/** How long a browser tool call waits for the desktop window's answer. */
export const BROWSER_ANSWER_MS = 30_000;

type BrowserHost = (request: BrowserRequest) => void;
type BrowserResult = ReturnType<(typeof inputSchemas)['browser.result']['parse']>;

interface Pending {
  host: BrowserHost;
  resolve: (page: BrowserPage) => void;
  reject: (error: DomainError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Hands session browser tool calls to a connected desktop window and waits for its answer. */
export class BrowserRelay {
  private readonly hosts: BrowserHost[] = [];
  private readonly pending = new Map<string, Pending>();

  /** Adds a desktop window that answers browser requests; the last one added answers them. */
  attach(host: BrowserHost): () => void {
    this.hosts.push(host);
    return () => {
      const at = this.hosts.indexOf(host);
      if (at >= 0) this.hosts.splice(at, 1);
      for (const [id, call] of this.pending)
        if (call.host === host)
          this.settle(id)?.reject(
            new DomainError(
              'browser_unavailable',
              'browser unavailable: the desktop window closed',
            ),
          );
    };
  }

  call(principal: Principal, action: BrowserRequest['action'], url?: string): Promise<BrowserPage> {
    requireThat(principal.session_id, 'permission_denied', 'Browser tools need a session');
    const host = this.hosts.at(-1);
    requireThat(host, 'browser_unavailable', 'browser unavailable: no desktop window is connected');
    const request_id = randomUUID();
    return new Promise<BrowserPage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.settle(request_id)?.reject(
            new DomainError(
              'browser_timeout',
              `The desktop window did not answer within ${BROWSER_ANSWER_MS / 1000} seconds`,
            ),
          ),
        BROWSER_ANSWER_MS,
      );
      this.pending.set(request_id, { host, resolve, reject, timer });
      host({
        request_id,
        session_id: principal.session_id!,
        action,
        ...(url === undefined ? {} : { url }),
      });
    });
  }

  answer(result: BrowserResult): { request_id: string } {
    const call = this.settle(result.request_id);
    requireThat(call, 'not_found', `No browser request ${result.request_id} is waiting`);
    if (result.error) call.reject(new DomainError(result.error.code, result.error.message));
    else call.resolve(result.page!);
    return { request_id: result.request_id };
  }

  private settle(id: string): Pending | undefined {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    return call;
  }
}
