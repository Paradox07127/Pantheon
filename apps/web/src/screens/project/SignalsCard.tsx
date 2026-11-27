import { useState } from 'react';
import { Failure } from '../../components/PanelBoundary';
import { ageText, useNow } from '../../data/needs-you';
import { sendProjectCommand } from '../../data/project-read';
import { useProjectSignals, type SignalIssue } from '../../data/signals';
import { t } from '../../i18n';
import { orderSignals, signalCountText, signalSourceText, signalStateText } from './signals-model';

/** The project's repeated and flaky gate failures; absent while there are none. */
export function SignalsCard({ projectId }: { projectId: string }) {
  const signals = useProjectSignals(projectId);
  const now = useNow(60_000);
  const [expanded, setExpanded] = useState<string | null>(null);
  // The issue a resolve is out for.
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; error: string } | null>(null);
  const shown = orderSignals(signals.read?.issues ?? []);
  if (shown.length === 0 && !signals.error) return null;
  const resolve = async (issue: SignalIssue) => {
    if (busy) return;
    setBusy(issue.id);
    setFailed(null);
    const result = await sendProjectCommand(
      'project.signal.resolve',
      { project_id: projectId, issue_id: issue.id },
      null,
    );
    setBusy(null);
    if (!result.ok) setFailed({ id: issue.id, error: result.error });
    else signals.reload();
  };
  const title = t({ id: 'project.signals.title', defaultMessage: 'Signals' });
  return (
    <section className="pj-card" aria-label={title}>
      <div className="pj-ch">
        <h2 className="pj-h2">{title}</h2>
      </div>
      {signals.error && <Failure error={signals.error} onRetry={signals.reload} />}
      {shown.length > 0 && (
        <ul className="pj-ros">
          {shown.map((issue) => {
            const open = expanded === issue.id;
            return (
              <li key={issue.id} className="pj-ro" aria-label={issue.title}>
                <button
                  type="button"
                  className="pj-sg-h"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : issue.id)}
                >
                  <span className="pj-ro-h">
                    <span className="pj-sg-st">{signalStateText(issue.state)}</span>
                    <span className="pj-dl">{signalSourceText(issue.source)}</span>
                    <span className="pj-dl">{signalCountText(issue.count)}</span>
                    <span className="pj-dl pj-end">{ageText(issue.last_seen, now)}</span>
                  </span>
                  <span className="pj-sg-nm">{issue.title}</span>
                </button>
                {open && issue.samples[0] && (
                  <pre className="pj-sg-smp">{issue.samples[0].text}</pre>
                )}
                {failed?.id === issue.id && (
                  <div className="pj-cerr" role="alert">
                    {failed.error}
                  </div>
                )}
                {issue.state !== 'resolved' && (
                  <div className="pj-ro-acts">
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy !== null}
                      onClick={() => void resolve(issue)}
                    >
                      {t({ id: 'project.signals.resolve', defaultMessage: 'Mark resolved' })}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
