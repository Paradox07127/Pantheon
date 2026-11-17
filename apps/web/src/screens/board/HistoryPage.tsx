import type { ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import type { BoardPage } from '../../data/board-page';
import { HistoryTab } from './BoardScreen';

/** The whole history view's body. */
export function HistoryPage({
  model,
  projectId,
  setupPanel,
  loadingPanel,
  onOpenSession,
  onPage,
  selectFlow,
  historyBar,
}: {
  model: BoardModel | null;
  projectId?: string;
  setupPanel: ReactNode;
  loadingPanel: ReactNode;
  onOpenSession: (sessionId: string) => void;
  onPage: (page: BoardPage) => void;
  selectFlow: (taskId: string | null) => void;
  historyBar: HTMLElement | null;
}) {
  return (
    <div className="bd-body">
      {!model ? (
        loadingPanel
      ) : projectId ? (
        <HistoryTab
          projectId={projectId}
          empty={setupPanel}
          lanes={model.lanes}
          now={model.now}
          milestones={model.milestones}
          onOpenSession={onOpenSession}
          onOpenTask={(taskId) => {
            onPage('now');
            selectFlow(taskId);
          }}
          bar={historyBar}
        />
      ) : null}
    </div>
  );
}
