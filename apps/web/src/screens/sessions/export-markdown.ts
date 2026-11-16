import { runtimeName } from '../../components/RuntimeGlyph';
import { orchestrationLabel, toolGroupLabel, toolLabel } from '../../data/tool-calls';
import { groupToolCalls, type ToolItem, type TurnView } from '../../data/transcript';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { shownInput } from './thread-model';

/** What a session's Markdown export is made of. */
export interface MarkdownSource {
  title: string;
  project?: string | null;
  branch?: string | null;
  runtime: string;
  model?: string | null;
  /** ISO time. */
  created_at?: string | null;
  turns: readonly TurnView[];
  /** Tool call paths are written relative to these folders. */
  folders?: readonly string[];
}

const pad = (n: number) => String(n).padStart(2, '0');

const localTime = (at: number | string): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Whether a code fence the text opens is still open at its end. */
function openFence(text: string): boolean {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) continue;
    if (open === null) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence)
      open = null;
  }
  return open !== null;
}

/** The text as written; one whose fence never closes goes inside a longer fence, so it cannot swallow what follows. */
function block(text: string): string {
  const body = text.replace(/^\n+/, '').trimEnd();
  if (!openFence(body)) return body;
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

/** A run of calls as its folded row reads; a lone call as its own row's title and argument. */
function callLine(calls: ToolItem[], folders: readonly string[]): string {
  const [call] = calls;
  const label =
    call && calls.length === 1
      ? (orchestrationLabel(call.name, call.input, call.output) ??
        toolLabel(call.name, call.input, folders))
      : null;
  const line = label
    ? [label.title, label.detail].filter(Boolean).join(' ')
    : toolGroupLabel(calls);
  return `> ${line.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The session as Markdown: title, facts, then each turn's message and reply, tool calls one quoted
 * line each. Reasoning, requests and tool input and output are left out.
 */
export function sessionMarkdown(source: MarkdownSource, now = Date.now()): string {
  const runtime = runtimeName(source.runtime);
  const facts = [
    source.project &&
      t(
        { id: 'sessions.export.project', defaultMessage: 'Project: {name}' },
        { name: source.project },
      ),
    source.branch &&
      t(
        { id: 'sessions.export.branch', defaultMessage: 'Branch: {branch}' },
        { branch: source.branch },
      ),
    source.model
      ? t(
          { id: 'sessions.export.runtimeModel', defaultMessage: 'Runtime: {runtime} · {model}' },
          { runtime, model: source.model },
        )
      : t({ id: 'sessions.export.runtime', defaultMessage: 'Runtime: {runtime}' }, { runtime }),
    source.created_at &&
      t(
        { id: 'sessions.export.created', defaultMessage: 'Created: {time}' },
        { time: localTime(source.created_at) },
      ),
    t(
      { id: 'sessions.export.exported', defaultMessage: 'Exported: {time}' },
      { time: localTime(now) },
    ),
  ].filter(Boolean);
  const you = t({ id: 'sessions.export.you', defaultMessage: 'You' });
  const turns = source.turns.flatMap((view) => {
    if (view.turn.origin === 'compaction')
      return view.turn.state === 'completed'
        ? [t({ id: 'sessions.thread.compacted', defaultMessage: 'Context compacted' })]
        : [];
    const input = shownInput(view.turn);
    const names = (view.turn.attachments ?? []).map((a) => a.name);
    const reply = groupToolCalls(view.items).flatMap((item) => {
      if (item.kind === 'text') return item.text.trim() ? [block(item.text)] : [];
      if (item.kind === 'group') return [callLine(item.calls, source.folders ?? [])];
      if (item.kind === 'tool') return [callLine([item], source.folders ?? [])];
      return [];
    });
    return [
      `## ${you}`,
      ...(input.trim() ? [block(input)] : []),
      ...(names.length
        ? [
            t(
              { id: 'sessions.export.attachments', defaultMessage: 'Attachments: {names}' },
              { names: listText(...names) },
            ),
          ]
        : []),
      ...(reply.length ? [`## ${runtime}`, ...reply] : []),
    ];
  });
  return `${[`# ${source.title}`, facts.map((fact) => `- ${fact}`).join('\n'), ...turns].join('\n\n')}\n`;
}

/** The title as a file name: characters a file name cannot hold become -, cut to 80, with .md. */
export function markdownFileName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, '-').trim();
  return `${Array.from(name).slice(0, 80).join('')}.md`;
}
