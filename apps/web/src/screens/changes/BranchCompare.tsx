import { useState } from 'react';
import { ArrowLeft, FileDiff } from 'lucide-react';
import { Clip } from '../../components/Clip';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { Select } from '../../components/Select';
import { useRepoBranches, useRepoCompare, type RepoCompare } from '../../data/repo';
import { t } from '../../i18n';
import { HunkLines } from '../sessions/story/parts';
import { diffCells, fileBars } from './ChangedFiles';
import './branch-compare.css';

/** repo.compare lists at most this many conflicting files. */
const CONFLICT_BOUND = 20;

function facts(compare: RepoCompare) {
  const conflicts = compare.conflicts;
  const shared = compare.files.length - compare.single_owner_files;
  const fact = (name: string, label: string, value: number | string) => (
    <div className="chb-fact" data-fact={name}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
  return (
    <dl className="chb-facts">
      {fact(
        'ahead',
        t({ id: 'changes.commits.compare.ahead', defaultMessage: 'Ahead' }),
        compare.ahead,
      )}
      {fact(
        'behind',
        t({ id: 'changes.commits.compare.behind', defaultMessage: 'Behind' }),
        compare.behind,
      )}
      {conflicts &&
        fact(
          'conflicts',
          t({ id: 'changes.commits.compare.conflicts', defaultMessage: 'Conflicting files' }),
          conflicts.length >= CONFLICT_BOUND
            ? t(
                { id: 'changes.commits.compare.conflictsBound', defaultMessage: '{count} or more' },
                { count: CONFLICT_BOUND },
              )
            : conflicts.length,
        )}
      {fact(
        'single',
        t({ id: 'changes.commits.compare.single', defaultMessage: 'Only this branch changes' }),
        compare.single_owner_files,
      )}
      {fact(
        'shared',
        t({ id: 'changes.commits.compare.shared', defaultMessage: 'Other sessions also change' }),
        shared,
      )}
    </dl>
  );
}

function conflictList(compare: RepoCompare) {
  const conflicts = compare.conflicts;
  if (!conflicts) return null;
  if (conflicts.length === 0)
    return (
      <span className="chg-mu">
        {t({ id: 'changes.commits.compare.noConflicts', defaultMessage: 'No conflicts' })}
      </span>
    );
  return (
    <ul
      className="chb-conflicts"
      aria-label={t({
        id: 'changes.commits.compare.conflictList',
        defaultMessage: 'Files that would conflict',
      })}
    >
      {conflicts.map((c) => (
        <li key={c.path} className="chb-conflict">
          <Clip text={c.path} className="mono" />
          {c.line !== null && (
            <span className="chg-mu chg-num">
              {t(
                { id: 'changes.commits.compare.line', defaultMessage: 'Line {line}' },
                { line: c.line },
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Two of the project's branches: how far apart they are, what would conflict, and head's diff. */
export function BranchCompare({ projectId }: { projectId: string | null }) {
  const branches = useRepoBranches(projectId);
  const [picked, setPicked] = useState<{ base: string | null; head: string | null }>({
    base: null,
    head: null,
  });
  const [file, setFile] = useState<string | null>(null);
  const list = branches.read ?? [];
  const base =
    list.find((b) => b.name === picked.base) ?? list.find((b) => b.checked_out) ?? list[0];
  // The list is newest commit first.
  const head =
    list.find((b) => b.name === picked.head && b !== base) ?? list.find((b) => b !== base);
  // project.branches names local branches; a tag of the same name must not answer for one.
  const compare = useRepoCompare(
    base && head ? projectId : null,
    base ? `refs/heads/${base.name}` : '',
    head ? `refs/heads/${head.name}` : '',
  );
  const branchFailure = branches.error && (
    <Failure error={branches.error} onRetry={branches.reload} />
  );
  if (!branches.read) return branchFailure || <Skeleton />;
  if (!base || !head)
    return (
      <>
        {branchFailure}
        <EmptyState
          inline
          title={t({
            id: 'changes.commits.compare.none',
            defaultMessage: 'No other branch to compare',
          })}
        />
      </>
    );
  const options = list.map((b) => ({ value: b.name, label: b.name }));
  const read = compare.read;
  const files = read?.files ?? [];
  const shown = files.find((f) => f.path === file) ?? files[0];
  const hunks = shown ? (read?.hunks ?? []).filter((h) => h.file === shown.path) : [];
  const sum = (key: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const filesName = t({ id: 'changes.commits.files', defaultMessage: 'Changed files' });
  return (
    <div className="chb">
      {branchFailure}
      <div className="chb-bar">
        <Select
          aria-label={t({ id: 'changes.commits.compare.base', defaultMessage: 'Base branch' })}
          value={base.name}
          options={options}
          onChange={(name) =>
            setPicked({ base: name, head: name === head.name ? base.name : head.name })
          }
        />
        <ArrowLeft className="ic-sm chg-mu" aria-hidden="true" />
        <Select
          aria-label={t({ id: 'changes.commits.compare.head', defaultMessage: 'Compared branch' })}
          value={head.name}
          options={options}
          onChange={(name) =>
            setPicked({ base: name === base.name ? head.name : base.name, head: name })
          }
        />
      </div>
      {compare.error && <Failure error={compare.error} onRetry={compare.reload} />}
      {read ? (
        <>
          {facts(read)}
          {conflictList(read)}
          <section className="chg-sec" aria-label={filesName}>
            <div className="chg-sec-h">
              <FileDiff className="ic-sm chg-mu" aria-hidden="true" />
              <b>{filesName}</b>
              <span className="chg-dsum">{diffCells(sum('additions'), sum('deletions'))}</span>
            </div>
            {files.length ? (
              fileBars(
                files,
                setFile,
                (path) =>
                  t(
                    { id: 'changes.commits.showFile', defaultMessage: '{path}, shows its diff' },
                    { path },
                  ),
                shown?.path,
              )
            ) : (
              <span className="chg-mu">
                {t({ id: 'changes.files.none', defaultMessage: 'No changed files.' })}
              </span>
            )}
          </section>
          {shown && (
            <section
              className="chc-diff"
              aria-label={t(
                { id: 'changes.commits.fileDiff', defaultMessage: 'Changes in {path}' },
                { path: shown.path },
              )}
            >
              {read.truncated ? (
                <span className="chg-mu">
                  {t({
                    id: 'changes.commits.truncated',
                    defaultMessage: 'Too many changes to show in full',
                  })}
                </span>
              ) : hunks.length === 0 ? (
                <span className="chg-mu">
                  {t({ id: 'changes.commits.noText', defaultMessage: 'No text changes' })}
                </span>
              ) : (
                hunks.map((hunk) => <HunkLines key={hunk.id} hunk={hunk} />)
              )}
            </section>
          )}
        </>
      ) : (
        !compare.error && <Skeleton />
      )}
    </div>
  );
}
