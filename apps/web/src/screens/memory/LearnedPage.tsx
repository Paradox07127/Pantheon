import { useState, type KeyboardEvent } from 'react';
import { LoadError } from '../../components/LoadError';
import { ChartLine } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useImprovements, useWorkflowPolicy, type Improvement } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { LearnedDetail } from './LearnedDetail';
import { LearnedList } from './LearnedList';
import './memory-learned-page.css';

// The groups the list shows unfolded, in its order.
const OPEN: readonly Improvement['status'][] = ['candidate', 'trial', 'active'];

const SKELETON_ROWS = [176, 136, 152, 112];

const firstRule = (items: readonly Improvement[]) =>
  OPEN.flatMap((status) => items.filter((i) => i.status === status))[0]?.id ?? null;

/** Up and down move the selection from the focused row to the one above or below it, across groups. */
function moveSelection(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  const at = rows.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  const next = rows[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.click();
}

/** The project's learned rules beside the details of the one selected. */
export function LearnedPage({
  projectId,
  onOpenRetros,
}: {
  projectId: string;
  onOpenRetros: (retrospectiveId?: string) => void;
}) {
  const list = useImprovements(projectId);
  const policy = useWorkflowPolicy(projectId);
  // Undefined until a row is picked; null once the details are closed.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);

  const items = list.read ?? [];
  if (list.read === null && !list.error)
    return (
      <div className="lp">
        <div className="lp-list">
          <section
            className="lr"
            aria-busy="true"
            aria-label={t({ id: 'memory.learned.label', defaultMessage: 'Learned rules' })}
          >
            <div className="lr-head" />
            <div className="lr-gh">
              <Skeleton style={{ width: 48 }} />
            </div>
            {SKELETON_ROWS.map((width) => (
              <div key={width} className="lr-row lr-sk">
                <Skeleton />
                <Skeleton style={{ width }} />
                <Skeleton style={{ width: 96 }} />
                <Skeleton style={{ width: 48 }} />
                <Skeleton />
              </div>
            ))}
          </section>
        </div>
      </div>
    );
  if (list.read?.length === 0 && !list.error)
    return (
      <div className="lp-empty">
        <EmptyState
          graphic={<ChartLine aria-hidden="true" />}
          title={t({ id: 'memory.learnedPage.empty', defaultMessage: 'No learned rules yet' })}
          action={{
            label: t({ id: 'memory.learnedPage.openRetros', defaultMessage: 'See retrospectives' }),
            onClick: () => onOpenRetros(),
          }}
        />
        <span className="lp-hint">
          <span className="kbd">{keyText('Meta+K')}</span>
          <span>
            {t({
              id: 'memory.learnedPage.searchHint',
              defaultMessage: 'Type “retrospective”',
            })}
          </span>
        </span>
      </div>
    );

  const selected =
    picked === null ? null : items.some((i) => i.id === picked) ? picked! : firstRule(items);
  const item = items.find((i) => i.id === selected);
  return (
    <div className="lp" data-open={item ? '' : undefined}>
      <div className="lp-list" onKeyDown={moveSelection}>
        <LearnedList
          items={items}
          pinned={policy.read?.pinned ?? []}
          selected={selected}
          onSelect={setPicked}
        />
        {list.error && (
          <LoadError
            message={t(
              {
                id: 'memory.learnedPage.readFailed',
                defaultMessage: 'Couldn’t read the learned rules: {error}',
              },
              { error: list.error },
            )}
            onRetry={list.reload}
          />
        )}
      </div>
      {item && (
        <LearnedDetail
          projectId={projectId}
          item={item}
          onClose={() => setPicked(null)}
          onOpenRetro={onOpenRetros}
        />
      )}
    </div>
  );
}
