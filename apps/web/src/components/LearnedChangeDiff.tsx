import type { Improvement, Project } from '@pantheon/domain';
import { t } from '../i18n';
import { durationText } from '../lib/time-text';
import { joinArgv } from '../screens/settings/gate';
import './learned-change-diff.css';

type GateChange = Extract<Improvement['change'], { type: 'gate_command' }>;
type SetupChange = Extract<Improvement['change'], { type: 'worktree_setup' }>;

/**
 * What a gate or worktree setup change replaces: its stored `from` once it was applied, else the
 * project's value now, since the daemon records `from` only when it applies the change.
 */
export function changeFrom(
  improvement: Improvement | undefined,
  projects: readonly Project[] | undefined,
): GateChange['from'] | SetupChange['from'] {
  const change = improvement?.change;
  if (change?.type !== 'gate_command' && change?.type !== 'worktree_setup') return undefined;
  if (improvement!.status !== 'candidate' && improvement!.status !== 'rejected') return change.from;
  const project = projects?.find((p) => p.id === improvement!.project_id);
  return change.type === 'gate_command' ? project?.gates?.[change.root] : project?.worktree;
}

/** One drawn line; `id` covers every field, so a line differs from the other side's in any of them. */
type Line = { id: string; name?: string; code: string; marks: string[] };

const timeoutMarks = (timeout_ms: number | undefined) =>
  timeout_ms === undefined ? [] : [durationText(timeout_ms)];

const gateLines = (gate: GateChange['from']): Line[] =>
  (gate ?? []).map((c) => ({
    id: JSON.stringify([c.name, c.argv, c.enabled ?? true, c.skippable ?? false, c.timeout_ms]),
    name: c.name,
    code: joinArgv(c.argv),
    marks: [
      ...(c.enabled === false
        ? [t({ id: 'components.learnedChange.off', defaultMessage: 'Off' })]
        : []),
      ...(c.skippable
        ? [t({ id: 'components.learnedChange.skippable', defaultMessage: 'Failure is skipped' })]
        : []),
      ...timeoutMarks(c.timeout_ms),
    ],
  }));

const setupLines = (setup: SetupChange['from']): Line[] => [
  ...(setup?.copy_paths ?? []).map((path) => ({
    id: JSON.stringify(['path', path]),
    code: path,
    marks: [],
  })),
  ...(setup?.command
    ? [
        {
          id: JSON.stringify(['command', setup.command.argv, setup.command.timeout_ms]),
          code: joinArgv(setup.command.argv),
          marks: timeoutMarks(setup.command.timeout_ms),
        },
      ]
    : []),
];

/** The gate of one folder or the worktree setup as it is now and as proposed, a line each. */
export function LearnedChangeDiff({
  change,
  from,
}: {
  change: GateChange | SetupChange;
  from: GateChange['from'] | SetupChange['from'];
}) {
  const gate = change.type === 'gate_command';
  const before = gate
    ? gateLines(from as GateChange['from'])
    : setupLines(from as SetupChange['from']);
  const after = gate ? gateLines(change.to) : setupLines(change.to);
  const none = gate
    ? t({ id: 'components.learnedChange.noGate', defaultMessage: 'No gate' })
    : t({ id: 'components.learnedChange.noSetup', defaultMessage: 'No setup' });
  const side = (label: string, kind: 'del' | 'add', lines: Line[], other: Line[]) => (
    <div className="lcd-side">
      <span className="cap" aria-hidden="true">
        {label}
      </span>
      <ul className="lcd-lines" aria-label={label}>
        {lines.length > 0 ? (
          lines.map((line, i) => {
            const changed = !other.some((o) => o.id === line.id);
            return (
              <li key={i} data-kind={changed ? kind : undefined}>
                <span>{changed ? (kind === 'del' ? '−' : '+') : ''}</span>
                <span className="lcd-cmd">
                  {line.name && <span>{line.name}</span>}
                  <code>{line.code}</code>
                  {line.marks.map((mark) => (
                    <span key={mark} className="lcd-mark">
                      {mark}
                    </span>
                  ))}
                </span>
              </li>
            );
          })
        ) : (
          <li className="lcd-none">{none}</li>
        )}
      </ul>
    </div>
  );
  return (
    <div
      className="lcd"
      role="group"
      aria-label={
        gate
          ? t(
              { id: 'components.learnedChange.gate', defaultMessage: 'Gate of {root}' },
              { root: change.root },
            )
          : t({ id: 'components.learnedChange.worktree', defaultMessage: 'Worktree setup' })
      }
    >
      {gate && <code className="lcd-root">{change.root}</code>}
      {side(t({ id: 'components.learnedChange.now', defaultMessage: 'Now' }), 'del', before, after)}
      {side(
        t({ id: 'components.learnedChange.proposed', defaultMessage: 'Proposed' }),
        'add',
        after,
        before,
      )}
    </div>
  );
}
