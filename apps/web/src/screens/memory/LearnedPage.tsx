import { useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { LoadError } from '../../components/LoadError';
import { ChartLine } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useBoardView } from '../../data/board-view';
import { useLearned, type LearnedItem } from '../../data/learned';
import { t } from '../../i18n';
import { reducedMotion } from '../../lib/motion';
import { keyText } from '../../lib/shortcuts';
import { useShell } from '../../store';
import { retroTasks, RetroPanel } from '../board/RetroPanel';
import { TaskDrawer } from '../board/TaskDrawer';
import { LearnedDetail } from './LearnedDetail';
import { LearnedList, OPEN_GROUPS } from './LearnedList';
import './memory-learned-page.css';

const SKELETON_ROWS = [176, 136, 152, 112];

const firstRule = (items: readonly LearnedItem[]) =>
  OPEN_GROUPS.flatMap((group) => items.filter((i) => i.group === group))[0]?.id ?? null;

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

/** What the harness learned from each finished task of the project, with the drawer of the task opened. */
function Retrospectives({
  projectId,
  headRef,
}: {
  projectId: string;
  headRef?: RefObject<HTMLHeadingElement | null>;
}) {
  const view = useBoardView(projectId, 'all');
  const openSession = useShell((s) => s.openSession);
  const [task, setTask] = useState<string | null>(null);
  const id = useId();
  const model = view.data;
  return (
    <section
      className="lp-sec"
      aria-labelledby={id}
      aria-busy={(!model && !view.error) || undefined}
    >
      <div className="lp-sh">
        <h2 id={id} ref={headRef} tabIndex={-1}>
          {t({ id: 'memory.learnedPage.retros', defaultMessage: 'Retrospectives' })}
        </h2>
        {model && <span className="lp-n">{retroTasks(model.tasks).length}</span>}
      </div>
      {model ? (
        <>
          <RetroPanel model={model} projectId={projectId} onOpenTask={setTask} />
          <TaskDrawer
            model={model}
            taskId={task}
            onSelect={setTask}
            onOpenSession={(sessionId) => openSession(sessionId)}
            onOpenStory={(sessionId) => openSession(sessionId, 'story')}
          />
        </>
      ) : view.error ? (
        <LoadError message={view.error} onRetry={view.reload} />
      ) : (
        <Skeleton style={{ height: 160 }} />
      )}
    </section>
  );
}

/** The project's learned changes beside the details of the one selected, its retrospectives under them. */
export function LearnedPage({
  projectId,
  onOpenRetros,
}: {
  projectId: string;
  onOpenRetros: (retrospectiveId?: string) => void;
}) {
  const list = useLearned(projectId);
  // Undefined until a row is picked; null once the details are closed.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const retros = useRef<HTMLHeadingElement>(null);

  const items = list.read ?? [];
  if (list.read === null && !list.error)
    return (
      <div className="lp">
        <div className="lp-list">
          <section
            className="lr"
            aria-busy="true"
            aria-label={t({ id: 'memory.learned.label', defaultMessage: 'Learned changes' })}
          >
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
      <div className="lp">
        <div className="lp-list">
          <div className="lp-empty">
            <EmptyState
              graphic={<ChartLine aria-hidden="true" />}
              title={t({ id: 'memory.learnedPage.empty', defaultMessage: 'Nothing learned yet' })}
              action={{
                label: t({
                  id: 'memory.learnedPage.openRetros',
                  defaultMessage: 'See retrospectives',
                }),
                onClick: () => {
                  const head = retros.current;
                  if (!head) return;
                  head.scrollIntoView({
                    behavior: reducedMotion() ? 'auto' : 'smooth',
                    block: 'start',
                  });
                  head.focus({ preventScroll: true });
                },
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
          <Retrospectives projectId={projectId} headRef={retros} />
        </div>
      </div>
    );

  const selected =
    picked === null ? null : items.some((i) => i.id === picked) ? picked! : firstRule(items);
  const item = items.find((i) => i.id === selected);
  return (
    <div className="lp" data-open={item ? '' : undefined}>
      <div className="lp-list" onKeyDown={moveSelection}>
        <LearnedList items={items} selected={selected} onSelect={setPicked} />
        {list.error && (
          <LoadError
            message={t(
              {
                id: 'memory.learnedPage.readFailed',
                defaultMessage: 'Couldn’t read the learned changes: {error}',
              },
              { error: list.error },
            )}
            onRetry={list.reload}
          />
        )}
        <Retrospectives projectId={projectId} />
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
