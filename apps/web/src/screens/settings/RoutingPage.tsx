import { useState, type ReactNode } from 'react';
import { LoadError } from '../../components/LoadError';
import { ChevronDown } from 'lucide-react';
import type { BoardSnapshot } from '@pantheon/protocol';
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/Menu';
import { ModelMark, RuntimeGlyph } from '../../components/RuntimeGlyph';
import {
  kindText,
  setRouting,
  sortedCells,
  useRoutingTable,
  type RoutingCell,
} from '../../data/workflow-policy';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { Loading, Section } from './ProjectSettingsScreen';
import { EmptyState } from '../../components/EmptyState';
import './routing-table.css';

type Project = BoardSnapshot['projects'][number];
type Choice = NonNullable<RoutingCell['first']>;
type Slot = 'first' | 'alternate';

const dash = (
  <span role="cell" className="mu">
    —
  </span>
);

const choiceKey = (c: Choice) => `${c.runtime}\n${c.model}\n${c.effort ?? ''}`;

const runsText = (runs: number) =>
  t(
    { id: 'settings.routing.runs', defaultMessage: '{runs, plural, one {# run} other {# runs}}' },
    { runs },
  );

/** A slot's model chip; its menu leaves the slot to the records or picks one of the cell's candidates. */
function CellChoice({
  cell,
  slot,
  label,
  disabled,
  onChoose,
}: {
  cell: RoutingCell;
  slot: Slot;
  label: string;
  disabled: boolean;
  onChoose: (choice: Choice | null) => void;
}) {
  const choice = cell[slot]!;
  const chip = (
    <button type="button" className="chip rtt-mc" disabled={disabled} aria-label={label}>
      <RuntimeGlyph runtime={choice.runtime} />
      <ModelMark model={choice.model} beside={choice.runtime} />
      <span className="mono rtt-cut">{choice.model}</span>
      <ChevronDown className="rtt-dn" aria-hidden="true" />
    </button>
  );
  if (disabled) return chip;
  return (
    <Menu label={label} trigger={chip}>
      <MenuRadioGroup
        value={cell[`${slot}_source`] === 'user' ? choiceKey(choice) : ''}
        onChange={(key) => {
          const c = cell.candidates.find((x) => choiceKey(x) === key);
          onChoose(
            c
              ? { runtime: c.runtime, model: c.model, ...(c.effort && { effort: c.effort }) }
              : null,
          );
        }}
      >
        <MenuRadioItem value="">
          {t({ id: 'settings.routing.auto', defaultMessage: 'Choose from the records' })}
        </MenuRadioItem>
        <MenuSeparator />
        {cell.candidates.map((c) => (
          <MenuRadioItem
            key={choiceKey(c)}
            value={choiceKey(c)}
            icon={<RuntimeGlyph runtime={c.runtime} />}
          >
            <span className="rtt-ci">
              <span className="mono rtt-cut">{c.model}</span>
              <span className="rtt-n">
                <span>{runsText(c.n)}</span>
                {c.success_rate !== null && (
                  <span className="mu">{`${Math.round(c.success_rate * 100)}%`}</span>
                )}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

/** The first choice's local runs and how many passed the gate on the first try. */
function samples(cell: RoutingCell): ReactNode {
  const first = cell.first;
  const c =
    first &&
    cell.candidates.find(
      (x) => x.runtime === first.runtime && x.model === first.model && x.effort === first.effort,
    );
  if (!c || c.n === 0) return dash;
  return (
    <span
      role="cell"
      className="rtt-n"
      aria-label={t(
        {
          id: 'settings.routing.sample',
          defaultMessage:
            '{runs, plural, one {# local run} other {# local runs}}, {passed} passed on the first try',
        },
        { runs: c.n, passed: c.s },
      )}
    >
      <span>{runsText(c.n)}</span>
      <span className="mu">{`${Math.round((c.s / c.n) * 100)}%`}</span>
    </span>
  );
}

/** Which model each task kind goes to, from local gate history and public leaderboards. */
export function RoutingPage({ project }: { project: Project }) {
  const table = useRoutingTable(project.id);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const title = t({ id: 'settings.routing.title', defaultMessage: 'Routing table' });
  if (!table.read)
    return (
      <Section title={title}>
        {table.error ? <LoadError message={table.error} onRetry={table.reload} /> : <Loading />}
      </Section>
    );
  const cells = sortedCells(table.read.cells);
  // A project on one model runs every cell on its defaults.
  const fixed = pending || project.session_defaults?.single_model === true;
  const choose = async (cell: RoutingCell, slot: Slot, choice: Choice | null) => {
    setPending(true);
    setFailure(null);
    const result = await setRouting(project, cell, slot, choice);
    setPending(false);
    if (result.ok) table.reload();
    else setFailure(result.error);
  };
  const slotChip = (cell: RoutingCell, slot: Slot, label: string): ReactNode =>
    cell[slot] ? (
      <span role="cell" className="rtt-m">
        <CellChoice
          cell={cell}
          slot={slot}
          label={label}
          disabled={fixed}
          onChoose={(choice) => void choose(cell, slot, choice)}
        />
      </span>
    ) : (
      dash
    );
  return (
    <Section title={title}>
      {table.error && (
        <div className="ps-err" role="alert">
          {table.error}
        </div>
      )}
      {failure && (
        <div className="ps-err" role="alert">
          {failure}
        </div>
      )}
      {cells.length === 0 ? (
        <EmptyState
          inline
          title={t({
            id: 'settings.routing.empty',
            defaultMessage: 'No task kind has candidate models yet',
          })}
        />
      ) : (
        <div role="table" aria-label={title} className="rtt">
          <div role="row" className="rtt-r rtt-hd">
            <span role="columnheader" className="cap" data-setting-id="routing.kind">
              {t({ id: 'settings.routing.kind', defaultMessage: 'Task kind' })}
            </span>
            <span role="columnheader" className="cap" data-setting-id="routing.first">
              {t({ id: 'settings.routing.first', defaultMessage: 'First choice' })}
            </span>
            <span role="columnheader" className="cap" data-setting-id="routing.alternate">
              {t({ id: 'settings.routing.alternate', defaultMessage: 'Alternate' })}
            </span>
            <span role="columnheader" className="cap" data-setting-id="routing.samples">
              {t({ id: 'settings.routing.samples', defaultMessage: 'Local samples' })}
            </span>
            <span role="columnheader" className="cap" data-setting-id="routing.leaderboard">
              {t({ id: 'settings.routing.leaderboard', defaultMessage: 'Leaderboard' })}
            </span>
          </div>
          {cells.map((cell) => {
            const kind = kindText(cell.domain, cell.tier);
            return (
              <div role="row" key={`${cell.domain}:${cell.tier}`} className="rtt-r">
                <span role="rowheader" className="rtt-cut">
                  {kind}
                </span>
                {slotChip(
                  cell,
                  'first',
                  t(
                    { id: 'settings.routing.firstOf', defaultMessage: '{kind} first choice' },
                    { kind },
                  ),
                )}
                {slotChip(
                  cell,
                  'alternate',
                  t(
                    { id: 'settings.routing.alternateOf', defaultMessage: '{kind} alternate' },
                    { kind },
                  ),
                )}
                {samples(cell)}
                {cell.prior ? (
                  <span role="cell" className="rtt-b">
                    <span className="rtt-cut">{cell.prior.source}</span>
                    <time dateTime={cell.prior.fetched_at} className="mono mu">
                      {dayText(Date.parse(cell.prior.fetched_at), Date.now())}
                    </time>
                  </span>
                ) : (
                  dash
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
