import type { SessionSearchHit, WorkbenchSession } from '@pantheon/protocol';
import { nameFromPath } from '../data/projects';

export interface PaletteItem {
  id: string;
  group: 'action' | 'screen' | 'session' | 'project' | 'file' | 'message';
  label: string;
  /** Muted text after the label: a session's state and runtime, a file's folder, a found message's session. */
  sub?: string;
  /** The session whose state glyph leads the row. */
  session?: WorkbenchSession;
  /** The id of the project whose monogram leads the row; the label is its name. */
  project?: string;
  /** A found message or branch: who said it or a branch leads the row, and the label around the match. */
  found?: { lead: 'user' | 'agent' | 'branch' } & Excerpt;
  /** The found session is archived, said at the row's end. */
  archived?: boolean;
  /** The item's shortcut in aria-keyshortcuts notation, shown on the right. */
  keys?: string;
  run: () => void;
}

/** The named groups of an empty search, in their order; actions and screens are both commands. */
export type PaletteGroup = 'session' | 'project' | 'command' | 'file' | 'message';

export interface Excerpt {
  before: string;
  match: string;
  after: string;
}

export interface PaletteSection {
  /** Null for the one flat list of a typed search. */
  group: PaletteGroup | null;
  items: PaletteItem[];
}

const GROUP_OF: Record<PaletteItem['group'], PaletteGroup> = {
  session: 'session',
  project: 'project',
  action: 'command',
  screen: 'command',
  file: 'file',
  message: 'message',
};
const ITEM_ORDER: readonly PaletteItem['group'][] = ['session', 'action', 'screen'];
const GROUP_ORDER: readonly PaletteGroup[] = ['session', 'project', 'command', 'file'];
const LIMIT = 50;
export const FILE_LIMIT = 20;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const EXCERPT_LEAD = 16;
const PATH_LIKE = /[/\\]|\.[a-z]{1,4}$/i;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const SENTENCE_WORDS = 3;
const SENTENCE_CJK = 8;

/** A leading `>` searches only the commands, `#` only the files and `@` only the projects; the text after it is matched. */
export function paletteQuery(query: string): {
  scope: 'all' | 'commands' | 'files' | 'projects';
  text: string;
} {
  if (query.startsWith('>')) return { scope: 'commands', text: query.slice(1).trimStart() };
  if (query.startsWith('#')) return { scope: 'files', text: query.slice(1).trimStart() };
  if (query.startsWith('@')) return { scope: 'projects', text: query.slice(1).trimStart() };
  return { scope: 'all', text: query };
}

/**
 * Which group unprefixed text leads with: files for a path, projects for the start of a project or
 * folder name, commands for the start of a word in one.
 */
export function paletteIntent(
  text: string,
  projects: readonly { name: string; roots: readonly string[] }[],
  items: readonly PaletteItem[],
): { lead: 'file' | 'project' | 'command' | null; sentence: boolean } {
  const q = text.trim().toLowerCase();
  const sentence =
    q.split(/\s+/).length >= SENTENCE_WORDS || (q.match(CJK)?.length ?? 0) >= SENTENCE_CJK;
  const starts = (name: string) => name.toLowerCase().startsWith(q);
  const lead = !q
    ? null
    : PATH_LIKE.test(q)
      ? 'file'
      : projects.some((p) => starts(p.name) || p.roots.some((root) => starts(nameFromPath(root))))
        ? 'project'
        : items.some((i) => GROUP_OF[i.group] === 'command' && (rank(i.label, q) ?? 2) <= 1)
          ? 'command'
          : null;
  return { lead, sentence: q !== '' && sentence };
}

/** A found file, a path in the project's folder, as its name and its folder. */
export function fileItem(path: string, open: (path: string) => void): PaletteItem {
  const name = /[^/\\]*$/.exec(path)![0];
  const folder = path.slice(0, path.length - name.length).replace(/[/\\]$/, '');
  return {
    id: `file-${path}`,
    group: 'file',
    label: name,
    ...(folder ? { sub: folder } : {}),
    run: () => open(path),
  };
}

/** The excerpt on one line, from 16 characters before the match, with `…` where it was cut. */
export function excerptAround(
  excerpt: string,
  { start, length }: { start: number; length: number },
): Excerpt {
  const fold = (part: string) => part.replace(/\s+/g, ' ');
  const lead = [...fold(excerpt.slice(0, start)).trimStart()];
  return {
    before: lead.length > EXCERPT_LEAD ? `…${lead.slice(-EXCERPT_LEAD).join('')}` : lead.join(''),
    match: fold(excerpt.slice(start, start + length)),
    after: fold(excerpt.slice(start + length)),
  };
}

/** The message and branch matches of a session search; title matches are left to the sessions. */
export function searchHitItems(
  hits: readonly SessionSearchHit[],
  open: (projectId: string, sessionId: string) => void,
): PaletteItem[] {
  return hits.flatMap((hit, i): PaletteItem[] => {
    if (hit.kind === 'title') return [];
    const found = {
      lead: hit.kind === 'message' ? hit.speaker : ('branch' as const),
      ...excerptAround(hit.excerpt, hit.match),
    };
    return [
      {
        id: `hit-${i}-${hit.session_id}`,
        group: 'message',
        label: found.before + found.match + found.after,
        sub: hit.title,
        found,
        ...(hit.archived ? { archived: true } : {}),
        run: () => open(hit.project_id, hit.session_id),
      },
    ];
  });
}

/** 0 the label starts with the query, 1 a word in it does, 2 it holds the query, 3 it holds the query's characters in order; null no match. */
function rank(label: string, q: string): number | null {
  const text = label.toLowerCase();
  const first = text.indexOf(q);
  if (first === 0) return 0;
  if (first > 0) {
    for (let at = first; at >= 0; at = text.indexOf(q, at + 1))
      if (!WORD_CHAR.test(text[at - 1]!)) return 1;
    return 2;
  }
  const chars = [...q];
  let n = 0;
  for (const char of text) if (char === chars[n]) n++;
  return n === chars.length ? 3 : null;
}

/**
 * An empty search: one named section per group, sessions led by `recent`. A typed one: one unnamed
 * list by rank then group order, then projects and files, with the `lead` group's items on top.
 */
export function paletteSections(
  items: PaletteItem[],
  query: string,
  recent: readonly string[] = [],
  files: readonly PaletteItem[] = [],
  projects: readonly PaletteItem[] = [],
  lead: PaletteGroup | null = null,
): PaletteSection[] {
  const { scope, text } = paletteQuery(query);
  const pool =
    scope === 'files' || scope === 'projects'
      ? []
      : ITEM_ORDER.filter((g) => scope === 'all' || g !== 'session').flatMap((g) =>
          items.filter((i) => i.group === g),
        );
  const found = scope === 'all' || scope === 'files' ? files.slice(0, FILE_LIMIT) : [];
  const places = scope === 'all' || scope === 'projects' ? projects.slice(0, LIMIT) : [];
  const q = text.toLowerCase();
  if (!q) {
    const opened = recent.flatMap((id) => pool.filter((i) => i.id === id));
    const all = [...opened, ...pool.filter((i) => !opened.includes(i)), ...places, ...found];
    return GROUP_ORDER.map((group) => ({
      group,
      items: all.filter((i) => GROUP_OF[i.group] === group).slice(0, LIMIT),
    })).filter((s) => s.items.length > 0);
  }
  const ranks: PaletteItem[][] = [[], [], [], []];
  for (const item of pool) {
    const r = rank(item.label, q);
    if (r !== null) ranks[r]!.push(item);
  }
  const listed = [...ranks.flat().slice(0, LIMIT), ...places, ...found];
  const first = (i: PaletteItem) => GROUP_OF[i.group] === lead;
  const shown = [...listed.filter(first), ...listed.filter((i) => !first(i))];
  return shown.length > 0 ? [{ group: null, items: shown }] : [];
}
