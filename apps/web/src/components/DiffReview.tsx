import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ChevronDown, ChevronRight, ChevronsDownUp, Folder, Space, TextWrap } from 'lucide-react';
import { parsePatch, type DiffFile, type DiffHunk, type DiffLine } from '../data/patch';
import { setDiffPrefs, useDiffPrefs, type DiffSwitch, type DiffView } from '../data/diff-prefs';
import { t } from '../i18n';
import { DiffCounts } from './DiffCounts';
import { LoadError } from './LoadError';
import { Tip } from './Tip';
import './diff-review.css';

const PREFIX = { add: '+', del: '−', ctx: '' } as const;

/** A read diff of an attempt or a session. */
export interface DiffRead {
  data: {
    files: {
      path: string;
      additions: number | null;
      deletions: number | null;
      untracked?: boolean;
    }[];
    patch: string | null;
    truncated: boolean;
  } | null;
  error: string | null;
  reload: () => void;
}

/** One diff line a comment is about. */
export interface CommentedLine {
  path: string;
  /** The new side's number, or the old side's for a removed line. */
  line: number;
  kind: DiffLine['kind'];
  text: string;
}

interface NumberedLine extends DiffLine {
  old: number | null;
  new: number | null;
}

/** Numbers a hunk's lines on both sides from its `@@ -a,b +c,d @@` header. */
export function numbered(hunk: DiffHunk): NumberedLine[] {
  const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  let old = Number(start?.[1] ?? 0),
    now = Number(start?.[2] ?? 0);
  return hunk.lines.map((l) => ({
    ...l,
    old: l.kind === 'add' ? null : old++,
    new: l.kind === 'del' ? null : now++,
  }));
}

const bare = (lines: DiffLine[], kind: DiffLine['kind']) =>
  lines
    .filter((l) => l.kind === kind)
    .map((l) => l.text.replace(/\s+/g, ''))
    .filter((text) => text !== '');

/** The hunk's removed and added lines are the same once whitespace and blank lines are dropped. */
export function onlyWhitespace(hunk: DiffHunk): boolean {
  const del = bare(hunk.lines, 'del'),
    add = bare(hunk.lines, 'add');
  return del.length === add.length && del.every((text, i) => text === add[i]);
}

/** Added when untracked or git's header says new file, deleted when it says deleted file. */
function fileStatus(untracked: boolean, file: DiffFile | undefined): 'A' | 'M' | 'D' {
  if (untracked) return 'A';
  return file?.status ?? 'M';
}

/** Each directory once, where the diff first names it, with its files; a file at the root stands alone. */
function byDirectory<F extends { path: string }>(files: F[]) {
  const groups: { dir: string; files: F[] }[] = [];
  const dirs = new Map<string, F[]>();
  for (const f of files) {
    const dir = f.path.slice(0, Math.max(f.path.lastIndexOf('/'), 0));
    const group = dirs.get(dir);
    if (group) group.push(f);
    else {
      groups.push({ dir, files: [f] });
      if (dir !== '') dirs.set(dir, groups.at(-1)!.files);
    }
  }
  return groups;
}

/** Five cells shared between added and deleted lines, more of them filled the more lines changed. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const filled = Math.min(5, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
  const added = Math.round((filled * additions) / total);
  return (
    <span
      className="ss-dstat"
      role="img"
      aria-label={t(
        {
          id: 'components.diffBar.label',
          defaultMessage:
            '{additions, plural, one {# line} other {# lines}} added, {deletions, plural, one {# line} other {# lines}} removed',
        },
        { additions, deletions },
      )}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} data-k={i < added ? 'add' : i < filled ? 'del' : undefined} />
      ))}
    </span>
  );
}

/** Split view rows by line index: a run of removed lines beside the added run after it, context on both sides. */
export function sideBySide(lines: NumberedLine[]) {
  const rows: { old: number | null; new: number | null }[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.kind === 'ctx') {
      rows.push({ old: i, new: i });
      i++;
      continue;
    }
    const del: number[] = [],
      add: number[] = [];
    while (lines[i]?.kind === 'del') del.push(i++);
    while (lines[i]?.kind === 'add') add.push(i++);
    for (let k = 0; k < Math.max(del.length, add.length); k++)
      rows.push({ old: del[k] ?? null, new: add[k] ?? null });
  }
  return rows;
}

/** A comment being written; it follows its line only while that line is unambiguous. */
interface Draft {
  id: number;
  key: string;
  at: CommentedLine;
  /** The file's hunks when the draft was opened. */
  hunks: string;
  /** No other line of the file had the same kind and text when the draft was opened. */
  unique: boolean;
  draft: string;
  /** Why the last try to comment failed. */
  error: string | null;
}

/** Something shown under a diff line, such as a review finding or a stored comment. */
export interface DiffNote {
  id: string;
  path: string;
  side: 'new' | 'old';
  line: number;
  /** The line's text when the note was made; the note follows it to another line. */
  line_text?: string;
  node: ReactNode;
  /** Shown above the file list while the diff does not show the line; left out without it. */
  loose?: ReactNode;
}

const lineAt = (path: string, l: NumberedLine): CommentedLine => ({
  path,
  line: (l.new ?? l.old)!,
  kind: l.kind,
  text: l.text,
});

/** On a note's side: the new number of a line the new side has, the old one of a removed line. */
const holds = (l: NumberedLine, at: { side: 'new' | 'old'; line: number }) =>
  (at.side === 'new' ? l.new : l.kind === 'del' ? l.old : null) === at.line;

/**
 * The line of the files that a path, side and number name; null when no hunk shows it. When no line
 * there has line_text, the one line on the side with that text; null for none or several.
 */
export function lineOf(
  files: Iterable<DiffFile>,
  at: { path: string; side: 'new' | 'old'; line: number; line_text?: string },
): CommentedLine | null {
  for (const file of files) {
    if (file.path !== at.path) continue;
    const lines = file.hunks.flatMap(numbered);
    const l = lines.find((n) => holds(n, at));
    if (l && (at.line_text === undefined || l.text === at.line_text)) return lineAt(at.path, l);
    if (at.line_text === undefined) continue;
    const same = lines.filter(
      (n) => n.text === at.line_text && (at.side === 'new' ? n.new !== null : n.kind === 'del'),
    );
    return same.length === 1 ? lineAt(at.path, same[0]!) : null;
  }
  return null;
}

/**
 * Every file's numbered diff, under a list by directory when there are several. With onComment each
 * line number opens a comment box; key it by what it shows. onComment rejects with the box's reason.
 */
export function DiffFiles({
  diff,
  onComment,
  notes,
  mark,
  action,
  path,
}: {
  diff: DiffRead;
  onComment?: (at: CommentedLine, comment: string) => Promise<boolean>;
  notes?: DiffNote[];
  /** Shown after a file's name in the list and in its header. */
  mark?: (path: string) => ReactNode;
  /** A control at the end of a file's row in the list and of its header, outside their buttons. */
  action?: (path: string) => ReactNode;
  /** The file to show first: picked in the list and scrolled to once its diff is read. */
  path?: string;
}) {
  const [picked, setPicked] = useState<string | null>(path ?? null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const ids = useRef(0);
  const [sending, setSending] = useState(false);
  const prefs = useDiffPrefs();
  // Files the reader folded or unfolded; the others follow the options.
  const [folded, setFolded] = useState(new Map<string, boolean>());
  // Each viewed file's hunks when it was marked.
  const [viewed, setViewed] = useState(new Map<string, string>());
  const sections = useRef(new Map<string, HTMLElement>());
  const patch = diff.data?.patch ?? null;
  const parsed = useMemo(
    () => new Map<string, DiffFile>(patch ? parsePatch(patch).map((f) => [f.path, f]) : []),
    [patch],
  );
  const read = !!diff.data;
  useEffect(() => {
    if (!path || !read) return;
    setPicked(path);
    sections.current.get(path)?.scrollIntoView({ block: 'start' });
  }, [path, read]);

  if (!diff.data) {
    if (diff.error) return <LoadError message={diff.error} onRetry={diff.reload} />;
    return (
      <span className="mu">
        {t({ id: 'components.diff.loading', defaultMessage: 'Reading changes…' })}
      </span>
    );
  }
  const { files, truncated } = diff.data;
  const jump = (path: string) => {
    setPicked(path);
    sections.current.get(path)?.scrollIntoView({ block: 'start' });
  };
  const close = (id: number) => setDrafts((now) => now.filter((d) => d.id !== id));
  const submit = async (sent: Draft, at: CommentedLine) => {
    if (!onComment || sending || sent.draft.trim() === '') return;
    setSending(true);
    let ok = false,
      error: string | null = null;
    try {
      ok = await onComment(at, sent.draft);
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    setSending(false);
    if (ok) setDrafts((now) => now.filter((d) => !(d.id === sent.id && d.draft === sent.draft)));
    else setDrafts((now) => now.map((d) => (d.id === sent.id ? { ...d, error } : d)));
  };
  const keyed = (path: string) =>
    (parsed.get(path)?.hunks ?? []).flatMap((h, i) =>
      numbered(h).map((l, j) => ({ key: `${path}\u0000${i}:${j}`, l })),
    );
  const hunksOf = (path: string) => JSON.stringify(parsed.get(path)?.hunks ?? []);
  const isViewed = (path: string) => viewed.get(path) === hunksOf(path);
  const same = (l: NumberedLine, at: CommentedLine) => l.kind === at.kind && l.text === at.text;
  const shown = new Set(truncated ? [] : files.map((f) => f.path));
  // The row a draft shows under: its own while the file is unchanged, else its line's only match.
  const placed = drafts.map((d) => {
    if (!shown.has(d.at.path)) return { d, key: null };
    const rows = keyed(d.at.path);
    if (hunksOf(d.at.path) === d.hunks) return { d, key: d.key };
    const matches = d.unique ? rows.filter((r) => same(r.l, d.at)) : [];
    return { d, key: matches.length === 1 ? matches[0]!.key : null };
  });
  const box = (d: Draft, at: CommentedLine | null) => (
    <div key={d.id} className="ss-cmt">
      <textarea
        aria-label={t({ id: 'components.diff.commentLabel', defaultMessage: 'Line comment' })}
        placeholder={t({
          id: 'components.diff.commentPlaceholder',
          defaultMessage: 'Comment on this line',
        })}
        autoFocus
        value={d.draft}
        onChange={(e) => {
          const draft = e.target.value;
          setDrafts((now) => now.map((x) => (x.id === d.id ? { ...x, draft } : x)));
        }}
      />
      {d.error && (
        <span className="run-err" role="alert">
          {d.error}
        </span>
      )}
      <div className="ss-cmta">
        <button type="button" className="btn" onClick={() => close(d.id)}>
          {t({ id: 'components.diff.cancel', defaultMessage: 'Cancel' })}
        </button>
        <button
          type="button"
          className="btn pri"
          disabled={sending || !at || d.draft.trim() === ''}
          aria-busy={sending || undefined}
          onClick={() => at && void submit(d, at)}
        >
          {t({ id: 'components.diff.comment', defaultMessage: 'Comment' })}
        </button>
      </div>
    </div>
  );
  const option = (key: DiffSwitch, label: string, icon: ReactNode) => (
    <Tip content={label}>
      <button
        type="button"
        className="ib"
        aria-label={label}
        aria-pressed={prefs[key]}
        onClick={() => {
          setDiffPrefs({ [key]: !prefs[key] });
          if (key !== 'wrap') setFolded(new Map());
        }}
      >
        {icon}
      </button>
    </Tip>
  );
  const counts = (f: (typeof files)[number]) =>
    f.additions === null ? (
      <span className="df-n mu">
        {t({ id: 'components.diff.binary', defaultMessage: 'Binary' })}
      </span>
    ) : (
      <span className="df-n" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <DiffCounts additions={f.additions} deletions={f.deletions} />
      </span>
    );
  const viewedBox = (path: string) => (
    <input
      type="checkbox"
      className="df-ck"
      aria-label={t(
        { id: 'components.diff.markViewed', defaultMessage: 'Mark {path} as viewed' },
        { path },
      )}
      checked={isViewed(path)}
      onChange={(e) => {
        const on = e.target.checked;
        const hunks = hunksOf(path);
        setViewed((now) => {
          const next = new Map(now);
          if (on) next.set(path, hunks);
          else next.delete(path);
          return next;
        });
      }}
    />
  );
  const fileItem = (f: (typeof files)[number]) => {
    const status = fileStatus(!!f.untracked, parsed.get(f.path));
    return (
      <li key={f.path} className="df-tf" data-viewed={isViewed(f.path) || undefined}>
        {!truncated && viewedBox(f.path)}
        <Tip content={f.path}>
          <button
            type="button"
            className={f.path === picked ? 'ss-file on' : 'ss-file'}
            aria-current={f.path === picked || undefined}
            onClick={() => jump(f.path)}
          >
            <span className={`ss-fs ${status}`}>{status}</span>
            <span className="df-path mono">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
            {mark?.(f.path)}
            {f.additions !== null && (
              <DiffStat additions={f.additions} deletions={f.deletions ?? 0} />
            )}
            {counts(f)}
          </button>
        </Tip>
        {action?.(f.path)}
      </li>
    );
  };
  const seen = files.filter((f) => isViewed(f.path)).length;
  const noteAt = new Map((notes ?? []).map((n) => [n, lineOf(parsed.values(), n)]));
  const loose = (notes ?? []).filter(
    (n) => n.loose !== undefined && !(shown.has(n.path) && noteAt.get(n)),
  );

  // One side of a line in the split view, both numbers of it in the unified view.
  const cell = (path: string, l: NumberedLine, key: string, side?: 'old' | 'new') => {
    const at = lineAt(path, l);
    const open = () => {
      if (placed.some((p) => p.key === key)) return;
      const unique = keyed(path).filter((r) => same(r.l, at)).length === 1;
      const id = ++ids.current;
      // An empty draft gives way to the newly opened one; written ones stay.
      setDrafts((now) => [
        ...now.filter((d) => d.draft.trim() !== ''),
        { id, key, at, hunks: hunksOf(path), unique, draft: '', error: null },
      ]);
    };
    const nums = side ? (
      <span>{l[side] ?? ''}</span>
    ) : (
      <>
        <span>{l.old ?? ''}</span>
        <span>{l.new ?? ''}</span>
      </>
    );
    return (
      <div key={side} className={`ss-ln ${side ? 'df-half ' : ''}${l.kind}`}>
        {onComment ? (
          <button
            type="button"
            className="ss-nums"
            aria-label={t(
              {
                id: 'components.diff.commentLine',
                defaultMessage: 'Comment on line {line} of {path}',
              },
              { path, line: at.line },
            )}
            onClick={open}
          >
            {nums}
          </button>
        ) : (
          <span className="ss-nums">{nums}</span>
        )}
        <span className="ss-sg" aria-hidden="true">
          {PREFIX[l.kind]}
        </span>
        <span className="ss-code">{l.text}</span>
      </div>
    );
  };
  // What shows under a line: the missing newline mark, its notes, its comment drafts.
  const below = (path: string, l: NumberedLine, key: string) => {
    const under = (notes ?? []).filter((n) => {
      const at = noteAt.get(n);
      return n.path === path && !!at && holds(l, { side: n.side, line: at.line });
    });
    return (
      <>
        {l.noNewline && (
          <div className="ss-ln">
            <span className="ss-nums" />
            <span className="ss-sg" />
            <span className="ss-code">
              <span className="mu">{'\\ No newline at end of file'}</span>
            </span>
          </div>
        )}
        {under.map((n) => (
          <Fragment key={n.id}>{n.node}</Fragment>
        ))}
        {placed.filter((p) => p.key === key).map((p) => box(p.d, lineAt(path, l)))}
      </>
    );
  };
  const line = (path: string, l: NumberedLine, key: string) => (
    <Fragment key={key}>
      {cell(path, l, key)}
      {below(path, l, key)}
    </Fragment>
  );
  const hunkLines = (path: string, h: DiffHunk, i: number) => {
    const lines = numbered(h);
    const key = (j: number) => `${path}\u0000${i}:${j}`;
    if (prefs.view === 'unified') return lines.map((l, j) => line(path, l, key(j)));
    return sideBySide(lines).map((row) => {
      const half = (j: number | null, side: 'old' | 'new') =>
        j === null ? (
          <div key={side} className="ss-ln df-half" data-empty />
        ) : (
          cell(path, lines[j]!, key(j), side)
        );
      return (
        <Fragment key={key(row.old ?? row.new!)}>
          <div className="df-sr">
            {half(row.old, 'old')}
            {half(row.new, 'new')}
          </div>
          {row.old !== null && below(path, lines[row.old]!, key(row.old))}
          {row.new !== null && row.new !== row.old && below(path, lines[row.new]!, key(row.new))}
        </Fragment>
      );
    });
  };

  return (
    <div className="ss-diff">
      {!truncated && files.length > 0 && (
        <div
          className="df-opts"
          role="toolbar"
          aria-label={t({ id: 'components.diff.options', defaultMessage: 'Diff options' })}
        >
          <span className="df-seen">
            <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true">
              <circle className="df-rgt" cx="16" cy="16" r="13" />
              {seen > 0 && (
                <circle
                  className="df-rgf"
                  cx="16"
                  cy="16"
                  r="13"
                  pathLength={100}
                  strokeDasharray={`${(seen / files.length) * 100} 100`}
                  transform="rotate(-90 16 16)"
                />
              )}
            </svg>
            {t(
              { id: 'components.diff.viewedCount', defaultMessage: 'Viewed {viewed} / {total}' },
              { viewed: seen, total: files.length },
            )}
          </span>
          <RadioGroup<DiffView>
            className="tb-seg"
            aria-label={t({ id: 'components.diff.view', defaultMessage: 'Diff view' })}
            value={prefs.view}
            onValueChange={(view) => setDiffPrefs({ view })}
          >
            <Radio.Root value="unified">
              {t({ id: 'components.diff.unified', defaultMessage: 'Unified' })}
            </Radio.Root>
            <Radio.Root value="split">
              {t({ id: 'components.diff.split', defaultMessage: 'Split' })}
            </Radio.Root>
          </RadioGroup>
          {option(
            'wrap',
            t({ id: 'components.diff.wrap', defaultMessage: 'Wrap long lines' }),
            <TextWrap aria-hidden="true" />,
          )}
          {option(
            'ignore_whitespace',
            t({
              id: 'components.diff.ignoreWhitespace',
              defaultMessage: 'Hide whitespace-only changes',
            }),
            <Space aria-hidden="true" />,
          )}
          {option(
            'collapse',
            t({ id: 'components.diff.collapse', defaultMessage: 'Fold files on open' }),
            <ChevronsDownUp aria-hidden="true" />,
          )}
        </div>
      )}
      {placed
        .filter((p) => p.key === null)
        .map(({ d }) => (
          // A draft whose line cannot be placed stays here with the line it was opened on.
          <section key={d.id} className="ss-fd">
            <div className="ss-fdh mono">
              <span className="df-path" title={d.at.path}>
                {d.at.path}:{d.at.line}
              </span>
            </div>
            <div className="ss-dl mono">
              <div className={`ss-ln ${d.at.kind}`}>
                <span className="ss-nums">
                  <span>{d.at.kind === 'del' ? d.at.line : ''}</span>
                  <span>{d.at.kind === 'del' ? '' : d.at.line}</span>
                </span>
                <span className="ss-sg" aria-hidden="true">
                  {PREFIX[d.at.kind]}
                </span>
                <span className="ss-code">{d.at.text}</span>
              </div>
            </div>
            {box(d, null)}
          </section>
        ))}
      {loose.length > 0 && (
        <div className="df-loose">
          {loose.map((n) => (
            <Fragment key={n.id}>{n.loose}</Fragment>
          ))}
        </div>
      )}
      {/* A sole file's header already names it, unless the diff is too large to show. */}
      {(files.length > 1 || (truncated && files.length > 0)) && (
        <ul className="ss-files">
          {byDirectory(files).map((g) =>
            g.dir === '' ? (
              fileItem(g.files[0]!)
            ) : (
              <li key={`${g.dir}/`} className="df-dir">
                <div className="df-dirn mono">
                  <Folder aria-hidden="true" />
                  <span className="df-path">{g.dir}</span>
                </div>
                <ul>{g.files.map(fileItem)}</ul>
              </li>
            ),
          )}
        </ul>
      )}
      {truncated ? (
        <div className="df-note mu">
          {t({
            id: 'components.diff.truncated',
            defaultMessage: 'Too many changes to load in full',
          })}
        </div>
      ) : (
        files.map((f) => {
          const hunks = parsed.get(f.path)?.hunks ?? [];
          const status = fileStatus(!!f.untracked, parsed.get(f.path));
          const blank = hunks.map(onlyWhitespace);
          const whitespace = prefs.ignore_whitespace && hunks.length > 0 && blank.every(Boolean);
          const open = !(folded.get(f.path) ?? (prefs.collapse || whitespace));
          // A whitespace-only file unfolded by the reader shows those changes.
          const hidden = (i: number) => prefs.ignore_whitespace && !whitespace && blank[i];
          return (
            <section
              key={f.path}
              className="ss-fd"
              ref={(el) => {
                if (el) sections.current.set(f.path, el);
                else sections.current.delete(f.path);
              }}
            >
              <div className="ss-fdh mono">
                <button
                  type="button"
                  className="df-fold"
                  aria-label={t(
                    { id: 'components.diff.fileChanges', defaultMessage: 'Changes in {path}' },
                    { path: f.path },
                  )}
                  aria-expanded={open}
                  onClick={() => setFolded((now) => new Map(now).set(f.path, open))}
                >
                  {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </button>
                {files.length === 1 && <span className={`ss-fs ${status}`}>{status}</span>}
                <span className="df-path" title={f.path}>
                  {f.path}
                </span>
                {mark?.(f.path)}
                {whitespace && (
                  <span className="mu">
                    {t({
                      id: 'components.diff.whitespaceOnly',
                      defaultMessage: 'Only whitespace changes',
                    })}
                  </span>
                )}
                {counts(f)}
                <label className="df-hck">
                  {viewedBox(f.path)}
                  {t({ id: 'components.diff.viewed', defaultMessage: 'Viewed' })}
                </label>
                {action?.(f.path)}
              </div>
              {!open ? null : hunks.length === 0 ? (
                <div className="df-note mu">
                  {t({ id: 'components.diff.noTextChanges', defaultMessage: 'No text changes' })}
                </div>
              ) : (
                <div
                  className="ss-dl mono"
                  data-nowrap={!prefs.wrap || undefined}
                  style={{ tabSize: prefs.tab_size }}
                >
                  {hunks.map(
                    (h, i) =>
                      !hidden(i) && (
                        <Fragment key={i}>
                          <div className="ss-ln hh">{h.header}</div>
                          {hunkLines(f.path, h, i)}
                        </Fragment>
                      ),
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
