import { useId, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { BoardSnapshot } from '@pantheon/protocol';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import { LoadError } from '../../components/LoadError';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { failureText } from '../../data/needs-you';
import {
  removePlaybook,
  SECTIONS,
  setPlaybook,
  usePlaybook,
  type PlaybookRead,
  type PlaybookSections,
} from '../../data/playbooks';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { Section } from './ProjectSettingsScreen';
import { scrimFlag } from '../../lib/root-flag';
import './playbook-editor.css';

type Project = BoardSnapshot['projects'][number];
type SectionKey = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<SectionKey, string> = {
  get before_you_plan() {
    return t({ id: 'settings.playbook.section.beforeYouPlan', defaultMessage: 'Before you plan' });
  },
  get routing() {
    return t({ id: 'settings.playbook.section.routing', defaultMessage: 'Routing' });
  },
  get replies() {
    return t({ id: 'settings.playbook.section.replies', defaultMessage: 'Replies' });
  },
};

const versionText = (version: number) =>
  t({ id: 'settings.playbook.versionNumber', defaultMessage: 'v{version}' }, { version });

/** Text being edited, and the version it started from, which its save names as the base. */
interface Draft {
  sections: PlaybookSections;
  base: number;
}

/** The project's playbooks, the default one and each runtime's, edited and stored as versions. */
export function PlaybookEditor({ project }: { project: Project }) {
  const id = useId();
  const runtimes = offeredRuntimes(useRuntimeStatus().read, []);
  /** The runtime whose playbook is shown; empty for the default one. */
  const [choice, setChoice] = useState('');
  /** The earlier version shown read only. */
  const [viewing, setViewing] = useState<number | null>(null);
  /** Each choice's unsaved text, kept while another choice is shown. */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{ conflict: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const runtime = choice === '' ? null : choice;
  const current = usePlaybook({ project_id: project.id, runtime });
  const earlier = usePlaybook(
    viewing === null ? null : { project_id: project.id, runtime, version: viewing },
  );
  const read = current.read;
  const draft = drafts[choice];
  const shown = viewing === null ? (draft?.sections ?? read?.sections) : earlier.read?.sections;
  const changed = !!draft && !!read && SECTIONS.some((s) => draft.sections[s] !== read.sections[s]);
  const name = runtime && runtimeName(runtime);
  const title = t({ id: 'settings.playbook.title', defaultMessage: 'Playbook' });

  const readError = current.error ?? earlier.error;
  if (readError)
    return (
      <Section title={title}>
        <LoadError
          message={t(
            {
              id: 'settings.playbook.readFailed',
              defaultMessage: 'Couldn’t read the playbook: {error}',
            },
            { error: readError },
          )}
          onRetry={() => {
            current.reload();
            earlier.reload();
          }}
        />
      </Section>
    );

  const problems = SECTIONS.map((section) => {
    if (viewing !== null || !shown) return null;
    const text = shown[section];
    if (text.trim() === '')
      return t(
        { id: 'settings.playbook.empty', defaultMessage: '{section} can’t be empty.' },
        { section: SECTION_LABEL[section] },
      );
    const line = text.split('\n').findIndex((l) => l.startsWith('## '));
    if (line >= 0)
      return t(
        {
          id: 'settings.playbook.heading',
          defaultMessage:
            'Line {line} starts with “## ”. A section can’t hold a line that starts with “## ”.',
        },
        { line: line + 1 },
      );
    if (text.trim().length > 20000)
      return t(
        {
          id: 'settings.playbook.tooLong',
          defaultMessage: '{section} is longer than 20,000 characters.',
        },
        { section: SECTION_LABEL[section] },
      );
    return null;
  });

  const boxName = (section: SectionKey) => {
    const values = { runtime: name, version: viewing, section: SECTION_LABEL[section] };
    if (viewing !== null)
      return name === null
        ? t(
            {
              id: 'settings.playbook.box.defaultVersion',
              defaultMessage: 'Default playbook, version {version}: {section}',
            },
            values,
          )
        : t(
            {
              id: 'settings.playbook.box.runtimeVersion',
              defaultMessage: 'Playbook for {runtime}, version {version}: {section}',
            },
            values,
          );
    return name === null
      ? t(
          { id: 'settings.playbook.box.default', defaultMessage: 'Default playbook: {section}' },
          values,
        )
      : t(
          {
            id: 'settings.playbook.box.runtime',
            defaultMessage: 'Playbook for {runtime}: {section}',
          },
          values,
        );
  };

  const edit = (section: SectionKey, text: string) => {
    if (!read) return;
    setDrafts((all) => ({
      ...all,
      [choice]: {
        base: all[choice]?.base ?? read.version,
        sections: { ...(all[choice]?.sections ?? read.sections), [section]: text },
      },
    }));
  };
  const dropDraft = () => setDrafts(({ [choice]: _, ...rest }) => rest);

  const save = async (sections: PlaybookSections, base: number) => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    const result = await setPlaybook(project.id, runtime, base, sections);
    setSaving(false);
    if (!result.ok) {
      if (result.error.code === 'version_conflict') {
        setFailure({
          conflict: true,
          text: t({
            id: 'settings.playbook.conflict',
            defaultMessage:
              'Couldn’t save: this playbook changed since you opened it. Your text is kept.',
          }),
        });
        current.reload();
      } else
        setFailure({
          conflict: false,
          text: t(
            { id: 'settings.playbook.saveFailed', defaultMessage: 'Couldn’t save: {error}' },
            { error: failureText(result.error) },
          ),
        });
      return;
    }
    current.put(result.value as PlaybookRead);
    setViewing(null);
    dropDraft();
  };

  const own = runtime !== null && read && read.version > 0 ? { runtime, read } : null;
  const remove = async () => {
    if (!own || saving) return;
    setSaving(true);
    setRemoveError(null);
    const result = await removePlaybook(project.id, own.runtime, own.read.version);
    setSaving(false);
    if (!result.ok) {
      setRemoveError(
        t(
          { id: 'settings.playbook.removeFailed', defaultMessage: 'Couldn’t remove: {error}' },
          { error: failureText(result.error) },
        ),
      );
      return;
    }
    current.put(result.value as PlaybookRead);
    setConfirming(false);
    setViewing(null);
    dropDraft();
  };

  const sourceText =
    read &&
    (read.source === 'runtime'
      ? t(
          { id: 'settings.playbook.source.runtime', defaultMessage: '{runtime}’s own' },
          { runtime: name },
        )
      : read.source === 'default'
        ? t({ id: 'settings.playbook.source.default', defaultMessage: 'Project default' })
        : t({ id: 'settings.playbook.source.code', defaultMessage: 'Built in' }));

  const versionMenu = read && read.version > 0 && (
    <Menu.Root>
      <Menu.Trigger
        className="btn pbk-ver"
        aria-label={
          viewing === null
            ? t(
                {
                  id: 'settings.playbook.version',
                  defaultMessage: 'Playbook version, v{version} current',
                },
                { version: read.version },
              )
            : t(
                {
                  id: 'settings.playbook.versionShowing',
                  defaultMessage: 'Playbook version, showing v{shown} of {current}',
                },
                { shown: viewing, current: read.version },
              )
        }
      >
        <span className="mono">{versionText(viewing ?? read.version)}</span>
        <ChevronDown aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 60 }}>
          <Menu.Popup
            className="wmenu pjm pop"
            aria-label={t({
              id: 'settings.playbook.versions',
              defaultMessage: 'Playbook versions',
            })}
          >
            <Menu.RadioGroup value={String(viewing ?? read.version)}>
              {[...read.versions].reverse().map((v) => (
                <Menu.RadioItem
                  key={v}
                  value={String(v)}
                  closeOnClick
                  onClick={() => setViewing(v === read.version ? null : v)}
                >
                  <span className="pjm-ck">
                    <Menu.RadioItemIndicator>
                      <Check className="ic-sm" aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span className="mono">{versionText(v)}</span>
                  {v === read.version && (
                    <span className="pbk-cur">
                      {t({ id: 'settings.playbook.current', defaultMessage: 'Current' })}
                    </span>
                  )}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );

  const saveLabel = t({ id: 'settings.playbook.save', defaultMessage: 'Save as new version' });
  const actions =
    viewing !== null ? (
      <>
        <button
          type="button"
          className="btn pri"
          disabled={!read || !earlier.read || saving}
          aria-busy={saving || undefined}
          onClick={() => earlier.read && read && void save(earlier.read.sections, read.version)}
        >
          {saving && <RefreshCw className="si-spin" aria-hidden="true" />}
          {t(
            {
              id: 'settings.playbook.saveVersion',
              defaultMessage: 'Save v{version} as new version',
            },
            { version: viewing },
          )}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={saving}
          onClick={() => setViewing(null)}
        >
          {t(
            { id: 'settings.playbook.back', defaultMessage: 'Back to v{version}' },
            { version: read?.version ?? 0 },
          )}
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className="btn pri"
          disabled={!changed || problems.some(Boolean) || saving}
          aria-busy={saving || undefined}
          onClick={() => draft && void save(draft.sections, draft.base)}
        >
          {saving && <RefreshCw className="si-spin" aria-hidden="true" />}
          {saveLabel}
        </button>
        {changed && (
          <button type="button" className="btn ghost" disabled={saving} onClick={dropDraft}>
            {t({ id: 'settings.playbook.discard', defaultMessage: 'Discard changes' })}
          </button>
        )}
        {read && read.source !== 'code' && (
          <button
            type="button"
            className="btn ghost"
            disabled={saving}
            onClick={() =>
              setDrafts((all) => ({
                ...all,
                [choice]: { base: all[choice]?.base ?? read.version, sections: read.built_in },
              }))
            }
          >
            {t({ id: 'settings.playbook.reset', defaultMessage: 'Reset to built-in' })}
          </button>
        )}
      </>
    );

  return (
    <Section title={title}>
      <div className="ps-rows">
        <div className="pbk-hd">
          <RadioGroup<string>
            className="seg"
            aria-label={t({ id: 'settings.playbook.for', defaultMessage: 'Playbook for' })}
            value={choice}
            disabled={saving}
            onValueChange={(next) => {
              setChoice(next);
              setViewing(null);
              setFailure(null);
            }}
          >
            <Radio.Root value="">
              {t({ id: 'settings.playbook.default', defaultMessage: 'Default' })}
            </Radio.Root>
            {runtimes.map((r) => (
              <Radio.Root key={r} value={r} className="pbk-rt">
                <RuntimeGlyph runtime={r} />
                {runtimeName(r)}
              </Radio.Root>
            ))}
          </RadioGroup>
          <span className="pbk-end">
            {sourceText && <span>{sourceText}</span>}
            {versionMenu}
          </span>
        </div>
        <div className="pbk" aria-busy={!shown || undefined}>
          {SECTIONS.map((section, i) => (
            <div key={section} className="pbk-fld">
              <label htmlFor={`${id}-${section}`}>{SECTION_LABEL[section]}</label>
              <textarea
                id={`${id}-${section}`}
                className="pbk-ta"
                aria-label={boxName(section)}
                aria-invalid={problems[i] ? true : undefined}
                aria-describedby={problems[i] ? `${id}-${section}-err` : undefined}
                value={shown?.[section] ?? ''}
                disabled={!shown}
                readOnly={viewing !== null}
                onChange={(e) => edit(section, e.target.value)}
              />
              {problems[i] && (
                <span className="ps-err" id={`${id}-${section}-err`} role="alert">
                  {problems[i]}
                </span>
              )}
            </div>
          ))}
          {failure && (
            <div className="pbk-act">
              <span className="ps-err pbk-grow" role="alert">
                {failure.text}
              </span>
              {failure.conflict && read && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setDrafts((all) =>
                      all[choice]
                        ? { ...all, [choice]: { ...all[choice], base: read.version } }
                        : all,
                    );
                    setFailure(null);
                  }}
                >
                  {t(
                    { id: 'settings.playbook.load', defaultMessage: 'Load v{version}' },
                    { version: read.version },
                  )}
                </button>
              )}
            </div>
          )}
          <div className="pbk-act">
            {actions}
            {own && viewing === null && (
              <>
                <button
                  type="button"
                  className="btn ghost dng pbk-rm"
                  disabled={saving}
                  onClick={() => setConfirming(true)}
                >
                  {t({ id: 'settings.playbook.remove', defaultMessage: 'Remove' })}
                </button>
                <AlertDialog.Root
                  open={confirming}
                  onOpenChange={(next) => {
                    if (next || saving) return;
                    setRemoveError(null);
                    setConfirming(false);
                  }}
                >
                  <AlertDialog.Portal>
                    <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
                    <AlertDialog.Popup className="pj-dlg pj-rm pop">
                      <div className="pj-dh">
                        <AlertDialog.Title className="pj-dt">
                          {t(
                            {
                              id: 'settings.playbook.removeTitle',
                              defaultMessage: 'Remove {runtime}’s own playbook?',
                            },
                            { runtime: name },
                          )}
                        </AlertDialog.Title>
                      </div>
                      <AlertDialog.Description className="pj-rm-body">
                        {t(
                          {
                            id: 'settings.playbook.removeBody',
                            defaultMessage:
                              '{runtime}’s leads follow the project default again, and its stored versions are deleted. This cannot be undone.',
                          },
                          { runtime: name },
                        )}
                      </AlertDialog.Description>
                      {removeError && (
                        <div className="pj-err" role="alert">
                          <b>{removeError}</b>
                        </div>
                      )}
                      <div className="pj-df">
                        <span style={{ flex: 1 }} />
                        <AlertDialog.Close className="btn" disabled={saving}>
                          {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
                        </AlertDialog.Close>
                        <button
                          type="button"
                          className="btn dng"
                          disabled={saving}
                          aria-disabled={saving || undefined}
                          onClick={() => void remove()}
                        >
                          {t({ id: 'settings.playbook.remove', defaultMessage: 'Remove' })}
                        </button>
                      </div>
                    </AlertDialog.Popup>
                  </AlertDialog.Portal>
                </AlertDialog.Root>
              </>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}
