import { create } from 'zustand';
import type { BrowserRequest, DesktopBridge } from '@pantheon/protocol';
import { startSync, type SyncView } from './sync';

declare global {
  interface Window {
    pantheon?: DesktopBridge;
  }
}

interface BoardState extends SyncView {
  /** browser makes this window answer the sessions' browser tool calls. */
  start: (project_id?: string, browser?: (request: BrowserRequest) => void) => void;
  stop: () => void;
  refresh: () => void;
  reconnect: () => void;
}

let sync: ReturnType<typeof startSync> | undefined;

export const useBoard = create<BoardState>((set) => ({
  board: null,
  events: [],
  cursor: 0,
  changed: 0,
  reads: {},
  status: { state: 'connecting' },
  error: null,
  resync: 0,
  trace_revision: 0,
  stale: false,
  start: (project_id, browser) => {
    useBoard.getState().stop();
    const bridge = window.pantheon;
    if (!bridge) {
      set({
        board: null,
        events: [],
        cursor: 0,
        changed: 0,
        reads: {},
        status: { state: 'offline', reason: 'Desktop bridge unavailable' },
        error: null,
        resync: 0,
        stale: false,
      });
      return;
    }
    sync = startSync(bridge, { project_id, browser }, set);
  },
  stop: () => {
    sync?.stop();
    sync = undefined;
  },
  refresh: () => sync?.refresh(),
  reconnect: () => sync?.reconnect(),
}));
