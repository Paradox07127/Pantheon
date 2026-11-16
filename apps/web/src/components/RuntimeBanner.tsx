import { useState } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import type { RuntimeStatus } from '@pantheon/protocol';
import { runCommand } from '../data/commands';
import { failureText } from '../data/needs-you';
import { useRuntimeStatus } from '../data/runtime-status';
import { t } from '../i18n';
import { compareRuntimes, runtimeName } from './RuntimeGlyph';
import { StateGlyph } from './SessionStateIcon';
import './runtime-banner.css';

/** An uninstalled runtime is not connected either, but only a failed check sets the time. */
const disconnected = (status: RuntimeStatus) =>
  status.connection?.connected === false && status.connection.disconnected_since !== undefined;

/** The daemon prefixes the startup reason with the runtime. */
const reconnectFailure = (runtime: string, error: { code: string; message: string }) =>
  error.code === 'runtime_reconnect_failed'
    ? error.message.replace(`${runtime}: `, '')
    : failureText(error);

type Attempt = { busy: boolean; error: string | null };
const IDLE: Attempt = { busy: false, error: null };

/** One banner per disconnected runtime, stacked over the top of the main area, each with a reconnect. */
export function RuntimeBanner() {
  const status = useRuntimeStatus();
  const [attempts, setAttempts] = useState<Readonly<Record<string, Attempt>>>({});
  // Every installed runtime keeps its root, so a reconnected one folds away instead of vanishing.
  const installed =
    status.read.state === 'ready'
      ? status.read.statuses
          .filter((s) => s.installed)
          .sort((a, b) => compareRuntimes(a.runtime, b.runtime))
      : [];

  const reconnect = async (runtime: string) => {
    setAttempts((now) => ({ ...now, [runtime]: { busy: true, error: null } }));
    const result = await runCommand('runtime.reconnect', { runtime }, null);
    if (result.ok) await status.reload();
    setAttempts((now) => ({
      ...now,
      [runtime]: { busy: false, error: result.ok ? null : reconnectFailure(runtime, result.error) },
    }));
  };

  return (
    <div className="rb">
      {installed.map((s) => {
        const attempt = attempts[s.runtime] ?? IDLE;
        const held = s.connection?.held_session_count ?? 0;
        return (
          <Collapsible.Root key={s.runtime} open={disconnected(s)} data-runtime={s.runtime}>
            <Collapsible.Panel className="rb-in">
              <div className="rb-row">
                <StateGlyph name="failed" />
                <span className="rb-text">
                  <span className="rb-name">
                    {t(
                      {
                        id: 'components.runtimeBanner.disconnected',
                        defaultMessage: '{name} disconnected',
                      },
                      { name: runtimeName(s.runtime) },
                    )}
                  </span>
                  {held > 0 && (
                    <span className="rb-held">
                      {t(
                        {
                          id: 'components.runtimeBanner.held',
                          defaultMessage:
                            '{count, plural, one {# session paused; its changes are still in its worktree} other {# sessions paused; their changes are still in their worktrees}}',
                        },
                        { count: held },
                      )}
                    </span>
                  )}
                  {attempt.error && (
                    <span className="rb-err" role="alert">
                      {attempt.error}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  aria-busy={attempt.busy}
                  disabled={attempt.busy}
                  onClick={() => void reconnect(s.runtime)}
                >
                  {t({ id: 'components.runtimeBanner.reconnect', defaultMessage: 'Reconnect' })}
                </button>
              </div>
            </Collapsible.Panel>
          </Collapsible.Root>
        );
      })}
    </div>
  );
}
