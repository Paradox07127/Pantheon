import { useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Folders, X } from 'lucide-react';
import type { BoardSnapshot, BridgeResult, ProjectSettingValues } from '@pantheon/protocol';
import { Select } from '../../components/Select';
import { useBoard } from '../../data/board';
import {
  clearOverride,
  noteSettingWrite,
  settingOf,
  useProjectDefaults,
  type ProjectSettingKey,
} from '../../data/project-defaults';
import { visibleProjects } from '../../data/projects';
import { t } from '../../i18n';
import { failureText, type Failure } from './ProjectSettingsScreen';
import { scrimFlag } from '../../lib/root-flag';
import './overrides.css';

type Project = BoardSnapshot['projects'][number];

/** The row-end button of a setting every project follows, with the count of projects that set their own; it opens the projects' values. */
export function Overrides<K extends ProjectSettingKey>(props: {
  /** The setting's name. */
  name: string;
  setting: K;
  /** Whether a project's own value sets this row; every own value does when absent. */
  sets?: (value: ProjectSettingValues[K]) => boolean;
  valueText: (value: ProjectSettingValues[K]) => string;
  /** Clears one project's value of this row; its whole own value when absent. */
  clear?: (project: Project) => Promise<BridgeResult<unknown>>;
  /** Clears the global value of this row; absent while there is none or nothing to fall back to. */
  clearGlobal?: () => Promise<BridgeResult<unknown>>;
  /** The control that sets the chosen project's own value. */
  editor: (project: Project) => ReactNode;
}) {
  const read = useProjectDefaults();
  const board = useBoard((s) => s.board);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const projects = visibleProjects(board?.projects ?? []);
  const overrides = (settingOf(read.data, props.setting)?.overrides ?? []).filter(
    (o) => props.sets?.(o.value as ProjectSettingValues[K]) ?? true,
  );
  const own = new Set(overrides.map((o) => o.project_id));
  const picked =
    projects.find((p) => p.id === chosen) ?? projects.find((p) => !own.has(p.id)) ?? projects[0];

  const run = async (command: () => Promise<BridgeResult<unknown>>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await command();
    noteSettingWrite();
    setBusy(false);
    if (!result.ok) setFailure(result.error);
  };

  const label = t(
    {
      id: 'settings.overrides.open',
      defaultMessage:
        '{count, plural, =0 {Projects with their own {setting}} one {# project sets its own {setting}} other {# projects set their own {setting}}}',
    },
    { count: overrides.length, setting: props.name },
  );
  return (
    <>
      <button
        type="button"
        className="po-btn"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Folders aria-hidden="true" />
        {overrides.length > 0 && <span className="po-n">{overrides.length}</span>}
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          setFailure(null);
          setOpen(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <Dialog.Popup className="pj-dlg pop po-dlg">
            <div className="pj-dh">
              <Dialog.Title className="pj-dt">{props.name}</Dialog.Title>
              <span style={{ flex: 1 }} />
              <Dialog.Close
                className="ib"
                aria-label={t({ id: 'settings.overrides.close', defaultMessage: 'Close' })}
              >
                <X aria-hidden="true" />
              </Dialog.Close>
            </div>
            <div className="po-bd">
              {failure && (
                <div className="ps-err" role="alert">
                  {failureText(failure)}
                </div>
              )}
              {overrides.length > 0 && (
                <div
                  className="po-list"
                  role="list"
                  aria-label={t({
                    id: 'settings.overrides.list',
                    defaultMessage: 'Projects with their own value',
                  })}
                >
                  {overrides.map((o) => {
                    const project = projects.find((p) => p.id === o.project_id);
                    const value = props.valueText(o.value as ProjectSettingValues[K]);
                    return (
                      <div key={o.project_id} className="po-row" role="listitem">
                        <span className="po-nm">{o.name}</span>
                        <span className="po-val" title={value}>
                          {value}
                        </span>
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy || !project}
                          aria-label={t(
                            {
                              id: 'settings.overrides.clearNamed',
                              defaultMessage: "Clear {project}'s own value",
                            },
                            { project: o.name },
                          )}
                          onClick={() =>
                            project &&
                            void run(() =>
                              props.clear
                                ? props.clear(project)
                                : clearOverride(project, props.setting),
                            )
                          }
                        >
                          {t({ id: 'settings.overrides.clear', defaultMessage: 'Clear' })}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {picked && (
                <div
                  className="po-set"
                  role="group"
                  aria-label={t(
                    {
                      id: 'settings.overrides.setFor',
                      defaultMessage: "{project}'s own value",
                    },
                    { project: picked.name },
                  )}
                >
                  <Select
                    aria-label={t({ id: 'settings.overrides.project', defaultMessage: 'Project' })}
                    value={picked.id}
                    options={projects.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={setChosen}
                  />
                  <div key={picked.id} className="po-ed">
                    {props.editor(picked)}
                  </div>
                </div>
              )}
            </div>
            {props.clearGlobal && (
              <div className="pj-df">
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void run(props.clearGlobal!)}
                >
                  {t({
                    id: 'settings.overrides.restoreDefault',
                    defaultMessage: 'Restore the default',
                  })}
                </button>
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
