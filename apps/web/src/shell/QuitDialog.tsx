import { useEffect } from 'react';
import type { BoardSnapshot } from '@pantheon/protocol';
import { useBoard } from '../data/board';
import { t } from '../i18n';
import { useQueued } from '../screens/sessions/compose';

const runningCount = (board: BoardSnapshot | null): number =>
  board?.sessions.filter((session) => session.state === 'running').length ?? 0;

/** Answers the desktop app's quit request: at once with no session running, else after the app asks. */
export function QuitDialog() {
  useEffect(
    () =>
      window.pantheon?.onQuitRequest(() => {
        const bridge = window.pantheon!;
        const running = runningCount(useBoard.getState().board);
        if (running === 0) {
          void bridge.confirmQuit().catch(() => {});
          return;
        }
        const queued = Object.values(useQueued.getState().queued).reduce(
          (sum, list) => sum + list.length,
          0,
        );
        const lines = [
          t(
            {
              id: 'quitDialog.running',
              defaultMessage:
                '{count, plural, one {# session is running and finishes} other {# sessions are running and finish}} after you quit',
            },
            { count: running },
          ),
          t({
            id: 'quitDialog.notifications',
            defaultMessage: 'Notifications stop until you open Pantheon again',
          }),
        ];
        if (queued > 0)
          lines.push(
            t(
              {
                id: 'quitDialog.queued',
                defaultMessage:
                  '{count, plural, one {# queued message waits} other {# queued messages wait}} until you open Pantheon again',
              },
              { count: queued },
            ),
          );
        void bridge
          .askQuit({
            message: t(
              {
                id: 'quitDialog.title',
                defaultMessage:
                  'Quit Pantheon? {count, plural, one {# session keeps} other {# sessions keep}} running in the background',
              },
              { count: running },
            ),
            detail: lines.join('\n'),
            quit: t({ id: 'quitDialog.quit', defaultMessage: 'Quit' }),
            cancel: t({ id: 'quitDialog.cancel', defaultMessage: 'Cancel' }),
          })
          .catch(() => {});
      }),
    [],
  );
  return null;
}
