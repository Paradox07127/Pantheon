import { useMemo, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Users } from 'lucide-react';
import { DiffFiles, type DiffRead } from '../../components/DiffReview';
import { Select } from '../../components/Select';
import { ageText, useNow } from '../../data/needs-you';
import {
  landingPatch,
  useRepoCompare,
  useRepoLog,
  useRepoWorktrees,
  type RepoWorktree,
} from '../../data/repo';
import { useSessionList } from '../../data/workbench-sessions';
import { useStaleWorkspaces } from '../../data/worktree-setup';
import { t } from '../../i18n';
import { Failure, Skeleton } from '../board/BoardScreen';
import { Empty } from '../board/Charts';
import { WorktreeList } from './changes/WorktreeList';
import { CompareFacts, ConflictBlock, OverlapMatrix } from './compare/CompareParts';
import {
  compareSides,
  overlapOf,
  singleOwnerPaths,
  worktreeLabel,
  type CompareMode,
  type PickedSides,
} from './compare/model';
import './changes/changes.css';

/**
 * The worktrees at the left; beside them the picked one against main, or against a second picked
 * worktree, from their merge base: facts, who changes which files, the conflicts, then the diff.
 */
export function CompareTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const worktrees = useRepoWorktrees(projectId);
  const stale = useStaleWorkspaces(projectId);
  const sessions = useSessionList(projectId);
  const [mode, setMode] = useState<CompareMode>('main');
  const [picked, setPicked] = useState<PickedSides>({ base: null, head: null });
  const now = useNow(60_000);
  const list = worktrees.read ?? [];
  const { base, head } = compareSides(list, picked, mode);
  const same = !!base && base === head;
  const compared = base && head && !same ? projectId : null;
  const compare = useRepoCompare(compared, base?.head_sha ?? '', head?.head_sha ?? '');
  const reverse = useRepoCompare(compared, head?.head_sha ?? '', base?.head_sha ?? '');
  const read = compare.read;
  const mergeBase = read?.merge_base ?? '';
  const baseLog = useRepoLog(mergeBase ? projectId : null, 1, 0, mergeBase);
  const sideSessions = [base?.session_id, head?.session_id].filter(
    (id): id is string => id !== undefined,
  );
  const overlap = overlapOf(stale.read?.shared_files, sideSessions);
  const shared = new Set(overlap.rows.map((f) => f.path));
  const sharedKey = [...shared].join('\n');
  const data = useMemo<DiffRead['data']>(() => {
    if (!read) return null;
    const first = new Set(sharedKey.split('\n'));
    return {
      files: [
        ...read.files.filter((f) => first.has(f.path)),
        ...read.files.filter((f) => !first.has(f.path)),
      ],
      patch: landingPatch(read),
      truncated: read.truncated,
    };
  }, [read, sharedKey]);

  if (!worktrees.read) {
    if (worktrees.error)
      return (
        <div className="bd-s12">
          <Failure error={worktrees.error} onRetry={worktrees.reload} />
        </div>
      );
    return (
      <div className="bd-s12">
        <Skeleton />
      </div>
    );
  }
  if (!base || !head)
    return (
      <div className="bd-s12">
        <Empty text={t({ id: 'repo.compare.empty', defaultMessage: 'Nothing to compare yet' })} />
      </div>
    );
  const main = list.find((w) => w.kind === 'checkout') ?? list[0]!;
  const options = list.map((w) => ({ value: w.path, label: worktreeLabel(w) }));
  const markLabel = t({
    id: 'repo.compare.overlap.mark',
    defaultMessage: 'Changed by several sessions',
  });
  const listed = (w: RepoWorktree) => sessions.data?.find((s) => s.id === w.session_id);
  const columns = overlap.columns.map((id) => {
    const side = base.session_id === id ? base : head;
    const session = listed(side);
    return { id, name: session?.title || worktreeLabel(side), runtime: session?.runtime ?? '' };
  });
  const sideOf = (w: RepoWorktree) => ({
    branch: worktreeLabel(w),
    runtime: listed(w)?.runtime ?? '',
  });
  const headSession = listed(head);
  const resolver =
    head.session_id !== undefined
      ? {
          id: head.session_id,
          name: headSession?.title || worktreeLabel(head),
          state: headSession?.state ?? '',
        }
      : null;
  const singles = read ? singleOwnerPaths(read.files, stale.read?.shared_files) : [];
  const singleCount = read?.single_owner_files ?? 0;
  const conflicts = read?.conflicts ?? [];
  const mergeBaseAt = baseLog.read?.commits[0]?.committed_at ?? null;
  return (
    <div className="bd-s12 rcp">
      <WorktreeList
        projectId={projectId}
        worktrees={list}
        sessions={sessions.data}
        stale={stale}
        picked={head.path}
        onPick={(path) =>
          setPicked({ base: mode === 'pair' ? base.path : picked.base, head: path })
        }
        onOpenSession={onOpenSession}
        onPruned={worktrees.reload}
      />
      <section
        className="rcp-main"
        aria-label={t({ id: 'repo.compare.compare', defaultMessage: 'Compare' })}
      >
        <div className="rcp-bar">
          <RadioGroup<CompareMode>
            className="seg"
            aria-label={t({ id: 'repo.compare.mode', defaultMessage: 'Compare with' })}
            value={mode}
            onValueChange={(next) => setMode(next)}
          >
            <Radio.Root value="main">
              {t(
                { id: 'repo.compare.withMain', defaultMessage: 'Against {branch}' },
                { branch: worktreeLabel(main) },
              )}
            </Radio.Root>
            <Radio.Root value="pair">
              {t({ id: 'repo.compare.pair', defaultMessage: 'Two worktrees' })}
            </Radio.Root>
          </RadioGroup>
          {mode === 'pair' && (
            <>
              <Select
                aria-label={t({ id: 'repo.compare.base', defaultMessage: 'Base worktree' })}
                value={base.path}
                options={options}
                onChange={(path) => setPicked({ base: path, head: head.path })}
              />
              <span className="mu">{t({ id: 'repo.compare.and', defaultMessage: 'and' })}</span>
              <Select
                aria-label={t({ id: 'repo.compare.head', defaultMessage: 'Compared worktree' })}
                value={head.path}
                options={options}
                onChange={(path) => setPicked({ base: base.path, head: path })}
              />
            </>
          )}
          {!same && read?.previewed_at !== undefined && (
            <time className="rcp-age" dateTime={new Date(read.previewed_at).toISOString()}>
              {t(
                { id: 'repo.compare.previewed', defaultMessage: 'Merge previewed {age}' },
                { age: ageText(read.previewed_at, now) },
              )}
            </time>
          )}
        </div>
        <div className="rcp-body">
          {same ? (
            <Empty
              text={t({
                id: 'repo.compare.same',
                defaultMessage: 'Both sides are the same worktree',
              })}
            />
          ) : compare.error && !read ? (
            <Failure error={compare.error} onRetry={compare.reload} />
          ) : read && read.files.length === 0 ? (
            <Empty
              text={t(
                {
                  id: 'repo.compare.noChanges',
                  defaultMessage: '{head} has no changes against {base}',
                },
                { head: worktreeLabel(head), base: worktreeLabel(base) },
              )}
            />
          ) : (
            <>
              <CompareFacts
                compare={read}
                reverse={reverse.read}
                baseAt={mergeBaseAt}
                now={now}
                base={worktreeLabel(base)}
                head={worktreeLabel(head)}
              />
              {(overlap.rows.length > 0 || singleCount > 0) && (
                <OverlapMatrix
                  rows={overlap.rows}
                  columns={columns}
                  conflicts={new Set(conflicts.map((c) => c.path))}
                  singles={singles}
                  singleCount={singleCount}
                />
              )}
              {conflicts.map((c) => (
                <ConflictBlock
                  key={c.path}
                  conflict={c}
                  base={sideOf(base)}
                  head={sideOf(head)}
                  resolver={resolver}
                  folder={head.path}
                />
              ))}
              <DiffFiles
                diff={{ data, error: compare.error, reload: compare.reload }}
                mark={(path) =>
                  shared.has(path) && (
                    <Users className="ic-sm rcp-mark" role="img" aria-label={markLabel} />
                  )
                }
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}
