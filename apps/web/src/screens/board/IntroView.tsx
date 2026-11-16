import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Copy, RefreshCw, X, Zap } from 'lucide-react';
import type { BaselineFolder } from '@pantheon/domain';
import type { FileRef } from '@pantheon/protocol';
import { Markdown, openFailureText } from '../../components/Markdown';
import { StateGlyph } from '../../components/SessionStateIcon';
import { Tip } from '../../components/Tip';
import { useBaselineRead } from '../../data/baseline-read';
import { useBoard } from '../../data/board';
import { startIntro, useIntroRead, type ProjectIntro } from '../../data/intro-read';
import { useNow } from '../../data/needs-you';
import { elapsedText } from '../../data/transcript';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import type { BaselineChoice } from '../projects/baseline';
import { BaselinePopover } from '../projects/BaselineBlocks';
import { useSize } from './Charts';
import {
  ARCH_NODE,
  DARK_SHADE,
  SHADES,
  archLayout,
  cellLabel,
  commitShade,
  mermaidBlocks,
  shellLine,
  sourceText,
  squarify,
  stepRange,
} from './intro-model';
import './intro.css';

/** Treemap height in px, and the width it is laid out in before its box is measured. */
const TREEMAP_HEIGHT = 192;
const TREEMAP_WIDTH = 480;
/** A treemap cell lower than this shows no text. */
const LABEL_MIN = 40;

type CommandKey = keyof NonNullable<BaselineFolder['commands']>;
const COMMAND_KEYS: readonly CommandKey[] = ['setup', 'build', 'test', 'lint', 'dev'];

function commandLabel(key: CommandKey): string {
  switch (key) {
    case 'setup':
      return t({ id: 'board.intro.command.setup', defaultMessage: 'Install' });
    case 'build':
      return t({ id: 'board.intro.command.build', defaultMessage: 'Build' });
    case 'test':
      return t({ id: 'board.intro.command.test', defaultMessage: 'Test' });
    case 'lint':
      return t({ id: 'board.intro.command.lint', defaultMessage: 'Lint' });
    case 'dev':
      return t({ id: 'board.intro.command.dev', defaultMessage: 'Run' });
  }
}

const count = (n: number) => new Intl.NumberFormat(currentLocale()).format(n);
const linesText = (n: number) =>
  t(
    { id: 'board.intro.lines', defaultMessage: '{count, plural, one {# line} other {# lines}}' },
    {
      count: n,
    },
  );
const total = (rows: readonly { lines: number }[]) => rows.reduce((all, row) => all + row.lines, 0);

/** The clock time, with the day unless it is today. */
function writtenText(at: number, now: number): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  const time = new Intl.DateTimeFormat(currentLocale(), {
    ...(today ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  return today ? t({ id: 'memory.intro.today', defaultMessage: 'Today {time}' }, { time }) : time;
}

/** The file a `file:<path>` or `file:<path>:<line>` source names; null for a commit. */
function sourceFile(source: string): FileRef | null {
  if (!source.startsWith('file:')) return null;
  const path = source.slice('file:'.length);
  const at = /^(.+):(\d+)$/.exec(path);
  return at ? { path: at[1]!, line: Number(at[2]) } : { path };
}

/** A source chip; a file opens in the editor at its line, relative to the project folder `base`. */
export function SourceRef({
  source,
  base,
  className,
}: {
  source: string;
  base?: string;
  className: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const file = sourceFile(source);
  if (!file)
    return (
      <span className={`chip mono ${className}`} title={source}>
        {sourceText(source)}
      </span>
    );
  const open = () => {
    setError(null);
    void window.pantheon?.openFile({ ...file, base }).then((r) => {
      if (!r.ok) setError(openFailureText(r.error));
    });
  };
  return (
    <span className="in-src">
      <button type="button" className={`chip mono ${className}`} title={source} onClick={open}>
        <span className="in-cut">{sourceText(source)}</span>
      </button>
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** The writing state, and how long the writing session has run when its start is known. */
export function WritingMark({ since }: { since: number | null }) {
  const now = useNow();
  const label = t({ id: 'board.intro.writing', defaultMessage: 'Writing' });
  return (
    <span className="in-run">
      <StateGlyph name="running" />
      <span className="tr-status">
        {label}
        <span className="tr-shine" aria-hidden="true">
          {label}
        </span>
      </span>
      {since !== null && <span className="mono mu in-num">{elapsedText(now - since)}</span>}
    </span>
  );
}

export function CommandRow({
  label,
  command,
  source,
}: {
  label: string;
  command: string;
  source?: string;
}) {
  const copyLabel = t(
    { id: 'board.intro.command.copy', defaultMessage: 'Copy {command}' },
    { command },
  );
  return (
    <li className="in-cmd">
      <span className="cap">{label}</span>
      <code className="mono in-cut">{command}</code>
      <span className="mono mu in-cut">{source}</span>
      <Tip content={copyLabel}>
        <button
          type="button"
          className="ib"
          aria-label={copyLabel}
          onClick={() => void navigator.clipboard.writeText(command)}
        >
          <Copy className="ic-sm" aria-hidden="true" />
        </button>
      </Tip>
    </li>
  );
}

/** Nodes in columns along the edges; an edge with the graph's edge back has a head at each end. */
export function ArchDiagram({ spec }: { spec: NonNullable<ProjectIntro['architecture']> }) {
  const marker = `in-ah-${useId().replace(/[^\w-]/g, '')}`;
  const laid = useMemo(() => archLayout(spec), [spec]);
  const names = new Map(spec.nodes.map((node) => [node.id, node.label]));
  const edgeText = (edge: (typeof laid.edges)[number]) => {
    const values = { from: names.get(edge.from), to: names.get(edge.to) };
    return edge.both
      ? t(
          { id: 'memory.intro.architecture.both', defaultMessage: '{from} and {to}, both ways' },
          values,
        )
      : t({ id: 'memory.intro.architecture.edge', defaultMessage: '{from} to {to}' }, values);
  };
  return (
    <div
      className="in-arch"
      role="group"
      aria-label={t({
        id: 'memory.intro.architecture.group',
        defaultMessage: 'Architecture nodes',
      })}
      style={{ width: laid.width, height: laid.height }}
    >
      <svg
        width={laid.width}
        height={laid.height}
        viewBox={`0 0 ${laid.width} ${laid.height}`}
        role="img"
        aria-label={t(
          {
            id: 'memory.intro.architecture.label',
            defaultMessage:
              'Architecture diagram, {count, plural, one {# node} other {# nodes}}: {list}',
          },
          { count: spec.nodes.length, list: listText(...laid.edges.map(edgeText)) },
        )}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0L8 4L0 8z" />
          </marker>
        </defs>
        {laid.edges.map((edge) => (
          <path
            key={`${edge.from}:${edge.to}`}
            className="in-eg"
            d={edge.d}
            markerEnd={`url(#${marker})`}
            markerStart={edge.both ? `url(#${marker})` : undefined}
          />
        ))}
      </svg>
      {laid.nodes.map((node) => (
        <div
          key={node.id}
          className="in-nd"
          style={{ left: node.x, top: node.y, width: ARCH_NODE.w, height: ARCH_NODE.h }}
        >
          <span className="in-b in-cut">{node.label}</span>
          {node.group && <span className="mu in-t1 in-cut">{node.group}</span>}
        </div>
      ))}
    </div>
  );
}

const percent = (part: number, whole: number) => `${(part / whole) * 100}%`;

/** Module area by lines, grey by commits in the last 30 days; a cell picks its module. */
export function Treemap({
  modules,
  onPick,
}: {
  modules: ProjectIntro['modules'];
  onPick: (path: string) => void;
}) {
  const [measure, size] = useSize();
  const width = size.w || TREEMAP_WIDTH;
  const cells = squarify(
    modules.map((m) => m.lines),
    width,
    TREEMAP_HEIGHT,
  );
  return (
    <div
      ref={measure}
      className="in-tm"
      role="group"
      aria-label={t(
        {
          id: 'board.intro.modules.label',
          defaultMessage: '{count, plural, one {# module} other {# modules}}, {lines}',
        },
        { count: modules.length, lines: linesText(total(modules)) },
      )}
    >
      {cells.map((cell) => {
        const m = modules[cell.index]!;
        const shade = commitShade(m.commits_30d);
        const label = cell.h >= LABEL_MIN ? cellLabel(m.path, cell.w) : null;
        return (
          <button
            key={m.path}
            type="button"
            className="in-tc"
            data-dark={shade >= DARK_SHADE || undefined}
            aria-pressed={false}
            aria-label={t(
              {
                id: 'board.intro.modules.cell',
                defaultMessage:
                  '{path}: {lines}, {commits, plural, one {# commit} other {# commits}} in 30 days',
              },
              { path: m.path, lines: linesText(m.lines), commits: m.commits_30d },
            )}
            style={
              {
                left: percent(cell.x, width),
                top: percent(cell.y, TREEMAP_HEIGHT),
                width: percent(cell.w, width),
                height: percent(cell.h, TREEMAP_HEIGHT),
                '--v': shade,
              } as CSSProperties
            }
            onClick={() => onPick(m.path)}
          >
            {label && (
              <span className="mono in-t1">
                <span className="in-cut">{label}</span>
                <span className="in-n">{count(m.lines)}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The project introduction: what the project does and aims at, how to run it and how it is built. */
export function IntroView({
  projectId,
  baseline,
}: {
  projectId: string;
  /** The board's baseline start, offered while the project has never been assessed. */
  baseline?: { busy: boolean; onStart: (choice?: BaselineChoice) => void };
}) {
  const { read, error } = useIntroRead(projectId);
  const baselineRead = useBaselineRead(projectId);
  const brief = useBoard((s) => s.board?.project_briefs?.find((b) => b.project_id === projectId));
  const root = useBoard((s) => s.board?.projects.find((p) => p.id === projectId)?.roots[0]);
  const writingId = read?.writing_session_id ?? null;
  const since = useBoard(
    (s) =>
      s.events.find((e) => e.kind === 'session.opened' && e.aggregate_id === writingId)
        ?.created_at ?? null,
  );
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (picked === null) return;
    const onKey = (e: KeyboardEvent) => {
      // A dialog over the page closes on this Esc; the next one drops the module.
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        (e.target as Element | null)?.closest?.('[role=dialog]')
      )
        return;
      setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);

  if (!read)
    return (
      error && (
        <p className="in-err" role="alert">
          {error}
        </p>
      )
    );
  const intro = read.intro;
  const writing = starting || writingId !== null;
  const start = async () => {
    setStarting(true);
    setStartError(null);
    const result = await startIntro(projectId);
    setStarting(false);
    if (!result.ok) setStartError(result.error);
  };
  const assessed =
    baselineRead.read?.state === 'confirmed' ? (baselineRead.read.result ?? null) : null;
  const action =
    intro || assessed ? (
      <button type="button" className="btn sm" disabled={writing} onClick={() => void start()}>
        <RefreshCw className="ic-sm" aria-hidden="true" />
        {intro
          ? t({ id: 'board.intro.regenerate', defaultMessage: 'Regenerate' })
          : t({ id: 'board.intro.generate', defaultMessage: 'Generate introduction' })}
      </button>
    ) : (
      baseline && (
        <>
          <button
            ref={startButton}
            type="button"
            className="btn sm"
            disabled={writing || baseline.busy}
            onClick={() => setChoosing(true)}
          >
            {t({ id: 'board.intro.startBaseline', defaultMessage: 'Run baseline' })}
          </button>
          {choosing && (
            <BaselinePopover
              project_id={projectId}
              anchor={startButton}
              label={t({ id: 'board.intro.startBaseline', defaultMessage: 'Run baseline' })}
              busy={baseline.busy}
              onClose={() => setChoosing(false)}
              onStart={baseline.onStart}
            />
          )}
        </>
      )
    );
  const head = (
    <div className="in-hd">
      <h2 className="in-h2">
        {t({ id: 'memory.intro.title', defaultMessage: 'Project introduction' })}
      </h2>
      {intro && !writing && (
        <>
          <span className="in-pair">
            <span className="mu">
              {t({ id: 'memory.intro.written', defaultMessage: 'Generated' })}
            </span>
            <span className="in-num">{writtenText(intro.written_at, Date.now())}</span>
          </span>
          {intro.heads.length > 0 && (
            <span className="in-pair">
              <span className="mu">
                {t({ id: 'board.intro.heads', defaultMessage: 'Based on' })}
              </span>
              <span className="mono">{listText(...intro.heads.map((h) => h.sha.slice(0, 7)))}</span>
            </span>
          )}
          {read.behind !== null && (
            <span className="mu in-num">
              {t(
                {
                  id: 'board.intro.behind',
                  defaultMessage: 'Behind by {count, plural, one {# commit} other {# commits}}',
                },
                { count: read.behind },
              )}
            </span>
          )}
        </>
      )}
      {writing && <WritingMark since={since} />}
      <span className="in-acts">
        {startError && (
          <span className="in-err" role="alert">
            {startError}
          </span>
        )}
        {action}
      </span>
    </div>
  );
  if (!intro)
    return (
      <section
        className="in-pg"
        aria-busy={writing || undefined}
        aria-label={t({ id: 'memory.intro.title', defaultMessage: 'Project introduction' })}
      >
        {head}
      </section>
    );

  const commands = (assessed?.folders ?? []).flatMap((folder) =>
    COMMAND_KEYS.flatMap((key) => {
      const entry = folder.commands?.[key];
      return entry
        ? [
            {
              key,
              root: folder.root,
              command: shellLine(entry.argv),
              source: entry.sources[0] && sourceText(entry.sources[0]),
            },
          ]
        : [];
    }),
  );
  const goals = brief?.goals ?? [];
  const nonGoals = brief?.non_goals ?? [];
  const modules = [...intro.modules].sort((a, b) => b.lines - a.lines);
  const chosen = modules.find((m) => m.path === picked) ?? null;
  const architecture = intro.architecture;
  const flows = mermaidBlocks(intro.body ?? '');
  const span = (other: boolean, own: number) => (other ? `in-s${own}` : 'in-s12');
  const list = (items: readonly string[]) => (
    <ul className="in-gls">
      {items.map((item) => (
        <li key={item} className="in-gl">
          {item}
        </li>
      ))}
    </ul>
  );

  return (
    <section
      className="in-pg"
      aria-busy={writing || undefined}
      aria-label={t({ id: 'memory.intro.title', defaultMessage: 'Project introduction' })}
    >
      {head}
      <div className="panel in-grid">
        {(intro.features.length > 0 || goals.length > 0 || nonGoals.length > 0) && (
          <section
            className="cell in-s12"
            aria-label={t({
              id: 'memory.intro.featuresAndGoals',
              defaultMessage: 'Features and goals',
            })}
          >
            <div className="in-fg">
              {intro.features.length > 0 && (
                <div className="in-col">
                  <div className="in-ch">
                    <h3>{t({ id: 'board.intro.features', defaultMessage: 'Features' })}</h3>
                    <span className="in-n">{count(intro.features.length)}</span>
                  </div>
                  <ul className="in-gls">
                    {intro.features.map((feature) => (
                      <li key={feature.title} className="in-ft">
                        <Zap className="ic-sm mu" aria-hidden="true" />
                        <span className="in-cut" title={feature.title}>
                          {feature.title}
                        </span>
                        <span className="in-cut mu" title={feature.text}>
                          {feature.text}
                        </span>
                        {feature.sources[0] && (
                          <SourceRef source={feature.sources[0]} base={root} className="in-ref" />
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {goals.length > 0 && (
                <div className="in-col">
                  <div className="in-ch">
                    <h3>{t({ id: 'memory.intro.goals', defaultMessage: 'Goals' })}</h3>
                  </div>
                  {list(goals)}
                </div>
              )}
              {nonGoals.length > 0 && (
                <div className="in-col">
                  <div className="in-ch">
                    <h3>{t({ id: 'memory.intro.nonGoals', defaultMessage: 'Non-goals' })}</h3>
                  </div>
                  {list(nonGoals)}
                </div>
              )}
            </div>
          </section>
        )}

        {commands.length > 0 && (
          <section className="cell in-s12">
            <div className="in-ch">
              <h3>{t({ id: 'board.intro.commands', defaultMessage: 'Commands' })}</h3>
            </div>
            <ul className="in-cmds">
              {commands.map((c) => (
                <CommandRow
                  key={`${c.root}:${c.key}`}
                  label={commandLabel(c.key)}
                  command={c.command}
                  source={c.source}
                />
              ))}
            </ul>
          </section>
        )}

        {architecture && (
          <section className={`cell ${span(modules.length > 0, 7)}`}>
            <div className="in-ch">
              <h3>{t({ id: 'board.intro.architecture', defaultMessage: 'Architecture' })}</h3>
              <span className="in-n">
                {t(
                  {
                    id: 'memory.intro.architecture.nodes',
                    defaultMessage: '{count, plural, one {# node} other {# nodes}}',
                  },
                  { count: architecture.nodes.length },
                )}
              </span>
            </div>
            <div className="in-scroll">
              <ArchDiagram spec={architecture} />
            </div>
          </section>
        )}

        {modules.length > 0 && (
          <section className={`cell ${span(!!architecture, 5)}`}>
            <div className="in-ch">
              <h3>{t({ id: 'board.intro.modules', defaultMessage: 'Modules' })}</h3>
              <span className="mono in-n in-end">{linesText(total(modules))}</span>
            </div>
            {chosen ? (
              <div className="in-mod" key={chosen.path}>
                <div className="in-mh">
                  <span className="mono in-b in-cut">{chosen.path}</span>
                  <button
                    type="button"
                    className="ib"
                    aria-label={t({ id: 'memory.intro.module.unpick', defaultMessage: 'Deselect' })}
                    // The picked cell is gone; its replacement takes the focus.
                    autoFocus
                    onClick={() => setPicked(null)}
                  >
                    <X className="ic-sm" aria-hidden="true" />
                  </button>
                </div>
                <dl className="in-kv">
                  <dt className="cap">
                    {t({ id: 'memory.intro.module.role', defaultMessage: 'Role' })}
                  </dt>
                  <dd>{chosen.role}</dd>
                  {chosen.entry && (
                    <>
                      <dt className="cap">
                        {t({ id: 'board.intro.module.entry', defaultMessage: 'Entry' })}
                      </dt>
                      <dd>
                        <SourceRef source={`file:${chosen.entry}`} base={root} className="in-ref" />
                      </dd>
                    </>
                  )}
                  <dt className="cap">
                    {t({ id: 'memory.intro.module.code', defaultMessage: 'Code' })}
                  </dt>
                  <dd className="in-num">{linesText(chosen.lines)}</dd>
                  <dt className="cap">
                    {t({ id: 'memory.intro.module.commits', defaultMessage: 'Commits' })}
                  </dt>
                  <dd className="in-num">
                    {t(
                      {
                        id: 'memory.intro.module.commitsValue',
                        defaultMessage:
                          '{count, plural, one {# in the last 30 days} other {# in the last 30 days}}',
                      },
                      { count: chosen.commits_30d },
                    )}
                  </dd>
                </dl>
              </div>
            ) : (
              <>
                <Treemap modules={modules} onPick={setPicked} />
                <div className="legend" aria-hidden="true">
                  <span>
                    {t({ id: 'board.intro.module.commits', defaultMessage: 'Commits in 30 days' })}
                  </span>
                  {SHADES.map((shade, step) => (
                    <span key={shade}>
                      <i className="in-sw" style={{ '--v': shade } as CSSProperties} />
                      {stepRange(step)}
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {flows && (
          <section
            className="cell in-s12"
            aria-label={t({ id: 'board.intro.flows', defaultMessage: 'Main flows' })}
          >
            <div className="in-ch">
              <h3>{t({ id: 'board.intro.flows', defaultMessage: 'Main flows' })}</h3>
            </div>
            <div className="in-scroll">
              <Markdown text={flows} />
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
