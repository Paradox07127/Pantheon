/** A token the caret is completing: `@` a file path, `/` a command or skill at the start. */
export interface CompletionAt {
  kind: '@' | '/';
  query: string;
  /** Where the trigger character is. */
  start: number;
}

const MAX_SKILLS = 8;

/** The completion for the token from the last whitespace or line start up to the caret. */
export function completionAt(text: string, caret: number): CompletionAt | null {
  const before = text.slice(0, caret);
  const start = before.search(/\S*$/);
  const token = before.slice(start);
  if (token.startsWith('@')) return { kind: '@', query: token.slice(1), start };
  if (token.startsWith('/') && before.slice(0, start).trim() === '')
    return { kind: '/', query: token.slice(1), start };
  return null;
}

/** The text with the whole token at `at.start` replaced by `insert` and a space, caret after. */
export function applyCompletion(
  text: string,
  caret: number,
  at: CompletionAt,
  insert: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, at.start)}${insert} `;
  const end = caret + text.slice(caret).search(/\s|$/);
  return { text: head + text.slice(end), caret: head.length };
}

/** The text without the whole token at `at.start` and one space after it, caret where it was. */
export function removeCompletion(
  text: string,
  caret: number,
  at: CompletionAt,
): { text: string; caret: number } {
  const end = caret + text.slice(caret).search(/\s|$/);
  const after = text[end] === ' ' ? end + 1 : end;
  return { text: text.slice(0, at.start) + text.slice(after), caret: at.start };
}

/** Names starting with the query, then names containing it, ignoring case. */
export function matchSkills<T extends { name: string }>(skills: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const prefix = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  const inside = skills.filter(
    (s) => !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q),
  );
  return [...prefix, ...inside].slice(0, MAX_SKILLS);
}
