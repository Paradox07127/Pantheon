import { useState } from 'react';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { ChevronDown, Crown, LayoutDashboard } from 'lucide-react';
import type { RuntimeDiagnostics } from '@pantheon/domain';
import { MenuGroup, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/Menu';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { runCommand } from '../../data/commands';
import { reasonText } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import './diagnose.css';

/**
 * The lead a new analysis reports to: the chosen one, else the first lead until one is chosen;
 * none once the whole project is chosen (null).
 */
export function analysisLead(
  leads: readonly { id: string }[],
  chosen: string | null | undefined,
): string | undefined {
  if (chosen === null) return undefined;
  return leads.some((row) => row.id === chosen) ? chosen : leads[0]?.id;
}

/** The diagnose tab's bar menu that starts an analysis of the window in a new session. */
export function AnalyzeMenu({
  projectId,
  diagnostics,
  runtimes,
  leads,
  lead: chosenLead,
  onLead,
  windowText,
  stale,
}: {
  projectId: string;
  diagnostics: RuntimeDiagnostics;
  /** Runtimes that can run an isolated analysis. */
  runtimes: string[];
  leads: { id: string; title: string }[];
  /** See analysisLead. */
  lead: string | null | undefined;
  onLead: (lead: string | null) => void;
  /** The window as the bar writes it. */
  windowText: string | null;
  stale: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [chosenRuntime, setChosenRuntime] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const runtime = runtimes.includes(chosenRuntime) ? chosenRuntime : runtimes[0];
  const lead = analysisLead(leads, chosenLead);
  const empty =
    !diagnostics.findings.length && !diagnostics.events_read && !diagnostics.coverage?.native_lanes;
  const label = t({ id: 'trace.diagnose.analyze', defaultMessage: 'Ask Lead to analyze' });
  const start = async () => {
    if (!runtime || sending || stale) return;
    setSending(true);
    setFailure(null);
    const { from, to } = diagnostics;
    const result = await runCommand(
      'trace.reflect',
      { project_id: projectId, runtime, ...(lead ? { lead_session_id: lead } : {}), from, to },
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
            {leads.length > 0 && (
              <>
                <MenuSeparator />
                <MenuGroup
                  label={t({
                    id: 'trace.diagnose.sendTo',
                    defaultMessage: 'Send the conclusion to',
                  })}
                >
                  <MenuRadioGroup
                    value={lead ?? ''}
                    onChange={(value) => onLead(value === '' ? null : value)}
                  >
                    {leads.map(({ id, title }) => (
                      <MenuRadioItem key={id} value={id} icon={<Crown />}>
                        {title}
                      </MenuRadioItem>
                    ))}
                    <MenuRadioItem value="" icon={<LayoutDashboard />}>
                      {t({ id: 'trace.runtime.noLeadLink', defaultMessage: 'Project-wide' })}
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
              </>
            )}
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
