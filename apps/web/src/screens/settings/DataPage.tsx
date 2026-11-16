import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Folder } from 'lucide-react';
import { Skeleton } from '../../components/Skeleton';
import { exportPersonalSettings, importPersonalSettings } from '../../data/personal-settings';
import { t } from '../../i18n';
import { revealText } from '../../lib/platform-text';
import { ipcFailure } from './editors';
import { Row, Section } from './ProjectSettingsScreen';
import './data-page.css';

export function DataPage() {
  const [directory, setDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.pantheon
      ?.daemon()
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setDirectory(result.value.data_dir);
        else
          setError(
            t(
              {
                id: 'settings.data.readFailed',
                defaultMessage: 'Could not read the data folder: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  }, []);
  const reveal = (path: string) => {
    setError(null);
    void window.pantheon
      ?.revealPath(path)
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok)
          setError(
            t(
              {
                id: 'settings.data.revealFailed',
                defaultMessage: 'Could not show the folder: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  };
  const loading = window.pantheon !== undefined && directory === null && error === null;
  let path: ReactNode = null;
  if (!window.pantheon)
    path = (
      <span className="ps-row-hint">
        {t({
          id: 'settings.common.bridgeUnavailable',
          defaultMessage: 'Desktop bridge unavailable',
        })}
      </span>
    );
  else if (directory !== null) path = <span className="ps-row-hint dp-path">{directory}</span>;
  else if (loading) path = <Skeleton className="dp-path-sk" />;
  return (
    <>
      <div className="ps-grp">
        <div className="ps-rows">
          <div className="ps-row" data-setting-id="data.folder" aria-busy={loading || undefined}>
            <span className="ps-row-nm">
              {t({ id: 'settings.data.title', defaultMessage: 'Data folder' })}
              {path}
            </span>
            <div className="ps-row-ct">
              <button
                type="button"
                className="btn"
                disabled={directory === null}
                onClick={() => directory !== null && reveal(directory)}
              >
                <Folder size={14} aria-hidden="true" />
                {revealText()}
              </button>
            </div>
          </div>
          {error !== null && (
            <div className="ps-err dp-err" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
      <PersonalSettings />
      <Diagnostics />
    </>
  );
}

/** Saves the desktop app's log folder as one file the user picks; the browser has no log folder. */
function Diagnostics() {
  const [error, setError] = useState<string | null>(null);
  const exportLog = () => {
    setError(null);
    void window.pantheon
      ?.exportDiagnostics()
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok)
          setError(
            t(
              {
                id: 'settings.data.diagnosticsFailed',
                defaultMessage: 'Could not export the diagnostic log: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  };
  return (
    <Section title={t({ id: 'settings.data.diagnostics', defaultMessage: 'Diagnostics' })}>
      <div className="ps-rows">
        <Row
          label={t({
            id: 'settings.data.diagnosticsLog',
            defaultMessage: 'Export diagnostic log',
          })}
          settingId="data.diagnostics"
        >
          <button type="button" className="btn" disabled={!window.pantheon} onClick={exportLog}>
            {t({ id: 'settings.data.export', defaultMessage: 'Export…' })}
          </button>
        </Row>
        {error !== null && (
          <div className="ps-err dp-err" role="alert">
            {error}
          </div>
        )}
      </div>
    </Section>
  );
}

/** Saves the appearance, notification, shortcut and diff settings to a JSON file and reads them back. */
function PersonalSettings() {
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    setError(null);
    // The bridge has no save dialog; a download link gets the browser's, or Electron's.
    const url = URL.createObjectURL(
      new Blob([exportPersonalSettings()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pantheon-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url));
  };
  const open = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    // Choosing the same file again fires change again.
    input.value = '';
    if (!file) return;
    const text = await file.text().catch(() => '');
    setError(
      importPersonalSettings(text)
        ? null
        : t({
            id: 'settings.data.importInvalid',
            defaultMessage: 'Not a valid settings file; nothing was imported',
          }),
    );
  };
  return (
    <Section
      title={t({ id: 'settings.data.personal', defaultMessage: 'Personal settings' })}
      settingId="data.personal"
    >
      <div className="ps-rows">
        <Row
          label={t({ id: 'settings.data.exportRow', defaultMessage: 'Export' })}
          settingId="data.export"
        >
          <button type="button" className="btn" onClick={save}>
            {t({ id: 'settings.data.export', defaultMessage: 'Export…' })}
          </button>
        </Row>
        <Row
          label={t({ id: 'settings.data.importRow', defaultMessage: 'Import' })}
          settingId="data.import"
        >
          <button type="button" className="btn" onClick={() => picker.current?.click()}>
            {t({ id: 'settings.data.import', defaultMessage: 'Import…' })}
          </button>
          <input
            ref={picker}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => void open(e.target)}
          />
        </Row>
        {error !== null && (
          <div className="ps-err dp-err" role="alert">
            {error}
          </div>
        )}
      </div>
    </Section>
  );
}
