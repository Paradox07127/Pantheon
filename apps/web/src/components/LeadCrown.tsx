import { Crown } from 'lucide-react';
import { t } from '../i18n';

/** The 12px crown after the name of a lead session. */
export function LeadCrown() {
  return (
    <Crown
      className="lead-crown"
      role="img"
      aria-label={t({ id: 'components.leadCrown.label', defaultMessage: 'Lead session' })}
    />
  );
}
