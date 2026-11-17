import type { BoardModel } from '@pantheon/protocol';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { PanelBoundary, type ChangeLayout } from './BoardScreen';
import { CanvasView, type CanvasPanel } from './CanvasView';
import { TaskGroups } from './TaskGroups';

/** The canvas view's body: the laid out panels, the pinned visuals and the task groups. */
export function CanvasPage({
  model,
  shown,
  projectId,
  canvasBar,
  canvasPanels,
  empty,
  onLayout,
  onRetry,
  selectFlow,
}: {
  model: BoardModel | null;
  shown: BoardModel;
  projectId?: string;
  canvasBar: HTMLElement | null;
  canvasPanels: readonly CanvasPanel[];
  empty: boolean;
  onLayout: ChangeLayout;
  onRetry: () => void;
  selectFlow: (taskId: string | null) => void;
}) {
  return (
    <div className="bd-body">
      <CanvasView
        projectId={projectId}
        bar={canvasBar}
        panels={canvasPanels}
        boardEmpty={empty}
        onLayout={onLayout}
        onDraw={() => useShell.getState().startNewSession()}
        tasks={
          !empty &&
          shown.tasks.some((t) => t.state) && (
            <div className="bd-s12">
              <PanelBoundary
                title={t({ id: 'board.panels.tasks', defaultMessage: 'Tasks' })}
                model={model}
                onRetry={onRetry}
              >
                <TaskGroups model={shown} onOpenTask={selectFlow} />
              </PanelBoundary>
            </div>
          )
        }
      />
    </div>
  );
}
