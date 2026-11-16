import { Beaker, BookOpen, Bot, Compass, ListTree, ScanSearch, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '../i18n';

/** The subagent types with an icon, matched on the type the runtime reports; labels are getters. */
const TYPES: { pattern: RegExp; icon: LucideIcon; readonly label: string }[] = [
  {
    pattern: /^explore/i,
    icon: Compass,
    get label() {
      return t({ id: 'sessions.agentType.explore', defaultMessage: 'Explore' });
    },
  },
  {
    pattern: /^plan/i,
    icon: ListTree,
    get label() {
      return t({ id: 'sessions.agentType.plan', defaultMessage: 'Plan' });
    },
  },
  {
    pattern: /^general/i,
    icon: Bot,
    get label() {
      return t({ id: 'sessions.agentType.general', defaultMessage: 'General' });
    },
  },
  {
    pattern: /^(?:worker|coder?\b|implement)/i,
    icon: Wrench,
    get label() {
      return t({ id: 'sessions.agentType.code', defaultMessage: 'Code' });
    },
  },
  {
    pattern: /research/i,
    icon: BookOpen,
    get label() {
      return t({ id: 'sessions.agentType.research', defaultMessage: 'Research' });
    },
  },
  {
    pattern: /review/i,
    icon: ScanSearch,
    get label() {
      return t({ id: 'sessions.agentType.review', defaultMessage: 'Review' });
    },
  },
  {
    pattern: /test/i,
    icon: Beaker,
    get label() {
      return t({ id: 'sessions.agentType.test', defaultMessage: 'Test' });
    },
  },
];

/** The type's own label when it has an icon, else the type as the runtime reported it. */
export const agentTypeName = (type: string): string =>
  TYPES.find((k) => k.pattern.test(type))?.label ?? type;

/** A subagent's type: its line icon, or the first letter of a type without one in a square. */
export function AgentTypeIcon({ type }: { type: string }) {
  const known = TYPES.find((k) => k.pattern.test(type));
  const label = t(
    { id: 'sessions.agentType.label', defaultMessage: 'Type: {type}' },
    { type: known?.label ?? type },
  );
  if (known) return <known.icon className="ic-sm agt" role="img" aria-label={label} />;
  return (
    <span className="agt-ltr" role="img" aria-label={label}>
      {type.trim().charAt(0).toUpperCase()}
    </span>
  );
}
