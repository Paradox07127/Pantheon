import { useState } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { ChevronDown } from 'lucide-react';
import type { RuntimeDiagnostics } from '@pantheon/domain';
import { MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/Menu';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { runCommand } from '../../data/commands';
import { reasonText } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import './diagnose.css';

/** The diagnose tab's bar menu that starts an analysis of the window in a new session. */
export function AnalyzeMenu({
  projectId,
  diagnostics,
  runtimes,
  windowText,
  stale,
}: {
  projectId: string;
  diagnostics: RuntimeDiagnostics;
  /** Runtimes that can run an isolated analysis. */
  runtimes: string[];
  /** The window as the bar writes it. */
  windowText: string | null;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chosenRuntime, setChosenRuntime] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const runtime = runtimes.includes(chosenRuntime) ? chosenRuntime : runtimes[0];
  const empty =
    !diagnostics.findings.length && !diagnostics.events_read && !diagnostics.coverage?.native_lanes;
  const label = t({ id: 'trace.diagnose.analyze', defaultMessage: 'Analyze' });
  const start = async () => {
    if (!runtime || sending || stale) return;
    setSending(true);
    setFailure(null);
    const { from, to } = diagnostics;
    const result = await runCommand(
      'trace.reflect',
      { project_id: projectId, runtime, from, to },
      null,
    );
    setSending(false);
    if (!result.ok) return setFailure(reasonText(result.error.code));
    setOpen(false);
    const sessionId = (result.value as { session_id?: string } | undefined)?.session_id;
    if (sessionId) useShell.getState().openSession(sessionId);
  };

  return (
    <BaseMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setFailure(null);
      }}
    >
      <BaseMenu.Trigger
        render={
          <button type="button" className="btn pri" disabled={!runtime || stale}>
            {label}
            <ChevronDown aria-hidden="true" />
          </button>
        }
      />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 60 }}>
          <BaseMenu.Popup className="mn pop am" aria-label={label}>
            <MenuGroup
              label={t({ id: 'trace.diagnose.runtime', defaultMessage: 'Runtime to analyze with' })}
            >
              <MenuRadioGroup value={runtime ?? ''} onChange={setChosenRuntime}>
                {runtimes.map((name) => (
                  <MenuRadioItem key={name} value={name} icon={<RuntimeGlyph runtime={name} />}>
                    {runtimeName(name)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <div className="am-go">
              <BaseMenu.Item
                className="btn am-start"
                closeOnClick={false}
                disabled={empty || sending || stale}
                onClick={() => void start()}
              >
                {t({ id: 'trace.diagnose.start', defaultMessage: 'Start analysis' })}
                {windowText && <span className="am-win">{windowText}</span>}
              </BaseMenu.Item>
              {failure && (
                <span className="tr-err" role="alert">
                  {failure}
                </span>
              )}
            </div>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
