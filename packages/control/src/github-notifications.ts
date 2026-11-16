import { spawn } from 'node:child_process';
import type { ExternalEvent } from '@pantheon/domain';
import { receiveExternalEvent } from './external-events.js';
import type { ExternalSource } from './external-sources.js';
import { remoteOf } from './import-candidates.js';

export interface GithubResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: unknown;
}
/** One GET of the GitHub REST API; path is a path under the API root or a full API URL. */
export type GithubGet = (path: string, headers?: Record<string, string>) => Promise<GithubResponse>;

/** A deleted account's issues and comments have no user. */
type Person = { login: string; type: string } | null;
/** An issue, pull request or comment; body is null when it has no text. */
interface Written {
  user: Person;
  body: string | null;
}
interface Notification {
  id: string;
  reason: string;
  updated_at: string;
  repository: { full_name: string };
  /** url is absent on subjects that are no issue or pull request, such as a discussion. */
  subject: { url: string | null; latest_comment_url: string | null };
}
interface IssueEvent {
  event: string;
  assignee?: Person;
  assigner?: Person;
  requested_reviewer?: Person;
  review_requester?: Person;
}

const KINDS: Record<string, string> = {
  assign: 'issue_assigned',
  mention: 'mention',
  review_requested: 'review_requested',
};
const DEFAULT_POLL_MS = 60_000;

export const ghApi: GithubGet = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      [
        'api',
        '-i',
        path,
        ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (_code, signal) => {
      // gh exits 1 for every status above 299, a 304 included, so the status line decides.
      const end = stdout.search(/\r?\n\r?\n/),
        head = (end < 0 ? stdout : stdout.slice(0, end)).split(/\r?\n/),
        status = Number(/^HTTP\/\S+ (\d{3})/.exec(head[0]!)?.[1]),
        text = end < 0 ? '' : stdout.slice(end).trim();
      if (!status) return reject(new Error(stderr.trim() || 'gh api gave no HTTP response'));
      let body: unknown;
      try {
        if (signal) throw new Error(`gh was stopped by ${signal}`);
        body = text ? JSON.parse(text) : null;
      } catch (error) {
        const reason = [(error as Error).message, stderr.trim()].filter(Boolean).join('; ');
        return reject(new Error(`gh api gave a bad response for ${path}: ${reason}`));
      }
      resolve({
        status,
        headers: Object.fromEntries(
          head.slice(1).map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        ),
        body,
      });
    });
  });

/** The user's GitHub notifications, read with conditional requests. */
export function githubSource(get: GithubGet = ghApi): ExternalSource {
  /** The entity tag of the last notification list whose every item was read. */
  let etag: string | undefined;
  /** The repositories that list was read for. */
  let scope: string | undefined;
  /** Every item of a list, following the next links GitHub sends. */
  const pages = async <T>(first: GithubResponse): Promise<T[]> => {
    const items = [...(first.body as T[])];
    for (let page = first; ;) {
      const next = /<([^>]+)>;\s*rel="next"/.exec(page.headers.link ?? '')?.[1];
      if (!next) return items;
      page = await get(next);
      items.push(...(page.body as T[]));
    }
  };
  return {
    id: 'github',
    async poll(ctx, taking) {
      const projects = new Map<string, string>();
      for (const project of taking)
        for (const root of project.roots) {
          const remote = await remoteOf(root);
          if (remote?.host === 'github.com')
            projects.set(`${remote.owner}/${remote.name}`.toLowerCase(), project.id);
        }
      if (!projects.size) return DEFAULT_POLL_MS;
      const read = JSON.stringify([...projects].sort()),
        list = await get(
          'notifications?participating=true',
          etag && scope === read ? { 'if-none-match': etag } : {},
        ),
        wait = Number(list.headers['x-poll-interval'] ?? DEFAULT_POLL_MS / 1000) * 1000;
      if (list.status === 304) return wait;
      if (list.status !== 200)
        throw new Error(`GitHub answered ${list.status} for the notification list`);
      // gh answers for whichever account is active now.
      const login = ((await get('user')).body as { login: string }).login;
      for (const item of await pages<Notification>(list)) {
        const repo = item.repository.full_name,
          project_id = projects.get(repo.toLowerCase()),
          kind = KINDS[item.reason],
          dedup_key = `github:${item.id}:${item.updated_at}`;
        if (!project_id || !kind || !item.subject.url) continue;
        if (ctx.store.get('external_events', `${project_id}:${dedup_key}`)) continue;
        const issue = (await get(item.subject.url)).body as Written & {
            number: number;
            title: string;
            html_url: string;
            comments_url: string;
          },
          comments = await pages<Written>(await get(`${issue.comments_url}?per_page=100`));
        let actor: Person | undefined;
        if (kind === 'mention') {
          const latest = item.subject.latest_comment_url;
          actor =
            !latest || latest === item.subject.url
              ? issue.user
              : ((await get(latest)).body as Written).user;
        } else {
          const events = await pages<IssueEvent>(
            await get(`repos/${repo}/issues/${issue.number}/events?per_page=100`),
          );
          actor =
            kind === 'issue_assigned'
              ? events.findLast((e) => e.event === 'assigned' && e.assignee?.login === login)
                  ?.assigner
              : events.findLast(
                  (e) => e.event === 'review_requested' && e.requested_reviewer?.login === login,
                )?.review_requester;
        }
        let actor_trust: ExternalEvent['actor_trust'] = 'other';
        if (actor?.login === login) actor_trust = 'self';
        else if (actor?.type === 'Bot') actor_trust = 'bot';
        else if (actor) {
          // GitHub answers 403 to an account that may not push to the repository itself.
          const permission = await get(`repos/${repo}/collaborators/${actor.login}/permission`);
          if (
            permission.status === 200 &&
            ['admin', 'write'].includes((permission.body as { permission: string }).permission)
          )
            actor_trust = 'write';
        }
        receiveExternalEvent(ctx, {
          project_id,
          source: 'github',
          subject_key: `github:${repo}#${issue.number}`,
          dedup_key,
          kind,
          actor: actor?.login ?? '',
          actor_trust,
          title: issue.title,
          url: issue.html_url,
          texts: [
            { ...issue, body: [issue.title, issue.body].filter(Boolean).join('\n\n') },
            ...comments,
          ].map((written) => {
            const author = written.user?.login ?? 'ghost';
            return { author, own: author === login, text: written.body ?? '' };
          }),
        });
      }
      etag = list.headers.etag;
      scope = read;
      return wait;
    },
  };
}
