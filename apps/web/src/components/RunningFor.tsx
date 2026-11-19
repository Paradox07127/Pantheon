import { useNow } from '../data/needs-you';
import { t } from '../i18n';
import { durationText } from '../lib/time-text';
import { StateGlyph } from './SessionStateIcon';
import './running-for.css';

// Getters, so each label is read in the language loaded by then.
export const RUNNING = {
  get writing() {
    return t({ id: 'components.running.writing', defaultMessage: 'Writing' });
  },
  get redrawing() {
    return t({ id: 'components.running.redrawing', defaultMessage: 'Redrawing' });
  },
  get measuring() {
    return t({ id: 'components.running.measuring', defaultMessage: 'Measuring' });
  },
};

/** What is running, and for how long in whole seconds when its start is known. */
export function RunningFor({ label, since }: { label: string; since: number | null }) {
  const now = useNow();
  return (
    <span className="run-for">
      <StateGlyph name="running" />
      <span className="tr-status">
        {label}
        <span className="tr-shine" aria-hidden="true">
          {label}
        </span>
      </span>
      {since !== null && <span className="mono mu run-for-num">{durationText(now - since)}</span>}
    </span>
  );
}
