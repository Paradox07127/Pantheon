import { useState, type ReactNode } from 'react';
import { openFailureText } from '../../../components/Markdown';
import { RuntimeGlyph } from '../../../components/RuntimeGlyph';
import { useBoard } from '../../../data/board';
import { runCommand } from '../../../data/commands';
import { ageText, failureText } from '../../../data/needs-you';
import type { RepoCompare, RepoConflict } from '../../../data/repo';
import { t } from '../../../i18n';
import { Panel } from '../../board/Charts';
import { messageCommand } from '../../sessions/model';
import { bothChanged, shortSha } from './model';
import './compare.css';

const lineText = (line: number) =>
  t({ id: 'repo.compare.line', defaultMessage: 'Line {line}' }, { line });

const conflictText = () => t({ id: 'repo.compare.conflict', defaultMessage: 'Would conflict' });

/**
 * Merge base, the files both sides change, the conflicts and which side merges first; the cells
 * stand empty until the read lands. `reverse` is base read from the same merge base.
 */
export function CompareFacts({
  compare,
  reverse,
  baseAt,
  now,
  base,
  head,
}: {
  compare: RepoCompare | null;
  reverse: RepoCompare | null;
  baseAt: number | null;
  now: number;
  base: string;
  head: string;
}) {
  const conflicts = compare?.conflicts;
  const first = conflicts?.[0];
  const both = compare && reverse ? bothChanged(compare.files, reverse.files).length : null;
  const fact = (label: string, value: ReactNode) => (
    <div className="rcp-fact">
      <dt className="cap">{label}</dt>
      <dd>{compare ? value : null}</dd>
    </div>
  );
  return (
    <dl className="panel rcp-facts" aria-busy={!compare || undefined}>
      {fact(
        t({ id: 'repo.compare.mergeBase', defaultMessage: 'Common base' }),
        <>
          <span className="rcp-sha">{shortSha(compare?.merge_base ?? '')}</span>
          {baseAt !== null && (
            <time className="rcp-delta" dateTime={new Date(baseAt).toISOString()}>
              {ageText(baseAt, now)}
            </time>
          )}
        </>,
      )}
      {fact(
        t({ id: 'repo.compare.both', defaultMessage: 'Files both sides change' }),
        both !== null && (
          <>
            <span className="kpi">{both}</span>
            <span className="rcp-delta">
              {t(
                {
                  id: 'repo.compare.bothSides',
                  defaultMessage: '{base} and {head, plural, one {# file} other {# files}}',
                },
                { base: reverse!.files.length, head: compare!.files.length },
              )}
            </span>
          </>
        ),
      )}
      {(!compare || conflicts) &&
        fact(
          conflictText(),
          <>
            <span className="kpi">{conflicts?.length}</span>
            {first && first.line !== null && (
              <span className="rcp-delta">{lineText(first.line)}</span>
            )}
          </>,
        )}
      {conflicts &&
        conflicts.length > 0 &&
        fact(
          t(
            { id: 'repo.compare.mergeFirst', defaultMessage: 'Merge {branch} first' },
            { branch: base },
          ),
          <>
            <span className="kpi">{conflicts.length}</span>
            <span className="rcp-delta">
              {t(
                {
                  id: 'repo.compare.resolves',
                  defaultMessage:
                    '{count, plural, one {conflict for {branch} to resolve} other {conflicts for {branch} to resolve}}',
                },
                { count: conflicts.length, branch: head },
              )}
            </span>
          </>,
        )}
    </dl>
  );
}

export interface OverlapColumn {
  id: string;
  name: string;
  runtime: string;
}

/**
 * One row per shared file, one column per compared session, a mark where that session changes it,
 * then the files only one session changes, listed on demand.
 */
export function OverlapMatrix({
  rows,
  columns,
  conflicts,
  singles,
  singleCount,
}: {
  rows: { path: string; session_ids: string[] }[];
  columns: OverlapColumn[];
  conflicts: ReadonlySet<string>;
  singles: readonly string[];
  singleCount: number;
}) {
  const [open, setOpen] = useState(false);
  const title = t({
    id: 'repo.compare.overlap.title',
    defaultMessage: 'Who changes which files',
  });
  const changes = t({ id: 'repo.compare.overlap.changes', defaultMessage: 'Changing' });
  return (
    <Panel
      title={title}
      tools={
        <div className="legend">
          <span>
            <i className="rcp-on" aria-hidden="true" />
            {changes}
          </span>
          <span>
            <i className="rcp-cf" aria-hidden="true" />
            {conflictText()}
          </span>
        </div>
      }
    >
      {rows.length > 0 && (
        <table className="rcp-mx" aria-label={title}>
          <thead>
            <tr>
              <th
                scope="col"
                aria-label={t({ id: 'repo.compare.overlap.file', defaultMessage: 'File' })}
              />
              {columns.map((c) => (
                <th key={c.id} scope="col" className="rcp-mxs" aria-label={c.name} title={c.name}>
                  <span className="rcp-mxh" aria-hidden="true">
                    <RuntimeGlyph runtime={c.runtime} size={14} />
                  </span>
                </th>
              ))}
              <th
                scope="col"
                aria-label={t({ id: 'repo.compare.overlap.all', defaultMessage: 'All sessions' })}
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.path}>
                <th scope="row" className="rcp-mxp" title={f.path}>
                  {f.path}
                </th>
                {columns.map((c) => (
                  <td key={c.id} className="rcp-mxs">
                    {f.session_ids.includes(c.id) &&
                      (conflicts.has(f.path) ? (
                        <i className="rcp-cf" role="img" aria-label={conflictText()} />
                      ) : (
                        <i className="rcp-on" role="img" aria-label={changes} />
                      ))}
                  </td>
                ))}
                <td className="rcp-mxc">
                  {t(
                    {
                      id: 'repo.compare.overlap.count',
                      defaultMessage: '{count, plural, one {# session} other {# sessions}}',
                    },
                    { count: f.session_ids.length },
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {singleCount > 0 && (
        <div className="rcp-solo">
          <span>
            {t(
              {
                id: 'repo.compare.singles',
                defaultMessage:
                  '{count, plural, one {# more file only one session changes} other {# more files only one session changes}}',
              },
              { count: singleCount },
            )}
          </span>
          <button
            type="button"
            className="btn ghost sm"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open
              ? t({ id: 'repo.compare.singles.hide', defaultMessage: 'Collapse' })
              : t({ id: 'repo.compare.singles.show', defaultMessage: 'Expand' })}
          </button>
        </div>
      )}
      {open && singleCount > 0 && (
        <ul className="rcp-singles">
          {singles.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export interface ConflictSide {
  branch: string;
  runtime: string;
}

// Prompts stay in English whatever the interface language is.
const rebasePrompt = (conflict: RepoConflict, onto: string) =>
  `Rebase onto ${onto} and resolve the merge conflict in ${conflict.path}` +
  (conflict.line === null ? '.' : ` near line ${conflict.line}.`);

/**
 * One file's first conflict: each side's lines under its branch, then asking the head's session to
 * rebase onto base and resolve it, and opening the file in the head's worktree.
 */
export function ConflictBlock({
  conflict,
  base,
  head,
  resolver,
  folder,
}: {
  conflict: RepoConflict;
  base: ConflictSide;
  head: ConflictSide;
  resolver: { id: string; name: string; state: string } | null;
  folder: string;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = window.pantheon;
  const ask = async (session: NonNullable<typeof resolver>) => {
    setSending(true);
    setError(null);
    const listed = useBoard.getState().board?.sessions.find((s) => s.id === session.id);
    const result = await runCommand(
      messageCommand(listed?.state ?? session.state),
      { session_id: session.id, input: rebasePrompt(conflict, base.branch) },
      listed?.revision ?? null,
    );
    setSending(false);
    if (!result.ok) setError(failureText(result.error));
  };
  const open = () => {
    setError(null);
    void bridge
      ?.openFile({
        path: conflict.path,
        base: folder,
        ...(conflict.line === null ? {} : { line: conflict.line }),
      })
      .then((r) => {
        if (!r.ok) setError(openFailureText(r.error));
      });
  };
  const side = (s: ConflictSide, lines: string[]) => (
    <div className="rcp-side" role="group" aria-label={s.branch}>
      <div className="rcp-sh">
        <span aria-hidden="true">
          <RuntimeGlyph runtime={s.runtime} size={14} />
        </span>
        <span className="rcp-br">{s.branch}</span>
      </div>
      <pre className="rcp-code">{lines.join('\n')}</pre>
    </div>
  );
  return (
    <article className="rcp-cfb" aria-label={conflict.path}>
      <div className="rcp-fh">
        <span className="rcp-path" title={conflict.path}>
          {conflict.path}
        </span>
        <span className="chip rcp-chip">{conflictText()}</span>
        {conflict.line !== null && <span className="rcp-ln">{lineText(conflict.line)}</span>}
      </div>
      <div className="rcp-sides">
        {side(base, conflict.base_lines)}
        {side(head, conflict.head_lines)}
      </div>
      <div className="rcp-acts">
        {resolver && (
          <button
            type="button"
            className="btn sm"
            disabled={sending}
            onClick={() => void ask(resolver)}
          >
            {t(
              {
                id: 'repo.compare.askRebase',
                defaultMessage: 'Ask {session} to rebase first and resolve',
              },
              { session: resolver.name },
            )}
          </button>
        )}
        {bridge?.openFile && (
          <button type="button" className="btn ghost sm" onClick={open}>
            {t({ id: 'repo.compare.openInEditor', defaultMessage: 'Open in editor' })}
          </button>
        )}
        {error && (
          <span className="rcp-err" role="alert">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}
