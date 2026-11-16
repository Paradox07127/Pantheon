import { useEffect, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Select } from '../../components/Select';
import { setDiffPrefs, useDiffPrefs, type ChangesViewer } from '../../data/diff-prefs';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { EditorPicker } from './EditorPicker';
import { ipcFailure } from './editors';
import { Row, Section } from './ProjectSettingsScreen';

export function EditorPage() {
  const prefs = useDiffPrefs();
  const viewerLabel = t({
    id: 'settings.editor.changesViewer',
    defaultMessage: 'View changes with',
  });
  const terminalLabel = t({
    id: 'settings.editor.externalTerminal',
    defaultMessage: 'External terminal',
  });
  const browserLabel = t({
    id: 'settings.editor.externalBrowser',
    defaultMessage: 'External browser',
  });
  return (
    <>
      <Section title={t({ id: 'settings.editor.files', defaultMessage: 'Files' })}>
        <div className="ps-rows">
          <Row
            label={t({ id: 'settings.editor.openWith', defaultMessage: 'Open with' })}
            settingId="editor.editor"
          >
            <EditorPicker
              label={t({ id: 'settings.editor.editor', defaultMessage: 'Editor' })}
              ariaLabel={t({
                id: 'settings.editor.openFilesWith',
                defaultMessage: 'Open files with',
              })}
              list="editors"
              choose="chooseEditor"
              unavailable="editor_unavailable"
            />
          </Row>
        </div>
      </Section>
      <Section title={t({ id: 'settings.editor.terminal', defaultMessage: 'Terminal' })}>
        <div className="ps-rows">
          <Row label={terminalLabel} settingId="editor.terminal">
            <EditorPicker
              label={t({ id: 'settings.editor.terminal', defaultMessage: 'Terminal' })}
              ariaLabel={terminalLabel}
              list="terminals"
              choose="chooseTerminal"
              unavailable="terminal_unavailable"
            />
          </Row>
        </div>
      </Section>
      {window.pantheon && (
        <Section title={t({ id: 'settings.editor.browser', defaultMessage: 'Browser' })}>
          <div className="ps-rows">
            <Row label={browserLabel} settingId="editor.browser">
              <BrowserPicker label={browserLabel} />
            </Row>
          </div>
        </Section>
      )}
      <Section title={t({ id: 'settings.editor.changes', defaultMessage: 'Changes' })}>
        <div className="ps-rows">
          <Row
            label={t({ id: 'settings.editor.viewWith', defaultMessage: 'View with' })}
            settingId="editor.changes"
          >
            <RadioGroup<ChangesViewer>
              className="seg"
              aria-label={viewerLabel}
              value={prefs.changes_viewer}
              onValueChange={(changes_viewer) => setDiffPrefs({ changes_viewer })}
            >
              <Radio.Root value="app">
                {t({ id: 'settings.editor.inAppDiff', defaultMessage: 'In-app diff' })}
              </Radio.Root>
              <Radio.Root value="editor">
                {t({ id: 'settings.editor.editor', defaultMessage: 'Editor' })}
              </Radio.Root>
            </RadioGroup>
          </Row>
        </div>
      </Section>
    </>
  );
}

// The select's value for the system's own default browser; installed browsers have ids.
const SYSTEM = '';

/** The installed browsers that open links, after the system default. */
function BrowserPicker({ label }: { label: string }) {
  const [browsers, setBrowsers] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState(SYSTEM);
  const [error, setError] = useState<string | null>(null);
  // A choice made before the saved browser was read wins over that read.
  const chosen = useRef(false);
  useEffect(() => {
    const bridge = window.pantheon;
    if (!bridge) return;
    void Promise.resolve()
      .then(() => bridge.listBrowsers())
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setBrowsers(result.value);
        else setError(failureText(result.error));
      });
    void Promise.resolve()
      .then(() => bridge.chosenBrowser())
      .catch(ipcFailure)
      .then((result) => {
        if (chosen.current) return;
        if (result.ok) setSelected(result.value ?? SYSTEM);
        else setError(failureText(result.error));
      });
  }, []);
  const choose = (id: string) => {
    const bridge = window.pantheon;
    if (!bridge) return;
    chosen.current = true;
    setError(null);
    void bridge
      .chooseBrowser(id === SYSTEM ? null : id)
      .catch(ipcFailure)
      .then((result) => {
        if (result.ok) setSelected(id);
        else
          setError(
            t(
              {
                id: 'settings.editor.chooseFailed',
                defaultMessage: '{label}: could not choose ({message})',
              },
              { label, message: result.error.message },
            ),
          );
      });
  };
  return (
    <span className="tk-editor">
      <Select
        aria-label={label}
        value={selected}
        onChange={choose}
        options={[
          {
            value: SYSTEM,
            label: t({ id: 'settings.editor.systemBrowser', defaultMessage: 'System default' }),
          },
          ...browsers.map((b) => ({ value: b.id, label: b.name })),
        ]}
      />
      {error && (
        <span className="tk-err" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
