import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Tip } from '../../components/Tip';
import { sendProjectCommand, type Receipt } from '../../data/project-read';
import { currentLocale, t } from '../../i18n';
import type { Availability, Request } from './brief';

export const at = (ms: number) =>
  new Intl.DateTimeFormat(currentLocale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms);

export const Chip = ({ text, tone }: { text: string; tone: string }) => (
  <span className={tone ? `tr-st ${tone}` : 'tr-st'}>{text}</span>
);

/** One command at a time, its failure kept until the next send, its receipt shown after. */
export function useSend() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const send = async (req: Request, onDone?: (value: unknown) => void): Promise<boolean> => {
    if (!req.ok) {
      setError(req.errors.join(t({ id: 'projects.errorSeparator', defaultMessage: '; ' })));
      return false;
    }
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await sendProjectCommand(req.type, req.input, req.expected_revision);
    if (!alive.current) return false;
    sending.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setReceipt(result.receipt);
    onDone?.(result.value);
    return true;
  };
  return { busy, error, receipt, send, clearError: () => setError(null) };
}

export type Send = ReturnType<typeof useSend>;

export function Button(props: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  state?: Availability;
  tone?: 'pri' | 'ghost';
  /** Id of the element that says why or what next. */
  describedBy?: string;
  onPress: () => void;
}) {
  const off = props.busy || (props.state ? !props.state.enabled : false);
  const element = (
    <button
      type="button"
      className={props.tone ? `btn ${props.tone}` : 'btn'}
      aria-disabled={off || undefined}
      aria-describedby={props.describedBy}
      onClick={off ? undefined : props.onPress}
    >
      {props.busy && props.tone === 'pri'
        ? (props.busyLabel ?? t({ id: 'projects.sending', defaultMessage: 'Sending…' }))
        : props.label}
    </button>
  );
  return props.state?.reason ? <Tip content={props.state.reason}>{element}</Tip> : element;
}

export function Field(props: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={props.wide ? 'pj-fd hm-wide' : 'pj-fd'}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
