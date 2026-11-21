import { useState } from 'react';
import { Clip } from '../../components/Clip';
import { EnvironmentCheck, type PlannedCommands } from '../../components/EnvironmentCheck';
import { PathText } from '../../components/PathText';
import { useBaselineRead } from '../../data/baseline-read';
import { shortId } from '../../data/format';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { at, Button, useSend, type Send } from './parts';
import {
  baselineConfirmRequest,
  baselineDraft,
  baselineFolders,
  baselineStartRequest,
  type ProjectBaseline,
  type BaselineDraft,
} from './baseline';
import './baseline-interview.css';

/** Opens the project's baseline session that is finding gate commands, else starts one and opens it. */
export function FindGate({ project_id }: { project_id: string }) {
  const { read: baseline } = useBaselineRead(project_id);
  const send = useSend();
  const open = (id: string) => useShell.getState().openSession(id);
  const live =
    (baseline?.state === 'running' || baseline?.state === 'submitted') && baseline.session_id
      ? baseline.session_id
      : null;
  return (
    <>
      <button
        type="button"
        className="btn"
        aria-disabled={send.busy || undefined}
        aria-busy={send.busy || undefined}
        onClick={() => {
          if (send.busy) return;
          if (live) return open(live);
          void send.send(baselineStartRequest(project_id), (started) => {
            const id = (started as ProjectBaseline | null)?.session_id;
            if (id) open(id);
          });
        }}
      >
        {t({ id: 'projects.baseline.findGate', defaultMessage: 'Find gate commands' })}
      </button>
      <Result send={send} />
    </>
  );
}

/** What the daemon checks of a folder: its gate without the commands turned off. */
export const baselinePlanned = (baseline: ProjectBaseline): PlannedCommands =>
  (baseline.result?.folders ?? []).map((folder) => ({
    root: folder.root,
    commands: folder.gate
      .filter((gate) => gate.enabled !== false)
      .map(({ name, argv }) => ({ name, argv })),
  }));

export function ReviewBaseline({
  baseline,
  onOpenSession,
}: {
  baseline: ProjectBaseline;
  /** Opens the baseline's conversation; unset where the card already sits in it. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const [draft, setDraft] = useState(() => baselineDraft(baseline));
  const send = useSend();
  const edit = (patch: Partial<BaselineDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const folders = baselineFolders(baseline, draft);
  return (
    <>
      {folders.length > 0 && (
        <div
          className="hm-dirs"
          role="group"
          aria-label={t({ id: 'projects.baseline.gates', defaultMessage: 'Gate commands' })}
        >
          {folders.map((folder) => (
            <fieldset key={folder.root} className="hm-pick" aria-label={folder.root}>
              <div className="hm-dir">
                <PathText path={folder.root} className="mono" />
                {folder.setup && <span className="mu mono">{folder.setup}</span>}
              </div>
              <div className="hm-pis">
                {folder.gate.map((i) => {
                  const item = draft.gate[i]!;
                  return (
                    <label key={i} className="hm-pi">
                      <input
                        type="checkbox"
                        checked={item.checked}
                        onChange={(e) =>
                          edit({
                            gate: draft.gate.map((g, j) =>
                              j === i ? { ...g, checked: e.target.checked } : g,
                            ),
                          })
                        }
                      />
                      <span className="hm-line" title={item.command.name}>
                        {item.command.name}
                      </span>
                      <Clip text={item.command.argv.join(' ')} className="mu mono" />
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      {baseline.state === 'submitted' && (
        <div className="iv-pnl">
          <div className="iv-cell">
            <EnvironmentCheck
              project_id={baseline.project_id}
              baseline={baseline}
              onOpenSession={onOpenSession}
              planned={baselinePlanned(baseline)}
            />
          </div>
        </div>
      )}
      {baseline.dropped > 0 && (
        <span className="mu">
          {t(
            {
              id: 'projects.baseline.dropped',
              defaultMessage:
                '{count, plural, one {Dropped # command without a source} other {Dropped # commands without a source}}',
            },
            { count: baseline.dropped },
          )}
        </span>
      )}
      <Button
        label={t({ id: 'projects.baseline.confirmBaseline', defaultMessage: 'Confirm baseline' })}
        tone="pri"
        busy={send.busy}
        onPress={() => void send.send(baselineConfirmRequest(baseline, draft))}
      />
      <Result send={send} />
    </>
  );
}

export function Result({ send }: { send: Send }) {
  return (
    <>
      {send.error && (
        <div className="ps-err" role="alert">
          {send.error}
        </div>
      )}
      {send.receipt && !send.error && (
        <div className="mu hm-rc" role="status">
          {[
            t(
              { id: 'projects.receipt.recorded', defaultMessage: 'Recorded {command}' },
              { command: send.receipt.command },
            ),
            send.receipt.revision !== null && `rev ${send.receipt.revision}`,
            send.receipt.id && shortId(send.receipt.id),
            at(send.receipt.at),
          ]
            .filter(Boolean)
            .join(t({ id: 'projects.receipt.separator', defaultMessage: ', ' }))}
        </div>
      )}
    </>
  );
}
