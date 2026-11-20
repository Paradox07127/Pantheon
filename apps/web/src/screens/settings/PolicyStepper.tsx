import type { ReactNode } from 'react';
import { Minus, Plus } from 'lucide-react';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { offeredRuntimes, type RuntimeStatusRead } from '../../data/runtime-status';
import { t } from '../../i18n';

/** The protocol's highest per-runtime limit. */
const RUNTIME_LIMIT_MAX = 8;

/** The runtime_parallel record with one runtime's limit set, or taken out for no limit. */
function withRuntimeLimit(
  record: Record<string, number> | undefined,
  runtime: string,
  limit: number | null,
): Record<string, number> {
  const rest = Object.fromEntries(Object.entries(record ?? {}).filter(([r]) => r !== runtime));
  return limit === null ? rest : { ...rest, [runtime]: limit };
}

export interface StepperProps {
  /** The value's name, read by the input and its two buttons. */
  label: string;
  /** null for no limit, which only an open stepper holds. */
  value: number | null;
  low: number;
  high: number;
  /** Emptying the input lifts the limit, and stepping down from no limit gives `high`. */
  open?: boolean;
  disabled: boolean;
  /** The text typed and not set yet; null shows the value. */
  draft: string | null;
  onDraft: (draft: string | null) => void;
  /** Resolves whether the value was set. */
  onSet: (value: number | null) => Promise<boolean>;
  onInvalid: (text: string) => void;
}

/** A count between − and +, typed in the input between them and set on Enter or leaving it. */
export function policyStepper(props: StepperProps): ReactNode {
  const { label, value, low, high, open, disabled, draft, onDraft, onSet } = props;
  const set = async (to: number | null) => {
    if (await onSet(to)) onDraft(null);
  };
  const step = (by: number) => {
    const to = value === null ? (by < 0 ? high : null) : value + by;
    return disabled || to === null || to < low || to > high ? undefined : () => void set(to);
  };
  const down = step(-1);
  const up = step(1);
  const commit = () => {
    if (draft === null) return;
    const typed = draft.trim();
    const to = typed === '' && open ? null : Number(typed);
    if (to !== null && !(typed !== '' && Number.isInteger(to) && to >= low && to <= high))
      return props.onInvalid(
        t(
          {
            id: 'settings.workflow.range',
            defaultMessage: '{param} must be a whole number from {low} to {high}',
          },
          { param: label, low, high },
        ),
      );
    if (to === value) onDraft(null);
    else void set(to);
  };
  return (
    <span className="wf-stp">
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'settings.workflow.decrease', defaultMessage: 'Decrease {param}' },
          { param: label },
        )}
        disabled={!down}
        onClick={down}
      >
        <Minus aria-hidden="true" />
      </button>
      <input
        className="inp mono wf-n"
        inputMode="numeric"
        aria-label={label}
        placeholder={
          open ? t({ id: 'settings.common.noLimit', defaultMessage: 'No limit' }) : undefined
        }
        disabled={disabled}
        value={draft ?? (value === null ? '' : String(value))}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <button
        type="button"
        className="ib"
        aria-label={t(
          { id: 'settings.workflow.increase', defaultMessage: 'Increase {param}' },
          { param: label },
        )}
        disabled={!up}
        onClick={up}
      >
        <Plus aria-hidden="true" />
      </button>
    </span>
  );
}

/** Each runtime's own concurrency limit, two to a line; an empty limit is no limit. */
export function runtimeLimits({
  limits,
  status,
  disabled,
  draftOf,
  onSet,
  onInvalid,
}: {
  limits: Record<string, number> | undefined;
  /** Its installed runtimes get a stepper, as do those that have a limit. */
  status: RuntimeStatusRead;
  disabled: boolean;
  /** The text typed into a runtime's input. */
  draftOf: (runtime: string) => Pick<StepperProps, 'draft' | 'onDraft'>;
  /** Sets the whole record; resolves whether it was set. */
  onSet: (limits: Record<string, number>) => Promise<boolean>;
  onInvalid: (text: string) => void;
}): ReactNode {
  return (
    <span className="wf-rtp">
      {offeredRuntimes(status, Object.keys(limits ?? {})).map((runtime) => (
        <span key={runtime} className="wf-rt" role="group" aria-label={runtimeName(runtime)}>
          <RuntimeGlyph runtime={runtime} />
          <span className="wf-rt-n">{runtimeName(runtime)}</span>
          {policyStepper({
            label: t(
              {
                id: 'settings.workflow.runtimeLimit',
                defaultMessage: '{runtime} concurrency limit',
              },
              { runtime: runtimeName(runtime) },
            ),
            value: limits?.[runtime] ?? null,
            low: 1,
            high: RUNTIME_LIMIT_MAX,
            open: true,
            disabled,
            ...draftOf(runtime),
            onSet: (limit) => onSet(withRuntimeLimit(limits, runtime, limit)),
            onInvalid,
          })}
        </span>
      ))}
    </span>
  );
}
