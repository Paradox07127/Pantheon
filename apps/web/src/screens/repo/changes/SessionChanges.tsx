import { useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { ChangeStory } from '@pantheon/domain';
import type { SessionGates, SessionPreflight, WorkbenchSession } from '@pantheon/protocol';
import { Check, X } from 'lucide-react';
import { DiffCounts } from '../../../components/DiffCounts';
import { DiffFiles } from '../../../components/DiffReview';
import { RuntimeGlyph, runtimeName } from '../../../components/RuntimeGlyph';
import { Tip } from '../../../components/Tip';
import { useBoard } from '../../../data/board';
import { useChangeStories, useChangeStoryDiff } from '../../../data/change-story';
import { runCommand } from '../../../data/commands';
import { shortId } from '../../../data/format';
import { failureText } from '../../../data/needs-you';
import type { RepoWorktree } from '../../../data/repo';
import { useSessionReviews } from '../../../data/session-panel';
import { t } from '../../../i18n';
import { listText } from '../../../lib/list-text';
import {
  findingOpen,
  gateSummary,
  reviewFindings,
  sessionStory,
  worktreeReason,
} from '../../sessions/model';
import {
  blockedText,
  CancelOperation,
  GATE,
  gateCount,
  MergeDialog,
  StoryTab,
} from '../../sessions/panel';
import { useSessionCard } from '../../sessions/SessionCard';
import { fail, readFailed } from '../../sessions/shared';
import { HunkLines } from '../../sessions/story/parts';
import { KIND, outOfScopeText, StoryView } from '../../sessions/story/StoryView';
import { EmptyState } from '../../../components/EmptyState';

type View = 'story' | 'files' | 'uninterpreted';

// The tab last picked on each project's session changes while the app runs.
const pickedViews = new Map<string, View>();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The age of an interpretation as a unit and a count, for one message to word. */
function age(ms: number): { unit: 'now' | 'minute' | 'hour' | 'day'; count: number } {
  if (ms < MINUTE) return { unit: 'now', count: 0 };
  if (ms < HOUR) return { unit: 'minute', count: Math.floor(ms / MINUTE) };
  if (ms < DAY) return { unit: 'hour', count: Math.floor(ms / HOUR) };
  return { unit: 'day', count: Math.floor(ms / DAY) };
}

const passedText = (count: number) =>
  t({ id: 'sessions.mergeBar.passed', defaultMessage: '{count} passed' }, { count });
const failedText = (count: number) =>
  t({ id: 'sessions.mergeBar.failed', defaultMessage: '{count} failed' }, { count });
const skippedText = (count: number) =>
  t({ id: 'sessions.mergeBar.skipped', defaultMessage: '{count} skipped' }, { count });
const runningText = (count: number) =>
  t({ id: 'sessions.mergeBar.running', defaultMessage: '{count} running' }, { count });

/**
 * One line of merge readiness: the branch and its distance from the target, the gate counts with
 * skipped apart from passed, and the session, gate rerun and merge actions.
 */
function MergeRow({
  sessionId,
  revision,
  worktree,
  live,
  mergeable,
  merging,
  cancelling,
  preflight,
  onPreflight,
  gates,
  onGates,
  listed,
  head,
  target,
  source,
  onOpenSession,
}: {
  sessionId: string;
  revision: number | null;
  worktree: RepoWorktree;
  live: boolean;
  mergeable: boolean;
  merging: boolean;
  cancelling?: boolean;
  preflight: SessionPreflight | null;
  onPreflight: () => void;
  gates: SessionGates | null;
  onGates: () => void;
  listed: WorkbenchSession | null;
  head: string | null;
  target: string | null;
  source: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { gate, passed, failed, skipped, running, total } = gateCount(
    preflight,
    gates,
    listed?.gate,
  );
  const counted =
    running !== null
      ? listText(
          passedText(passed),
          runningText(running),
          failed > 0 && failedText(failed),
          skipped > 0 && skippedText(skipped),
        )
      : ['passed', 'failed', 'stale'].includes(gate)
        ? listText(
            passedText(passed),
            failed > 0 && failedText(failed),
            skipped > 0 && skippedText(skipped),
          )
        : GATE[gate as keyof typeof GATE].word;
  const rest = total - passed - failed - skipped - (running ?? 0);
  const ran = gates?.last && !gates.running ? gates.last.commit : null;
  const earlier = !!ran && !!head && ran !== head && preflight?.gate.last === 'stale';
  const blocked = preflight && !preflight.can_merge ? blockedText(preflight.blocked_reason) : null;
  const reason =
    blocked ??
    (earlier
      ? t({
          id: 'sessions.mergeBar.earlierCommit',
          defaultMessage: 'The gates ran on an earlier commit',
        })
      : null);
  const into = preflight ? preflight.target_branch : target;
  const gating = ['running', 'cancelling'].includes(gate);
  const rerun = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand('session.gates.run', { session_id: sessionId }, revision).catch(
      fail,
    );
    setBusy(false);
    if (result.ok) {
      onPreflight();
      onGates();
    } else setError(failureText(result.error));
  };
  const merge = (
    <button
      type="button"
      className="btn pri sm"
      disabled={!preflight || merging}
      aria-disabled={reason ? true : undefined}
      aria-busy={merging || undefined}
      onClick={
        reason || !preflight || merging
          ? undefined
          : () => {
              onPreflight();
              setConfirm(true);
            }
      }
    >
      {merging
        ? t({ id: 'sessions.panel.merge.merging', defaultMessage: 'Merging' })
        : into
          ? t(
              { id: 'sessions.panel.merge.mergeInto', defaultMessage: 'Merge into {target}…' },
              { target: into },
            )
          : t({ id: 'sessions.panel.merge.merge', defaultMessage: 'Merge…' })}
    </button>
  );
  return (
    <>
      <div className="rcs-row">
        <span className="rcs-br" title={worktree.branch ?? worktree.head_sha}>
          {worktree.branch ?? shortId(worktree.head_sha)}
        </span>
        <span>
          {t(
            { id: 'repo.changes.ahead', defaultMessage: '{count} ahead' },
            { count: worktree.ahead },
          )}
        </span>
        <span>
          {t(
            { id: 'repo.changes.behind', defaultMessage: '{count} behind' },
            { count: worktree.behind },
          )}
        </span>
        {mergeable && (
          <>
            <span className="rcs-vs" aria-hidden="true" />
            {total > 0 && (
              <span
                className="rcs-seg"
                role="img"
                aria-label={t(
                  {
                    id: 'repo.changes.gateBar',
                    defaultMessage:
                      '{total, plural, one {Gates, # step} other {Gates, # steps}}: {counts}',
                  },
                  { total, counts: counted },
                )}
              >
                <span className="ss-pseg">
                  {passed > 0 && <i style={{ flexGrow: passed }} />}
                  {failed > 0 && <i data-tone="bad" style={{ flexGrow: failed }} />}
                  {!!running && <i data-tone="run" style={{ flexGrow: running }} />}
                  {skipped > 0 && <i data-tone="idle" style={{ flexGrow: skipped }} />}
                  {rest > 0 && <i data-tone="none" style={{ flexGrow: rest }} />}
                </span>
              </span>
            )}
            <span className="rcs-gate">{counted}</span>
          </>
        )}
        <span className="rcs-acts">
          <button type="button" className="btn ghost sm" onClick={() => onOpenSession(sessionId)}>
            {t({ id: 'repo.changes.openSession', defaultMessage: 'Open session' })}
          </button>
          {live && mergeable && (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={busy || merging || gating}
                aria-busy={busy || undefined}
                onClick={() => void rerun()}
              >
                {t({ id: 'sessions.mergeBar.rerun', defaultMessage: 'Rerun gates' })}
              </button>
              {reason ? <Tip content={reason}>{merge}</Tip> : merge}
              {merging && (
                <CancelOperation
                  kind="merge"
                  sessionId={sessionId}
                  revision={revision}
                  cancelling={cancelling}
                  onAccepted={onPreflight}
                />
              )}
              {(preflight || confirm) && (
                <MergeDialog
                  open={confirm}
                  sessionId={sessionId}
                  revision={revision}
                  preflight={preflight}
                  source={source}
                  onClose={() => setConfirm(false)}
                />
              )}
            </>
          )}
        </span>
      </div>
      {error && (
        <div className="ss-cerr rcs-err" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

/** The ready story's before and after, who wrote it and when with its rerun, over its cards. */
function StoryList({
  sessionId,
  listed,
  story,
  picked,
  onPick,
  onStarted,
}: {
  sessionId: string;
  listed: WorkbenchSession | null;
  story: ChangeStory;
  picked: number;
  onPick: (index: number) => void;
  onStarted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const result = story.result!;
  const reason = listed ? worktreeReason(listed) : null;
  const ago = age(Date.now() - story.created_at);
  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const started = await runCommand('change_story.start', { session_id: sessionId }, null).catch(
      fail,
    );
    setBusy(false);
    if (started.ok) onStarted();
    else setError(failureText(started.error));
  }
  const again = (
    <button
      type="button"
      className="btn ghost sm"
      aria-disabled={reason !== null || busy || undefined}
      aria-busy={busy || undefined}
      onClick={reason || busy ? undefined : () => void start()}
    >
      {t({ id: 'repo.changes.reinterpret', defaultMessage: 'Interpret again' })}
    </button>
  );
  return (
    <>
      <div className="rcs-sum">
        <dl className="rcs-ba">
          <dt>{t({ id: 'sessions.panel.story.before', defaultMessage: 'Before' })}</dt>
          <dd>
            {result.overall.before.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </dd>
          <dt>{t({ id: 'sessions.panel.story.after', defaultMessage: 'After' })}</dt>
          <dd>
            {result.overall.after.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </dd>
        </dl>
        <div className="rcs-by">
          {story.runtime && <RuntimeGlyph runtime={story.runtime} size={14} />}
          <span className="rcs-age">
            {t(
              {
                id: 'repo.changes.storyBy',
                defaultMessage:
                  '{runtime} interpreted {unit, select, now {just now} minute {{count, plural, one {# minute} other {# minutes}} ago} hour {{count, plural, one {# hour} other {# hours}} ago} other {{count, plural, one {# day} other {# days}} ago}}',
              },
              { runtime: runtimeName(story.runtime ?? null), ...ago },
            )}
          </span>
          {reason ? <Tip content={reason}>{again}</Tip> : again}
        </div>
        {error && (
          <span className="ss-cerr" role="alert">
            {error}
          </span>
        )}
        {story.outdated && (
          <span role="status">
            {t({
              id: 'sessions.panel.story.outdated',
              defaultMessage: 'The commits, task contract or check evidence have changed',
            })}
          </span>
        )}
      </div>
      <ul
        className="rcs-cards"
        aria-label={t({ id: 'repo.changes.cards', defaultMessage: 'Change story cards' })}
      >
        {result.cards.map((card, i) => {
          const passed = card.evidence.every((e) => e.status === 'passed');
          return (
            <li key={i}>
              <button
                type="button"
                className="rcs-card"
                aria-pressed={i === picked}
                onClick={() => onPick(i)}
              >
                <span className="chip">{KIND[card.kind]}</span>
                <span className="rcs-ct">{card.title}</span>
                {card.out_of_scope && <span className="chip">{outOfScopeText()}</span>}
                <span className="rcs-n">
                  {t(
                    {
                      id: 'repo.changes.hunks',
                      defaultMessage: '{count, plural, one {# hunk} other {# hunks}}',
                    },
                    { count: card.hunks.length },
                  )}
                </span>
                {card.evidence.length > 0 && (
                  <span
                    className="rcs-ev"
                    data-tone={passed ? 'ok' : 'bad'}
                    role="img"
                    aria-label={
                      passed
                        ? t({
                            id: 'repo.changes.evidencePassed',
                            defaultMessage: 'The cited tests passed',
                          })
                        : t({
                            id: 'repo.changes.evidenceFailed',
                            defaultMessage: 'A cited test failed',
                          })
                    }
                  >
                    {passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * A session worktree's change story beside the picked card, or its files beside their diff, under
 * one line of merge readiness; read as the session page reads them.
 */
export function SessionChanges({
  sessionId,
  listed,
  worktree,
  onOpenSession,
}: {
  sessionId: string;
  listed: WorkbenchSession | null;
  worktree: RepoWorktree;
  onOpenSession: (sessionId: string) => void;
}) {
  const session = useBoard((s) => s.board?.sessions.find((k) => k.id === sessionId) ?? null);
  const {
    worktree: hasWorktree,
    mergeable,
    ended,
    live,
    diff,
    gates,
    preflight,
    projectId,
    branch,
    block,
    merging,
    title,
  } = useSessionCard(sessionId, listed, session);
  const reviews = useSessionReviews(hasWorktree ? sessionId : null);
  const stories = useChangeStories(projectId);
  const story = stories.read ? sessionStory(stories.read, sessionId) : null;
  const ready = story?.state === 'ready' && story.result ? story : null;
  const storyDiff = useChangeStoryDiff(ready);
  const [view, setView] = useState<View | null>(null);
  const [picked, setPicked] = useState(0);
  const findings = reviews.data ? reviewFindings(reviews.data).filter(findingOpen) : [];
  const result = ready?.result ?? null;
  const hunks = new Map((storyDiff.data?.hunks ?? []).map((h) => [h.id, h]));
  const loose = new Map<string, string[]>();
  for (const id of result?.uninterpreted ?? []) {
    const file = hunks.get(id)?.file ?? id;
    loose.set(file, [...(loose.get(file) ?? []), id]);
  }
  const files = diff.data?.files ?? [];
  const shown = result ? Math.min(picked, Math.max(result.cards.length - 1, 0)) : 0;
  const merge = mergeable && (live || block !== null || gateSummary(gates.data) !== 'none');
  const wanted = view ?? (projectId ? pickedViews.get(projectId) : undefined);
  const shownView =
    wanted && (wanted !== 'uninterpreted' || result) ? wanted : ready ? 'story' : 'files';
  return (
    <div className="rcs">
      <section
        className="rcs-mid"
        aria-label={t({ id: 'repo.changes.storyColumn', defaultMessage: 'Change story' })}
      >
        <div className="rpc-bar">
          <RadioGroup<View>
            className="tb-seg"
            aria-label={t({ id: 'repo.changes.view', defaultMessage: 'List changes by' })}
            value={shownView}
            onValueChange={(value) => {
              if (projectId) pickedViews.set(projectId, value);
              setView(value);
            }}
          >
            <Radio.Root value="story">
              {t({ id: 'repo.changes.story', defaultMessage: 'Story' })}
            </Radio.Root>
            <Radio.Root value="files">
              {t({ id: 'repo.changes.files', defaultMessage: 'Files' })}
              <span className="rcs-tc">{files.length}</span>
            </Radio.Root>
            {result && (
              <Radio.Root value="uninterpreted">
                {t({ id: 'repo.changes.uninterpreted', defaultMessage: 'Uninterpreted' })}
                <span className="rcs-tc">{loose.size}</span>
              </Radio.Root>
            )}
          </RadioGroup>
        </div>
        {shownView === 'files' ? (
          <ul
            className="rcs-files"
            aria-label={t({ id: 'repo.changes.changedFiles', defaultMessage: 'Changed files' })}
          >
            {files.map((file) => (
              <li key={file.path} className="rcs-file">
                <span className="rpc-path mono" title={file.path}>
                  {file.path}
                </span>
                <span className="rpl-n mono">
                  <DiffCounts additions={file.additions} deletions={file.deletions} />
                </span>
              </li>
            ))}
          </ul>
        ) : shownView === 'uninterpreted' ? (
          <ul
            className="rcs-files"
            aria-label={t({
              id: 'repo.changes.uninterpretedFiles',
              defaultMessage: 'Uninterpreted files',
            })}
          >
            {[...loose].map(([file, ids]) => (
              <li key={file} className="rcs-file">
                <span className="rpc-path mono" title={file}>
                  {file}
                </span>
                <span className="rcs-n">
                  {t(
                    {
                      id: 'repo.changes.hunks',
                      defaultMessage: '{count, plural, one {# hunk} other {# hunks}}',
                    },
                    { count: ids.length },
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : ready ? (
          <StoryList
            key={ready.id}
            sessionId={sessionId}
            listed={listed}
            story={ready}
            picked={shown}
            onPick={setPicked}
            onStarted={stories.reload}
          />
        ) : (
          <div className="rpc-body">
            <StoryTab
              sessionId={sessionId}
              projectId={projectId}
              listed={listed}
              diff={diff.data}
              findings={findings}
            />
          </div>
        )}
      </section>
      <section
        className="rcs-det"
        aria-label={t({ id: 'repo.changes.detail', defaultMessage: 'Details' })}
      >
        {merge && (block || preflight.error) && (
          <div className="rpc-merge">
            {block && (
              <div className="ss-cerr" role="alert">
                {block.text}
              </div>
            )}
            {readFailed(preflight)}
          </div>
        )}
        <MergeRow
          sessionId={sessionId}
          revision={session?.revision ?? null}
          worktree={worktree}
          live={live}
          mergeable={merge}
          merging={merging}
          cancelling={listed?.merge?.cancel_requested}
          preflight={preflight.data}
          onPreflight={preflight.reload}
          gates={gates.data}
          onGates={gates.reload}
          listed={listed}
          head={diff.data?.head_sha ?? null}
          target={branch}
          source={title}
          onOpenSession={onOpenSession}
        />
        <div className="rpc-body">
          {shownView !== 'files' && readFailed(storyDiff)}
          {shownView === 'files' ? (
            ended && listed?.state !== 'merged' ? (
              <EmptyState inline title={ended} />
            ) : (
              <DiffFiles diff={diff} />
            )
          ) : shownView === 'uninterpreted' ? (
            <div className="rcs-hunks">
              {(result?.uninterpreted ?? []).map((id) => {
                const hunk = hunks.get(id);
                return hunk ? (
                  <div key={id}>
                    <div className="rcs-hf mono">
                      <span className="rpc-path">{hunk.file}</span>
                      <span>{id}</span>
                    </div>
                    <HunkLines hunk={hunk} />
                  </div>
                ) : null;
              })}
            </div>
          ) : ready && result ? (
            <StoryView
              point={{
                kind: 'landed',
                workspace_id: listed?.workspace_id ?? '',
                task_goal: title,
                source: ready.source,
                branch: null,
                from_sha: ready.from_sha,
                to_sha: ready.to_sha,
                at: ready.created_at,
              }}
              story={ready}
              result={result}
              diff={storyDiff.data}
              findings={findings}
              selected={shown}
              onSelect={setPicked}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
