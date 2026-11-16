import { useEffect, useId, useState } from 'react';
import type {
  ChangeStory,
  ReviewFinding,
  StoryCard,
  StoryKind,
  StoryResult,
  StorySurface,
} from '@pantheon/domain';
import type { DiffHunk, LandingDiff } from '@pantheon/protocol';
import { Check, X } from 'lucide-react';
import { IdText } from '../../../components/IdText';
import { Tip } from '../../../components/Tip';
import { revertPatch } from '../../../data/change-story';
import { cardFindings, cardLines, pointFacts, type LandedPoint } from './model';
import { CommandLine, HunkLines } from './parts';
import { StoryDiagram } from './StoryDiagram';
import { t } from '../../../i18n';
import './evidence.css';

// Labels are getters, so each is read in the language loaded by then.
export const KIND: Record<StoryKind, string> = {
  get added() {
    return t({ id: 'sessions.panel.story.kind.added', defaultMessage: 'Added' });
  },
  get behavior() {
    return t({ id: 'sessions.panel.story.kind.behavior', defaultMessage: 'Behavior' });
  },
  get fix() {
    return t({ id: 'sessions.panel.story.kind.fix', defaultMessage: 'Fix' });
  },
  get refactor() {
    return t({ id: 'sessions.panel.story.kind.refactor', defaultMessage: 'Refactor' });
  },
  get style() {
    return t({ id: 'sessions.panel.story.kind.style', defaultMessage: 'Style' });
  },
  get test() {
    return t({ id: 'sessions.panel.story.kind.test', defaultMessage: 'Test' });
  },
  get config() {
    return t({ id: 'sessions.panel.story.kind.config', defaultMessage: 'Config' });
  },
};

const SURFACE: Record<StorySurface, string> = {
  get ui() {
    return t({ id: 'sessions.panel.story.surface.ui', defaultMessage: 'UI' });
  },
  get api() {
    return t({ id: 'sessions.panel.story.surface.api', defaultMessage: 'API' });
  },
  get cli() {
    return t({ id: 'sessions.panel.story.surface.cli', defaultMessage: 'CLI' });
  },
  get data() {
    return t({ id: 'sessions.panel.story.surface.data', defaultMessage: 'Data' });
  },
  get internal() {
    return t({ id: 'sessions.panel.story.surface.internal', defaultMessage: 'Internal' });
  },
};

const findingsTitle = () =>
  t({ id: 'sessions.panel.story.findings', defaultMessage: 'Review findings' });
export const outOfScopeText = () =>
  t({ id: 'sessions.panel.story.outOfScope', defaultMessage: 'Out of scope' });
const expandText = (id: string) =>
  t({ id: 'sessions.panel.story.expand', defaultMessage: 'Expand {id}' }, { id });

const SEGMENT_TONES = 4;
const CARDS_MARK = '\u0000';

function No({ n, out }: { n: number; out?: boolean }) {
  return <span className={out ? 'gs-no out' : 'gs-no'}>{n}</span>;
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * The ready interpretation of one landed point: header, before and after, acceptance, reach and cards;
 * with `selected`, only that card, open.
 */
export function StoryView({
  point,
  story,
  result,
  diff,
  findings,
  selected,
  onSelect,
}: {
  point: LandedPoint;
  story: ChangeStory;
  result: StoryResult;
  diff: LandingDiff | null;
  findings: readonly ReviewFinding[];
  /** The index of the one card to show. */
  selected?: number;
  /** Picks another card the shown card refers to. */
  onSelect?: (index: number) => void;
}) {
  const prefix = useId();
  const cardId = (i: number) => `${prefix}-card-${i}`;
  const acceptance = story.context?.acceptance ?? [];
  const facts = pointFacts(story, acceptance).story!;
  const blocking = findings.filter((f) => f.status === 'open' && f.blocking);
  // Without the diff no card can claim a finding, so the rest stay listed here.
  const unplaced = diff ? [] : findings.filter((f) => f.status === 'open' && !f.blocking);
  const hunks = new Map((diff?.hunks ?? []).map((h) => [h.id, h]));
  const lines = diff
    ? result.cards.map((card) => {
        const n = cardLines(card, diff);
        return n.additions + n.deletions;
      })
    : [];
  const reach = lines.reduce((a, b) => a + b, 0);
  const rows = Math.max(result.overall.before.length, result.overall.after.length);

  if (selected !== undefined) {
    const card = result.cards[selected];
    return card ? (
      <div className="gs-story">
        <Card
          key={`${story.id}:${selected}`}
          id={cardId(selected)}
          index={selected}
          card={card}
          story_id={story.id}
          hunks={hunks}
          findings={diff ? cardFindings(card, diff, findings) : []}
          acceptance={card.acceptance.map((i) => ({ n: i + 1, text: acceptance[i] ?? '' }))}
          onSelect={onSelect}
        />
      </div>
    ) : null;
  }

  return (
    <div className="gs-story">
      <div className="gs-head">
        <div className="gs-title">{point.task_goal}</div>
        <div className="gs-meta mono">
          <span className="gs-range">
            <IdText id={point.from_sha} />
            <span className="mu" aria-hidden="true">
              →
            </span>
            <IdText id={point.to_sha} />
          </span>
          {facts.total > 0 && (
            <span className="nch">
              {t(
                {
                  id: 'sessions.panel.story.acceptanceCited',
                  defaultMessage: 'Acceptance criteria matched {cited}/{total}',
                },
                { cited: facts.cited, total: facts.total },
              )}
            </span>
          )}
          <span className={facts.out_of_scope ? 'nch wait' : 'nch'}>
            {t(
              {
                id: 'sessions.panel.story.outOfScopeCount',
                defaultMessage: 'Out of scope {count}',
              },
              { count: facts.out_of_scope },
            )}
          </span>
          <span className="nch run">
            {t(
              {
                id: 'sessions.panel.story.covered',
                defaultMessage: 'Change story covers {covered}/{total} hunks',
              },
              { covered: facts.covered, total: facts.hunk_total },
            )}
          </span>
        </div>
      </div>

      {story.outdated && (
        <div className="gs-none" role="status">
          {t({
            id: 'sessions.panel.story.outdated',
            defaultMessage: 'The commits, task contract or check evidence have changed',
          })}
        </div>
      )}
      {story.context?.contract_available === false && (
        <div className="gs-none" role="status">
          {t({
            id: 'sessions.panel.story.noContract',
            defaultMessage: 'The task contract of this version was not recorded',
          })}
        </div>
      )}

      {blocking.length > 0 && (
        <ul className="gs-block">
          {blocking.map((f) => (
            <li key={f.id}>
              <Finding finding={f} />
            </li>
          ))}
        </ul>
      )}

      {unplaced.length > 0 && (
        <section className="gs-sec">
          <h3>{findingsTitle()}</h3>
          <ul className="gs-findings">
            {unplaced.map((f) => (
              <li key={f.id}>
                <Finding finding={f} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows > 0 && (
        <table className="gs-tbl gs-ba">
          <thead>
            <tr>
              <th scope="col">
                {t({ id: 'sessions.panel.story.before', defaultMessage: 'Before' })}
              </th>
              <th scope="col">
                {t({ id: 'sessions.panel.story.after', defaultMessage: 'After' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => (
              <tr key={i}>
                <td>{result.overall.before[i]}</td>
                <td>{result.overall.after[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {story.context && (
        <section className="gs-sec">
          <h3>
            {t({
              id: 'sessions.panel.story.commitEvidence',
              defaultMessage: 'Command evidence of this commit',
            })}
          </h3>
          <div className="gs-none">
            {story.context.checks.state === 'none'
              ? t({ id: 'sessions.panel.story.checksNone', defaultMessage: 'No checks run' })
              : story.context.checks.state === 'stale'
                ? t({
                    id: 'sessions.panel.story.checksStale',
                    defaultMessage: 'The check results are out of date',
                  })
                : t({
                    id: 'sessions.panel.story.checksRecorded',
                    defaultMessage: 'Checks recorded',
                  })}
          </div>
          {story.context.checks.commit && (
            <div className="gs-meta mono">
              <IdText id={story.context.checks.commit} />
            </div>
          )}
          <ul className="gs-ev gs-checks">
            {story.context.checks.commands.map((command, index) => {
              const result =
                story.context!.checks.state === 'recorded'
                  ? story.context!.checks.results[index]
                  : undefined;
              const matches =
                result && JSON.stringify(result.argv) === JSON.stringify(command.argv);
              return (
                <li key={index}>
                  <div className="gs-check-row">
                    <code className="mono">{command.argv.join(' ')}</code>
                    <span>
                      {!matches
                        ? t({
                            id: 'sessions.panel.story.unverified',
                            defaultMessage: 'Not verified',
                          })
                        : result.exit_code === 0 && !result.timed_out
                          ? t({
                              id: 'sessions.panel.story.commandPassed',
                              defaultMessage: 'Command passed',
                            })
                          : t({
                              id: 'sessions.panel.story.commandFailed',
                              defaultMessage: 'Command failed',
                            })}
                    </span>
                  </div>
                  {matches && (
                    <details>
                      <summary>
                        {t({ id: 'sessions.panel.story.output', defaultMessage: 'Output' })}
                      </summary>
                      <pre>{result.output}</pre>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {acceptance.length > 0 && (
        <section className="gs-sec">
          <h3>{t({ id: 'sessions.panel.story.acceptance', defaultMessage: 'Acceptance' })}</h3>
          <table className="gs-tbl gs-acc">
            <tbody>
              {acceptance.map((text, i) => {
                const cited = result.cards.flatMap((c, j) => (c.acceptance.includes(i) ? [j] : []));
                return (
                  <tr key={i}>
                    <td className="mono mu">{i + 1}</td>
                    <td>{text}</td>
                    <td className="gs-cites">
                      {cited.length === 0 ? (
                        <span className="gs-none">
                          {t({
                            id: 'sessions.panel.story.noMatch',
                            defaultMessage: 'No matching change',
                          })}
                        </span>
                      ) : (
                        cited.map((j) => (
                          <button
                            key={j}
                            type="button"
                            className="gs-ref"
                            aria-label={t(
                              {
                                id: 'sessions.panel.story.scrollToCard',
                                defaultMessage: 'Scroll to card {n}',
                              },
                              { n: j + 1 },
                            )}
                            onClick={() => scrollTo(cardId(j))}
                          >
                            <No n={j + 1} />
                          </button>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {reach > 0 && (
        <section className="gs-sec">
          <h3>{t({ id: 'sessions.panel.story.reach', defaultMessage: 'Reach' })}</h3>
          <div className="gs-bar">
            {result.cards.map((card, i) =>
              lines[i] ? (
                <Tip key={i} content={`${i + 1} ${card.title}`}>
                  <span
                    className={`gs-seg ${card.out_of_scope ? 'out' : `c${i % SEGMENT_TONES}`}`}
                    style={{ flexGrow: lines[i] }}
                    aria-label={t(
                      {
                        id: 'sessions.panel.story.cardLines',
                        defaultMessage: 'Card {n}: {lines, plural, one {# line} other {# lines}}',
                      },
                      { n: i + 1, lines: lines[i] },
                    )}
                  >
                    {i + 1}
                  </span>
                </Tip>
              ) : null,
            )}
          </div>
        </section>
      )}

      <div className="gs-cards">
        {result.cards.map((card, i) => (
          <Card
            key={`${story.id}:${i}`}
            id={cardId(i)}
            index={i}
            card={card}
            story_id={story.id}
            hunks={hunks}
            findings={diff ? cardFindings(card, diff, findings) : []}
          />
        ))}
        <HunkGroup
          label={t({ id: 'sessions.panel.story.noise', defaultMessage: 'Noise hunks' })}
          ids={result.noise}
          hunks={hunks}
        />
        <HunkGroup
          label={t({
            id: 'sessions.panel.story.uninterpreted',
            defaultMessage: 'Uninterpreted hunks',
          })}
          ids={result.uninterpreted}
          hunks={hunks}
        />
      </div>
    </div>
  );
}

function Finding({ finding }: { finding: ReviewFinding }) {
  return (
    <div className="gs-find">
      <span className="gs-fh">
        <span className="nch">{finding.runtime}</span>
        <span className="mono">{finding.location}</span>
      </span>
      <code className="mono">{finding.quote}</code>
      <span>{finding.impact}</span>
    </div>
  );
}

function HunkRow({
  id,
  hunk,
  open,
  onToggle,
  anchor,
}: {
  id: string;
  hunk: DiffHunk | undefined;
  open: boolean;
  onToggle: () => void;
  anchor?: string;
}) {
  return (
    <li id={anchor}>
      <button
        type="button"
        className="df-row"
        aria-expanded={hunk ? open : undefined}
        aria-disabled={hunk ? undefined : true}
        aria-label={
          open
            ? t({ id: 'sessions.panel.story.collapse', defaultMessage: 'Collapse {id}' }, { id })
            : expandText(id)
        }
        onClick={hunk ? onToggle : undefined}
      >
        <span className="df-path mono">
          {id} {hunk?.file}
        </span>
      </button>
      {open && hunk && <HunkLines hunk={hunk} />}
    </li>
  );
}

function HunkGroup({
  label,
  ids,
  hunks,
}: {
  label: string;
  ids: readonly string[];
  hunks: ReadonlyMap<string, DiffHunk>;
}) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (ids.length === 0) return null;
  return (
    <div className="gs-group">
      <button
        type="button"
        className="gs-gh"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <span>{label}</span>
        <span className="mono mu">{ids.length}</span>
      </button>
      {shown && (
        <ul className="df-files">
          {ids.map((id) => (
            <HunkRow
              key={id}
              id={id}
              hunk={hunks.get(id)}
              open={open.has(id)}
              onToggle={() => setOpen(toggled(open, id))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

type Revert =
  | { state: 'idle' | 'busy' }
  | { state: 'done'; commands: string[] }
  | { state: 'failed'; error: string };

function Card({
  id,
  index,
  card,
  story_id,
  hunks,
  findings,
  acceptance,
  onSelect,
}: {
  id: string;
  index: number;
  card: StoryCard;
  story_id: string;
  hunks: ReadonlyMap<string, DiffHunk>;
  findings: readonly ReviewFinding[];
  /** The task's acceptance items the card cites; given, the card is shown alone and open. */
  acceptance?: readonly { n: number; text: string }[];
  onSelect?: (index: number) => void;
}) {
  const alone = acceptance !== undefined;
  const [open, setOpen] = useState(alone);
  const [rawShown, setRawShown] = useState(alone);
  const [openHunks, setOpenHunks] = useState<ReadonlySet<string>>(
    () => new Set(alone ? card.hunks : []),
  );
  const [focus, setFocus] = useState<{ hunk: string; n: number } | null>(null);
  const [revert, setRevert] = useState<Revert>({ state: 'idle' });
  const hunkAnchor = (hunk: string) => `${id}-${hunk}`;

  useEffect(() => {
    if (focus) scrollTo(`${id}-${focus.hunk}`);
  }, [focus, id]);

  const reveal = (hunk: string) => {
    setRawShown(true);
    setOpenHunks((current) => new Set(current).add(hunk));
    setFocus((f) => ({ hunk, n: (f?.n ?? 0) + 1 }));
  };

  async function generate() {
    setRevert({ state: 'busy' });
    const result = await revertPatch(story_id, index);
    setRevert(
      result.ok
        ? { state: 'done', commands: result.commands }
        : { state: 'failed', error: result.error },
    );
  }

  const out = card.out_of_scope;
  const shared = card.shared_with.length > 0;
  // The text around the card numbers, split where they go.
  const sharedText = t(
    {
      id: 'sessions.panel.story.sharedHunk',
      defaultMessage: 'This change shares a hunk with card {cards}',
    },
    { cards: CARDS_MARK },
  ).split(CARDS_MARK);
  return (
    <div id={id} className={out ? 'gs-card out' : 'gs-card'} data-open={open || undefined}>
      {alone ? (
        <div className="gs-ch">
          <span className="nch">{KIND[card.kind]}</span>
          <span className="nch">{SURFACE[card.surface]}</span>
          {out && <span className="nch wait">{outOfScopeText()}</span>}
          <h2 className="gs-ct">{card.title}</h2>
        </div>
      ) : (
        <button type="button" className="gs-ch" aria-expanded={open} onClick={() => setOpen(!open)}>
          <No n={index + 1} out={out} />
          <span className="gs-ct">{card.title}</span>
          <span className="nch">{KIND[card.kind]}</span>
          <span className="nch">{SURFACE[card.surface]}</span>
          <span className="gs-cba mu">
            {card.before} → {card.after}
          </span>
          {out && <span className="nch wait">{outOfScopeText()}</span>}
        </button>
      )}
      {open && (
        <div className="gs-cb">
          {alone && (
            <table className="gs-tbl gs-ba">
              <thead>
                <tr>
                  <th scope="col">
                    {t({ id: 'sessions.panel.story.before', defaultMessage: 'Before' })}
                  </th>
                  <th scope="col">
                    {t({ id: 'sessions.panel.story.after', defaultMessage: 'After' })}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{card.before}</td>
                  <td>{card.after}</td>
                </tr>
              </tbody>
            </table>
          )}
          {acceptance && acceptance.length > 0 && (
            <section className="gs-sec">
              <h3>{t({ id: 'sessions.panel.story.acceptance', defaultMessage: 'Acceptance' })}</h3>
              <table className="gs-tbl gs-acc">
                <tbody>
                  {acceptance.map((item) => (
                    <tr key={item.n}>
                      <td className="mono mu">{item.n}</td>
                      <td>{item.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {card.diagram ? (
            <StoryDiagram diagram={card.diagram} onHunk={reveal} />
          ) : (
            !alone && (
              <div className="gs-two">
                <div>{card.before}</div>
                <div>{card.after}</div>
              </div>
            )
          )}

          {card.how.length > 0 && (
            <section className="gs-sec">
              <h3>{t({ id: 'sessions.panel.story.how', defaultMessage: 'How it was done' })}</h3>
              <ol className="gs-how">
                {card.how.map((step, i) => (
                  <li key={i}>
                    <span>{step.text}</span>
                    <span className="gs-hrefs">
                      {step.hunks.map((h) => (
                        <button
                          key={h}
                          type="button"
                          className="gs-ref mono"
                          aria-label={expandText(h)}
                          onClick={() => reveal(h)}
                        >
                          {h}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="gs-sec">
            <h3>
              {t({ id: 'sessions.panel.story.evidence', defaultMessage: 'Command evidence' })}
            </h3>
            {card.evidence.length === 0 ? (
              <span className="gs-none">
                {t({
                  id: 'sessions.panel.story.modelOnly',
                  defaultMessage: 'Model interpretation only',
                })}
              </span>
            ) : (
              <ul className="gs-ev">
                {card.evidence.map((e) => (
                  <li key={`${e.source}:${e.id}`}>
                    <span>{e.label}</span>
                    <span
                      className={e.status === 'passed' ? 'nch ok' : 'nch bad'}
                      role="img"
                      aria-label={
                        e.status === 'passed'
                          ? t({ id: 'sessions.panel.story.passed', defaultMessage: 'Passed' })
                          : t({ id: 'sessions.panel.story.failed', defaultMessage: 'Failed' })
                      }
                    >
                      {e.status === 'passed' ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <X aria-hidden="true" />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {findings.length > 0 && (
            <section className="gs-sec">
              <h3>{findingsTitle()}</h3>
              <ul className="gs-findings">
                {findings.map((f) => (
                  <li key={f.id}>
                    <Finding finding={f} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="gs-group">
            <button
              type="button"
              className="gs-gh"
              aria-expanded={rawShown}
              onClick={() => setRawShown(!rawShown)}
            >
              <span>{t({ id: 'sessions.panel.story.rawHunks', defaultMessage: 'Raw hunks' })}</span>
              <span className="mono mu">{card.hunks.length}</span>
            </button>
            {rawShown && (
              <ul className="df-files">
                {card.hunks.map((h) => (
                  <HunkRow
                    key={h}
                    id={h}
                    anchor={hunkAnchor(h)}
                    hunk={hunks.get(h)}
                    open={openHunks.has(h)}
                    onToggle={() => setOpenHunks(toggled(openHunks, h))}
                  />
                ))}
              </ul>
            )}
          </section>

          {out && (
            <div className="gs-revert">
              <span className="gs-rv">
                <button
                  type="button"
                  className="btn"
                  aria-disabled={shared || revert.state === 'busy' || undefined}
                  onClick={shared || revert.state === 'busy' ? undefined : () => void generate()}
                >
                  {t({
                    id: 'sessions.panel.story.revert',
                    defaultMessage: 'Generate revert commands',
                  })}
                </button>
                {shared && (
                  <span className="mu">
                    {sharedText[0]}
                    {card.shared_with.map((j) =>
                      onSelect ? (
                        <button
                          key={j}
                          type="button"
                          className="gs-ref"
                          aria-label={t(
                            {
                              id: 'sessions.panel.story.showCard',
                              defaultMessage: 'Show card {n}',
                            },
                            { n: j + 1 },
                          )}
                          onClick={() => onSelect(j)}
                        >
                          <No n={j + 1} />
                        </button>
                      ) : (
                        <No key={j} n={j + 1} />
                      ),
                    )}
                    {sharedText[1]}
                  </span>
                )}
              </span>
              {revert.state === 'failed' && (
                <div className="ps-err" role="alert">
                  {revert.error}
                </div>
              )}
              {revert.state === 'done' && (
                <div className="gl-cmds">
                  {revert.commands.map((command) => (
                    <CommandLine key={command} command={command} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
