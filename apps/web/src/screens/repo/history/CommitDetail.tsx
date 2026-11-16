import { Fragment, useMemo, useRef, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { StoryAnchor, StoryResult } from '@pantheon/domain';
import { Check, Folder, GitCommitHorizontal, GitMerge, Minus, X } from 'lucide-react';
import { DiffStat, numbered, sideBySide } from '../../../components/DiffReview';
import { IdText } from '../../../components/IdText';
import { RuntimeGlyph } from '../../../components/RuntimeGlyph';
import { SessionStateIcon } from '../../../components/SessionStateIcon';
import { useChangeStories } from '../../../data/change-story';
import { ageText, useNow } from '../../../data/needs-you';
import { parsePatch, type DiffFile } from '../../../data/patch';
import {
  landingPatch,
  useRepoCommitAfter,
  useRepoCommitDiff,
  useRepoLog,
} from '../../../data/repo';
import { pushBranch, revertCommit, type LocalResult } from '../../../data/repo-local';
import { useProjectHead } from '../../../data/runtime-models';
import { useSessionList } from '../../../data/workbench-sessions';
import { t } from '../../../i18n';
import { useShell } from '../../../store';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { durationText } from '../../board/panels-model';
import { layoutFlow } from '../../sessions/story/story-diagram';
import { StoryDiagram } from '../../sessions/story/StoryDiagram';
import { openRepoView } from '../route';
import { LOG_PAGE, landedStory, sessionName, shortSha } from './CommitGraph';
import './history.css';

/** One step of a flow; change marks a step only one side has. */
interface Step {
  label: string;
  at: string | null;
  change?: 'add' | 'del';
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** Lines of the message body shown before it is expanded. */
const BODY_LINES = 3;

/** The anchor as file:line on one side of the diff, or the file alone when no shown line holds its quote. */
function anchorText(
  files: Map<string, DiffFile>,
  anchor: StoryAnchor | undefined,
  side: 'old' | 'new',
): string | null {
  if (!anchor) return null;
  const line = (files.get(anchor.file)?.hunks ?? [])
    .flatMap(numbered)
    .find((l) => l[side] !== null && l.text.includes(anchor.quote));
  return line ? `${baseName(anchor.file)}:${line[side]}` : baseName(anchor.file);
}

/** Each flow diagram's steps before and after in layout order; the overall lines when the story has none. */
function storyFlows(result: StoryResult, files: Map<string, DiffFile>) {
  const flows = result.cards.flatMap((card) => {
    const spec = card.diagram?.spec;
    if (spec?.type !== 'flow') return [];
    const boxes = new Map(layoutFlow(spec).nodes.map((n) => [n.id, n]));
    const order = [...spec.nodes].sort(
      (a, b) => boxes.get(a.id)!.x - boxes.get(b.id)!.x || boxes.get(a.id)!.y - boxes.get(b.id)!.y,
    );
    const steps = (side: 'before' | 'after'): Step[] =>
      order
        .filter((n) => n.side === side || n.side === 'both')
        .map((n): Step => ({
          label: n.label,
          at: anchorText(files, n.anchor, side === 'before' ? 'old' : 'new'),
          ...(n.side === side ? { change: side === 'before' ? 'del' : 'add' } : {}),
        }));
    return [{ title: card.title, before: steps('before'), after: steps('after') }];
  });
  if (flows.length > 0 || result.overall.before.length + result.overall.after.length === 0)
    return flows;
  const plain = (lines: string[]): Step[] => lines.map((label) => ({ label, at: null }));
  return [{ title: '', before: plain(result.overall.before), after: plain(result.overall.after) }];
}

/** Files under their folder, each folder once where the diff first names it. */
function byFolder<F extends { path: string }>(files: readonly F[]) {
  const groups = new Map<string, F[]>();
  for (const f of files) {
    const dir = f.path.slice(0, Math.max(f.path.lastIndexOf('/'), 0));
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  return [...groups];
}

/** One commit: its files, what it changed before and after, its diff, and what followed it. */
export function CommitDetail({
  projectId,
  sha,
  onOpenSession,
}: {
  projectId: string;
  sha: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const log = useRepoLog(projectId, 1, 0, sha);
  const head = useRepoLog(projectId, LOG_PAGE, 0);
  const diff = useRepoCommitDiff(projectId, sha);
  const after = useRepoCommitAfter(projectId, sha);
  const branch = useProjectHead(projectId).read?.branch;
  const sessions = useSessionList(projectId);
  const stories = useChangeStories(projectId);
  const openSession = useShell((s) => s.openSession);
  const now = useNow(60_000);
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [asking, setAsking] = useState<'push' | 'revert' | null>(null);
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const changes = diff.read;
  const parsed = useMemo(() => {
    const patch = changes && landingPatch(changes);
    return new Map<string, DiffFile>(patch ? parsePatch(patch).map((f) => [f.path, f]) : []);
  }, [changes]);
  const commit = log.read?.commits.find((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));
  const session = commit?.session_id
    ? (sessions.data ?? []).find((s) => s.id === commit.session_id)
    : undefined;
  const child = commit && head.read?.commits.find((c) => c.parents[0] === commit.sha);
  const story = landedStory(stories.read, commit?.session_id);
  const result = story?.result;
  const flows = useMemo(() => (result ? storyFlows(result, parsed) : []), [result, parsed]);
  const diagrams = (result?.cards ?? []).filter(
    (card) => card.diagram && card.diagram.spec.type !== 'flow',
  );
  const files = changes?.files ?? [];
  const file = files.find((f) => f.path === picked) ?? files[0];
  const total = (key: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const facts = after.read;
  const gate = facts?.gate;
  const open = (to: string) => openRepoView(projectId, { kind: 'commit', sha: to });
  const pick = (path: string) => {
    setPicked(path);
    box.current?.scrollIntoView({ block: 'nearest' });
  };
  const ask = (action: 'push' | 'revert') => {
    setActionError(null);
    setAsking(action);
  };
  async function run<T>(action: Promise<LocalResult<T>>, done: (value: T) => void) {
    setRunning(true);
    setActionError(null);
    const result = await action;
    setRunning(false);
    if (!result.ok) return setActionError(result.error);
    setAsking(null);
    done(result.value);
  }
  const confirmPush = () => run(pushBranch(projectId), () => after.reload());
  const confirmRevert = () => run(revertCommit(projectId, sha), (value) => open(value.sha));
  const onBranch = branch ?? 'HEAD';
  const merged = facts?.session_merge ?? null;
  const pushable = !!facts?.upstream && facts.upstream.ahead > 0;
  const revertButton = (
    <button type="button" className="btn ghost sm" onClick={() => ask('revert')}>
      {t({ id: 'repo.commit.revert', defaultMessage: 'Revert…' })}
    </button>
  );
  const bodyLines = commit?.body ? commit.body.split('\n').length : 0;

  const counts = (additions: number, deletions: number) => (
    <span className="rh-n mono">
      <span className="df-add" data-zero={additions === 0 || undefined}>
        +{additions}
      </span>
      <span className="df-del" data-zero={deletions === 0 || undefined}>
        −{deletions}
      </span>
    </span>
  );
  const fileItem = (f: (typeof files)[number]) => (
    <li key={f.path}>
      <button
        type="button"
        className="rh-tf"
        aria-label={f.path}
        title={f.path}
        aria-current={f.path === file?.path || undefined}
        onClick={() => pick(f.path)}
      >
        <span className="mono rh-cut">{baseName(f.path)}</span>
        {f.additions !== null && <DiffStat additions={f.additions} deletions={f.deletions ?? 0} />}
      </button>
    </li>
  );
  const steps = (list: Step[], id: string, side: 'before' | 'after') => (
    <div>
      <span className="cap" id={id}>
        {side === 'before'
          ? t({ id: 'repo.history.before', defaultMessage: 'Before' })
          : t({ id: 'repo.history.after', defaultMessage: 'After' })}
      </span>
      <ol className="rh-steps" aria-labelledby={id}>
        {list.map((s, i) => (
          <li key={i} className="rh-step" data-change={s.change}>
            {s.change === 'del' ? (
              <del>{s.label}</del>
            ) : s.change === 'add' ? (
              <ins>{s.label}</ins>
            ) : (
              <span>{s.label}</span>
            )}
            {s.at && <span className="mono rh-at">{s.at}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
  const hunks = file ? (parsed.get(file.path)?.hunks ?? []) : [];

  return (
    <section
      className="bd-s12 rh-detail"
      aria-label={t(
        { id: 'repo.commit.label', defaultMessage: 'Commit {sha}' },
        { sha: shortSha(sha) },
      )}
    >
      {commit ? (
        <>
          <header className="rh-dh">
            {commit.parents.length > 1 ? (
              <GitMerge className="ic-sm" aria-hidden="true" />
            ) : (
              <GitCommitHorizontal className="ic-sm" aria-hidden="true" />
            )}
            <IdText id={commit.sha} />
            <h2 className="rh-title rh-cut">{commit.subject}</h2>
            {session && (
              <button type="button" className="rh-link" onClick={() => onOpenSession(session.id)}>
                <SessionStateIcon session={session} place="card" />
                <span className="rh-cut">{sessionName(session)}</span>
              </button>
            )}
            <time className="mu" dateTime={new Date(commit.committed_at).toISOString()}>
              {ageText(commit.committed_at, now)}
            </time>
            <span className="rh-nav">
              <button
                type="button"
                className="btn ghost sm"
                disabled={!commit.parents[0]}
                onClick={() => open(commit.parents[0]!)}
              >
                {t({ id: 'repo.commit.earlier', defaultMessage: 'Earlier commit' })}
              </button>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!child}
                onClick={() => child && open(child.sha)}
              >
                {t({ id: 'repo.commit.later', defaultMessage: 'Later commit' })}
              </button>
            </span>
          </header>
          <div className="rh-msg">
            {commit.body && (
              <p
                className="rh-body"
                data-clamp={(!expanded && bodyLines > BODY_LINES) || undefined}
              >
                {commit.body}
              </p>
            )}
            {bodyLines > BODY_LINES && (
              <button
                type="button"
                className="btn ghost sm"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded
                  ? t({ id: 'repo.commit.showLess', defaultMessage: 'Show less' })
                  : t({ id: 'repo.commit.showMore', defaultMessage: 'Show more' })}
              </button>
            )}
            <dl className="rh-kv">
              <dt>{t({ id: 'repo.commit.author', defaultMessage: 'Author' })}</dt>
              <dd className="rh-line">
                <span>{commit.author}</span>
                <span className="mono mu">{commit.author_email}</span>
              </dd>
              {commit.parents.length > 0 && (
                <>
                  <dt>
                    {t(
                      {
                        id: 'repo.commit.parents',
                        defaultMessage: '{count, plural, one {Parent} other {Parents}}',
                      },
                      { count: commit.parents.length },
                    )}
                  </dt>
                  <dd className="rh-line">
                    {commit.parents.map((parent) => (
                      <button
                        key={parent}
                        type="button"
                        className="rh-link mono"
                        title={parent}
                        onClick={() => open(parent)}
                      >
                        {shortSha(parent)}
                      </button>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </>
      ) : log.error ? (
        <Failure error={log.error} onRetry={log.reload} />
      ) : (
        <Skeleton />
      )}
      <div className="rh-cols">
        <aside
          className="rh-tree"
          aria-label={t({ id: 'repo.commit.files', defaultMessage: 'Changed files' })}
        >
          {changes ? (
            <>
              <div className="rh-th">
                <span>
                  {t(
                    {
                      id: 'repo.history.files',
                      defaultMessage: '{count, plural, one {# file} other {# files}}',
                    },
                    { count: files.length },
                  )}
                </span>
                {counts(total('additions'), total('deletions'))}
              </div>
              <ul className="rh-tl">
                {byFolder(files).map(([dir, list]) =>
                  dir === '' ? (
                    list.map(fileItem)
                  ) : (
                    <li key={`${dir}/`}>
                      <div className="rh-dir">
                        <Folder className="ic-sm" aria-hidden="true" />
                        <span className="mono rh-cut">{dir}</span>
                      </div>
                      <ul className="rh-tl">{list.map(fileItem)}</ul>
                    </li>
                  ),
                )}
              </ul>
            </>
          ) : diff.error ? (
            <Failure error={diff.error} onRetry={diff.reload} />
          ) : (
            <Skeleton />
          )}
        </aside>
        <div className="rh-main">
          {facts ? (
            <div className="panel rh-ba">
              {gate && (
                <div className="cell">
                  <span className="cap">
                    {t({ id: 'repo.commit.gateTime', defaultMessage: 'Gate time' })}
                  </span>
                  <div className="rh-kpi">
                    {facts.previous_gate_ms !== null && (
                      <span className="mu">{durationText(facts.previous_gate_ms)}</span>
                    )}
                    <span className="kpi">{durationText(gate.duration_ms)}</span>
                    {facts.previous_gate_ms !== null && (
                      <span className="rh-tx2">
                        {Math.abs(gate.duration_ms - facts.previous_gate_ms) < 100
                          ? t({ id: 'repo.commit.unchanged', defaultMessage: 'No change' })
                          : gate.duration_ms > facts.previous_gate_ms
                            ? t(
                                { id: 'repo.commit.slower', defaultMessage: '{duration} more' },
                                {
                                  duration: durationText(gate.duration_ms - facts.previous_gate_ms),
                                },
                              )
                            : t(
                                { id: 'repo.commit.faster', defaultMessage: '{duration} less' },
                                {
                                  duration: durationText(facts.previous_gate_ms - gate.duration_ms),
                                },
                              )}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <div className="cell">
                <span className="cap">
                  {t({ id: 'repo.commit.dependencies', defaultMessage: 'Dependencies' })}
                </span>
                <div className="rh-kpi">
                  <span className="kpi">{facts.dependencies}</span>
                  <span className="rh-tx2">
                    {facts.dependencies === 0
                      ? t({ id: 'repo.commit.unchanged', defaultMessage: 'No change' })
                      : t(
                          {
                            id: 'repo.commit.depsChanged',
                            defaultMessage:
                              '{count, plural, one {entry changed} other {entries changed}}',
                          },
                          { count: facts.dependencies },
                        )}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            !after.error && <Skeleton />
          )}
          {story && (flows.length > 0 || diagrams.length > 0) && (
            <section className="rh-story" aria-labelledby={`${sha}-story`}>
              <div className="rh-sth">
                <h3 id={`${sha}-story`}>
                  {t({ id: 'repo.commit.behavior', defaultMessage: 'Behavior before and after' })}
                </h3>
                {story.workbench_session_id && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => openSession(story.workbench_session_id!, 'story')}
                  >
                    {story.runtime && <RuntimeGlyph runtime={story.runtime} size={14} />}
                    {t({ id: 'repo.history.story', defaultMessage: 'Change story' })}
                  </button>
                )}
              </div>
              {flows.map((flow, i) => (
                <div key={i} className="rh-flow">
                  {flows.length > 1 && <h4>{flow.title}</h4>}
                  <div className="rh-two">
                    {steps(flow.before, `${sha}-${i}-before`, 'before')}
                    {steps(flow.after, `${sha}-${i}-after`, 'after')}
                  </div>
                </div>
              ))}
              {diagrams.map((card, i) => (
                <div key={i} className="rh-diagram">
                  <h4>{card.title}</h4>
                  <StoryDiagram diagram={card.diagram!} />
                </div>
              ))}
            </section>
          )}
          {changes && file && (
            <section
              ref={box}
              className="rh-dbox"
              aria-label={t(
                { id: 'repo.commit.fileDiff', defaultMessage: 'Changes in {path}' },
                { path: file.path },
              )}
            >
              <div className="rh-fh">
                <span className="mono rh-b rh-cut rh-grow" title={file.path}>
                  {file.path}
                </span>
                {file.additions !== null && counts(file.additions, file.deletions ?? 0)}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => openRepoView(projectId, { kind: 'file', path: file.path })}
                >
                  {t({ id: 'repo.commit.fileHistory', defaultMessage: 'File history' })}
                </button>
              </div>
              {changes.truncated ? (
                <div className="rh-note mu">
                  {t({
                    id: 'repo.commit.truncated',
                    defaultMessage: 'Too many changes to load in full',
                  })}
                </div>
              ) : hunks.length === 0 ? (
                <div className="rh-note mu">
                  {t({ id: 'repo.commit.noText', defaultMessage: 'No text changes' })}
                </div>
              ) : (
                <div className="ss-dl mono">
                  <div className="rh-sides">
                    <span>
                      <span className="rh-grow">
                        {t({ id: 'repo.history.before', defaultMessage: 'Before' })}
                      </span>
                      <span className="mono">{shortSha(changes.from_sha)}</span>
                    </span>
                    <span>
                      <span className="rh-grow">
                        {t({ id: 'repo.history.after', defaultMessage: 'After' })}
                      </span>
                      <span className="mono">{shortSha(changes.to_sha)}</span>
                    </span>
                  </div>
                  {hunks.map((h, i) => {
                    const lines = numbered(h);
                    const half = (j: number | null, side: 'old' | 'new') => {
                      if (j === null)
                        return <div key={side} className="ss-ln df-half" data-empty />;
                      const l = lines[j]!;
                      return (
                        <div key={side} className={`ss-ln df-half ${l.kind}`}>
                          <span className="ss-nums">
                            <span>{l[side]}</span>
                          </span>
                          <span className="ss-sg" aria-hidden="true">
                            {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                          </span>
                          <span className="ss-code">{l.text}</span>
                        </div>
                      );
                    };
                    return (
                      <Fragment key={i}>
                        <div className="ss-ln hh">{h.header}</div>
                        {sideBySide(lines).map((row) => (
                          <div key={row.old ?? row.new} className="df-sr">
                            {half(row.old, 'old')}
                            {half(row.new, 'new')}
                          </div>
                        ))}
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </section>
          )}
          <section className="rh-after" aria-labelledby={`${sha}-after`}>
            <h3 id={`${sha}-after`}>
              {t({ id: 'repo.commit.after', defaultMessage: 'After this commit' })}
            </h3>
            {facts ? (
              <ul className="rh-arows">
                {gate && (
                  <li className="rh-ar">
                    {gate.failed > 0 ? (
                      <X className="ic-sm rh-gl" data-tone="bad" aria-hidden="true" />
                    ) : gate.passed > 0 ? (
                      <Check className="ic-sm rh-gl" data-tone="ok" aria-hidden="true" />
                    ) : (
                      <Minus className="ic-sm rh-gl" aria-hidden="true" />
                    )}
                    <span className="rh-grow rh-line">
                      <span>
                        {t(
                          {
                            id: 'repo.commit.gatePassed',
                            defaultMessage:
                              'Pre-merge gate passed {count, plural, one {# step} other {# steps}} on {sha}',
                          },
                          { count: gate.passed, sha: shortSha(gate.sha) },
                        )}
                      </span>
                      {gate.failed > 0 && (
                        <span>
                          {t(
                            {
                              id: 'repo.commit.gateFailed',
                              defaultMessage:
                                '{count, plural, one {# step failed} other {# steps failed}}',
                            },
                            { count: gate.failed },
                          )}
                        </span>
                      )}
                      {gate.skipped > 0 && (
                        <span>
                          {t(
                            {
                              id: 'repo.commit.gateSkipped',
                              defaultMessage:
                                '{count, plural, one {# step skipped} other {# steps skipped}}',
                            },
                            { count: gate.skipped },
                          )}
                        </span>
                      )}
                    </span>
                    {commit?.session_id && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => openSession(commit.session_id!, 'checks')}
                      >
                        {t({ id: 'repo.commit.gateDetails', defaultMessage: 'Gate details' })}
                      </button>
                    )}
                  </li>
                )}
                {facts.later.length === 0 ? (
                  <li className="rh-ar">
                    <Check className="ic-sm rh-gl" data-tone="ok" aria-hidden="true" />
                    <span className="rh-grow">
                      {t({
                        id: 'repo.commit.noLater',
                        defaultMessage: 'No later commit changes these lines',
                      })}
                    </span>
                    {!pushable && revertButton}
                  </li>
                ) : (
                  <li className="rh-ar">
                    <span className="rh-dot" aria-hidden="true" />
                    <div className="rh-grow">
                      <span>
                        {t(
                          {
                            id: 'repo.commit.laterCount',
                            defaultMessage:
                              '{count, plural, one {# later commit changes these lines} other {# later commits change these lines}}',
                          },
                          { count: facts.later.length },
                        )}
                      </span>
                      <ul className="rh-tl">
                        {facts.later.map((c) => (
                          <li key={c.sha}>
                            <button type="button" className="rh-link" onClick={() => open(c.sha)}>
                              <span className="mono">{shortSha(c.sha)}</span>
                              <span className="rh-cut">{c.subject}</span>
                              <time className="mu" dateTime={new Date(c.at).toISOString()}>
                                {ageText(c.at, now)}
                              </time>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {!pushable && revertButton}
                  </li>
                )}
                {pushable && (
                  <li className="rh-ar">
                    <span className="rh-dot" aria-hidden="true" />
                    <span className="rh-grow">
                      {t(
                        {
                          id: 'repo.commit.ahead',
                          defaultMessage:
                            '{branch} is {count, plural, one {# commit} other {# commits}} ahead of {upstream}',
                        },
                        {
                          branch: onBranch,
                          upstream: facts.upstream!.name,
                          count: facts.upstream!.ahead,
                        },
                      )}
                    </span>
                    <button type="button" className="btn ghost sm" onClick={() => ask('push')}>
                      {t(
                        { id: 'repo.commit.push', defaultMessage: 'Push {branch}…' },
                        { branch: onBranch },
                      )}
                    </button>
                    {revertButton}
                  </li>
                )}
              </ul>
            ) : after.error ? (
              <Failure error={after.error} onRetry={after.reload} />
            ) : (
              <Skeleton />
            )}
          </section>
        </div>
      </div>
      <AlertDialog.Root
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next && !running) setAsking(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="pj-scrim" />
          <AlertDialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <AlertDialog.Title className="pj-dt">
                {asking === 'push'
                  ? t(
                      {
                        id: 'repo.commit.pushTitle',
                        defaultMessage:
                          'Push {count, plural, one {# commit} other {# commits}} on {branch} to {upstream}?',
                      },
                      {
                        count: facts?.upstream?.ahead ?? 0,
                        branch: onBranch,
                        upstream: facts?.upstream?.name ?? '',
                      },
                    )
                  : t(
                      { id: 'repo.commit.revertTitle', defaultMessage: 'Revert {sha}?' },
                      { sha: shortSha(sha) },
                    )}
              </AlertDialog.Title>
            </div>
            <AlertDialog.Description className="pj-rm-body">
              {asking === 'push'
                ? t({
                    id: 'repo.commit.pushBody',
                    defaultMessage: 'Others who pull the branch get these commits.',
                  })
                : merged
                  ? t(
                      {
                        id: 'repo.commit.revertMerge',
                        defaultMessage:
                          'Creates a new commit on {branch} that reverts the whole session merge, {count, plural, one {# commit} other {# commits}}.',
                      },
                      { branch: onBranch, count: merged.commits },
                    )
                  : t(
                      {
                        id: 'repo.commit.revertOne',
                        defaultMessage:
                          'Creates a new commit on {branch} that reverts this commit.',
                      },
                      { branch: onBranch },
                    )}
            </AlertDialog.Description>
            {actionError && (
              <pre className="rh-err" role="alert">
                {actionError}
              </pre>
            )}
            <div className="pj-df">
              <span style={{ flex: 1 }} />
              <AlertDialog.Close className="btn" disabled={running}>
                {t({ id: 'repo.commit.cancel', defaultMessage: 'Cancel' })}
              </AlertDialog.Close>
              <button
                type="button"
                className={running ? 'btn pri btn-busy' : 'btn pri'}
                disabled={running}
                aria-busy={running || undefined}
                onClick={() => void (asking === 'push' ? confirmPush() : confirmRevert())}
              >
                {asking === 'push'
                  ? t({ id: 'repo.commit.pushConfirm', defaultMessage: 'Push' })
                  : t({ id: 'repo.commit.revertConfirm', defaultMessage: 'Revert' })}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
  );
}
