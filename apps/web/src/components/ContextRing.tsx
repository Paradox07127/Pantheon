import { t } from '../i18n';
import './context-ring.css';

/** The share of the context window used; warns past 80%. */
export function ContextRing({
  context,
}: {
  context: { used_tokens: number; window_tokens: number };
}) {
  const percent = Math.min(100, Math.round((context.used_tokens / context.window_tokens) * 100));
  return (
    <svg
      className="bd-nctx"
      data-high={percent > 80 || undefined}
      width="16"
      height="16"
      viewBox="0 0 32 32"
      role="img"
      aria-label={t(
        { id: 'board.plan.flow.context', defaultMessage: 'Context {percent}% used' },
        { percent },
      )}
    >
      <circle cx="16" cy="16" r="13" pathLength={100} />
      <circle
        cx="16"
        cy="16"
        r="13"
        pathLength={100}
        strokeDasharray={`${percent} 100`}
        transform="rotate(-90 16 16)"
      />
    </svg>
  );
}
