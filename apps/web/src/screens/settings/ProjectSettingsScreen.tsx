import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { BoardSnapshot } from '@pantheon/protocol';
import { Skeleton } from '../../components/Skeleton';
import { ShortcutSettings } from '../../components/Shortcuts';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useCurrentProject } from '../../data/current-project';
import { removeProject, removeRejectText, visibleProjects } from '../../data/projects';
import { t } from '../../i18n';
import { AboutPage } from './AboutPage';
import { AppearancePage } from './AppearancePage';
import { CategoryHeader } from './CategoryHeader';
import { ConnectionsPage } from './ConnectionsPage';
import { DataPage } from './DataPage';
import { DevicesPage } from './DevicesPage';
import { DiffPage } from './DiffPage';
import { EditorPage } from './EditorPage';
import { FolderFields, VariableFields } from '../projects/EnvironmentFields';
import { GeneralPage } from './GeneralPage';
import {
  checkEnvironment,
  draftOf,
  environmentSetRequest,
  sameEnvironment,
  type EnvironmentDraft,
} from '../projects/environment';
import { HarnessPage } from './HarnessPage';
import { NotificationsPage } from './NotificationsPage';
import { GlobalPermissions } from './PermissionsPage';
import { ProjectListPage } from './ProjectListPage';
import { SearchResults } from './SearchResults';
import { SessionDefaults } from './SessionDefaultsPage';
import { SessionDisplayPage } from './SessionDisplayPage';
import { pageHeader } from './settings-header';
import { SettingsNav } from './SettingsNav';
import { navPage, SETTINGS_PAGES, useSettingsView, type SettingsPage } from './view';
import { scrimFlag } from '../../lib/root-flag';
import './settings-frame.css';

type Project = BoardSnapshot['projects'][number];
export type Failure = { code: string; message: string };

export const failureText = (failure: Failure) =>
  t({ id: 'settings.common.failure', defaultMessage: '{code}: {message}' }, failure);
export const saveLabel = (busy: boolean) =>
  busy
    ? t({ id: 'settings.common.saving', defaultMessage: 'Saving…' })
    : t({ id: 'settings.common.save', defaultMessage: 'Save' });
export const noChanges = () => t({ id: 'settings.common.noChanges', defaultMessage: 'No changes' });
export const runtimeLabel = () => t({ id: 'settings.common.runtime', defaultMessage: 'Runtime' });

/** One section of the settings column: a caption, unless untitled, over a frame with an optional footer. */
export function Section(props: {
  title?: string;
  meta?: string;
  /** A control at the end of the header. */
  action?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** The search index's id for the setting this section holds. */
  settingId?: string;
}) {
  return (
    <section className="ps-sec" aria-label={props.title}>
      {props.title !== undefined && (
        <div className="ps-sec-hd" data-setting-id={props.settingId}>
          <h3>{props.title}</h3>
          {props.meta !== undefined && <span className="mu">{props.meta}</span>}
          {props.action !== undefined && (
            <>
              <span style={{ flex: 1 }} />
              {props.action}
            </>
          )}
        </div>
      )}
      <div className="ps-grp">
        <div className="ps-sec-bd">{props.children}</div>
        {props.footer !== undefined && <div className="ps-sec-ft">{props.footer}</div>}
      </div>
    </section>
  );
}

export const Loading = () => (
  <div aria-busy="true" className="ps-sk">
    <Skeleton style={{ height: 9, width: 180 }} />
    <Skeleton style={{ height: 9, width: 120 }} />
  </div>
);

/** The settings: this computer's pages, the pages every project follows, and the projects page; the same whichever project is current. */
export function ProjectSettingsScreen() {
  const chosen = useSettingsView((s) => s.page);
  const query = useSettingsView((s) => s.query);
  const detail = useSettingsView((s) => s.detail);
  const detailName = useBoard((s) => s.board?.projects.find((p) => p.id === detail)?.name);
  const page = navPage(chosen);
  const { tools: Tools } = pageHeader(page);
  const group = SETTINGS_PAGES.find((p) => p.key === page)?.group;
  return (
    <>
      <SettingsNav page={page} />
      <main className="ps-main" aria-label={SETTINGS_PAGES.find((p) => p.key === page)?.label}>
        <CategoryHeader
          page={page}
          scope={page === 'projects' ? detailName : undefined}
          end={Tools && <Tools />}
        />
        <div className="ps-cg">
          <SearchResults />
          {/* Hidden, not unmounted, while searching, so unsaved drafts survive. */}
          <div className="ps-pane" hidden={query !== ''}>
            {group === 'app' ? <AppPage page={page} /> : <GlobalPage page={page} />}
            {/* The projects page stays mounted while hidden so a page switch keeps a project's unsaved drafts. */}
            <div hidden={page !== 'projects'}>
              <ProjectListPage />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

/** The pages of the settings every project follows unless it sets its own. */
function GlobalPage({ page }: { page: SettingsPage }) {
  if (page === 'defaults') return <SessionDefaults project={null} />;
  if (page === 'permissions') return <GlobalPermissions />;
  return null;
}

/** The pages of this computer; any other page shows the theme. */
function AppPage({ page }: { page: SettingsPage }) {
  // Runtime models are listed in a project's folder, and every project lists the same ones.
  const listedIn = useBoard((s) => visibleProjects(s.board?.projects ?? [])[0]?.id ?? null);
  if (page === 'general') return <GeneralPage />;
  if (page === 'sessionDisplay') return <SessionDisplayPage />;
  if (page === 'connections') return <ConnectionsPage />;
  if (page === 'editor') return <EditorPage />;
  if (page === 'diff') return <DiffPage />;
  if (page === 'notifications') return <NotificationsPage />;
  if (page === 'harness') return <HarnessPage projectId={listedIn} />;
  if (page === 'devices') return <DevicesPage />;
  if (page === 'shortcuts') return <ShortcutSettings />;
  if (page === 'data') return <DataPage />;
  if (page === 'about') return <AboutPage />;
  return <AppearancePage />;
}

/** One setting of a group: its name and hint, then its control at the end of the row. */
export function Row({
  label,
  hint,
  children,
  settingId,
}: {
  label: string;
  /** One sentence under the name. */
  hint?: string;
  children: ReactNode;
  /** The search index's id for this setting. */
  settingId?: string;
}) {
  return (
    <div className="ps-row" data-setting-id={settingId}>
      <span className="ps-row-nm">
        {label}
        {hint !== undefined && <span className="ps-row-hint">{hint}</span>}
      </span>
      <div className="ps-row-ct">{children}</div>
    </div>
  );
}

export function ProjectEnvironment({ project }: { project: Project }) {
  // from: the project revision the rows were numbered at; draftOf numbers them afresh.
  const [edit, setEdit] = useState<{
    name: string;
    draft: EnvironmentDraft;
    from: number;
  } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  // Keep the submitted edit until the board catches up; edits made meanwhile stay drafts.
  const [savedAt, setSavedAt] = useState<{ revision: number; edit: typeof edit } | null>(null);

  useEffect(() => {
    if (!savedAt || project.revision < savedAt.revision) return;
    setEdit((e) => (e === savedAt.edit ? null : e));
    setSavedAt(null);
  }, [project.revision, savedAt]);

  const current = edit ?? { name: project.name, draft: draftOf(project), from: project.revision };
  const name = current.name.trim();
  const { environment } = checkEnvironment(current.draft);
  const busy = saving || savedAt !== null;
  const ready =
    !busy && !!name && environment !== null && !sameEnvironment(project, name, environment);

  const save = async () => {
    if (sending.current || savedAt || !ready || !environment) return;
    sending.current = true;
    setSaving(true);
    const request = environmentSetRequest(project, name, environment);
    const result = await runCommand(request.type, request.input, request.expected_revision);
    sending.current = false;
    setSaving(false);
    setFailure(result.ok ? null : result.error);
    if (result.ok)
      setSavedAt({
        revision: (result.value as Project).revision ?? request.expected_revision + 1,
        edit,
      });
  };

  return (
    <Section
      title={t({ id: 'settings.environment.title', defaultMessage: 'Environment' })}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn pri"
            disabled={!ready}
            aria-disabled={!ready}
            onClick={ready ? () => void save() : undefined}
          >
            {saveLabel(busy)}
          </button>
        </>
      }
    >
      {failure && (
        <div className="ps-err" role="alert">
          {failureText(failure)}
        </div>
      )}
      <div className="ev">
        <label className="pj-lb" htmlFor="ps-env-name">
          {t({ id: 'settings.environment.name', defaultMessage: 'Project name' })}
        </label>
        <span className="pj-inp" data-setting-id="project.name">
          <input
            id="ps-env-name"
            disabled={busy}
            value={current.name}
            onChange={(e) => setEdit({ ...current, name: e.target.value })}
          />
        </span>
        <div data-setting-id="project.folders">
          <FolderFields
            value={current.draft.roots}
            onChange={(roots) => setEdit({ ...current, draft: { ...current.draft, roots } })}
            disabled={busy}
          />
        </div>
        <div data-setting-id="project.variables">
          {/* Row ids name other rows once renumbered, so values shown before stay hidden. */}
          <VariableFields
            key={current.from}
            value={current.draft.env}
            onChange={(env) => setEdit({ ...current, draft: { ...current.draft, env } })}
            disabled={busy}
          />
        </div>
      </div>
    </Section>
  );
}

/** Removes the project from Pantheon once confirmed, then closes the settings; its folders stay on disk. */
export function RemoveProject({ project }: { project: Project }) {
  const close = useSettingsView((s) => s.close);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = t({ id: 'settings.general.remove', defaultMessage: 'Remove project' });

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await removeProject(project);
    setBusy(false);
    if (!result.ok) {
      setError(removeRejectText(result.error));
      return;
    }
    if (useCurrentProject.getState().projectId === project.id) useCurrentProject.getState().clear();
    setOpen(false);
    close();
  };

  return (
    <div className="ps-end" data-setting-id="project.remove">
      <button type="button" className="btn dng" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (next) return;
          setError(null);
          setOpen(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <Dialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <Dialog.Title className="pj-dt">
                {t(
                  { id: 'projects.remove.title', defaultMessage: 'Remove “{name}”' },
                  { name: project.name },
                )}
              </Dialog.Title>
            </div>
            <Dialog.Description className="pj-rm-body">
              {t({
                id: 'settings.general.removeBody',
                defaultMessage:
                  'Pantheon stops listing the project; its folders and files on disk stay as they are.',
              })}
            </Dialog.Description>
            {error && (
              <div className="pj-err" role="alert">
                <b>{error}</b>
              </div>
            )}
            <div className="pj-df">
              <span style={{ flex: 1 }} />
              <Dialog.Close className="btn ghost">
                {t({ id: 'projects.cancel', defaultMessage: 'Cancel' })}
              </Dialog.Close>
              <button
                type="button"
                className="btn dng"
                disabled={busy}
                aria-disabled={busy || undefined}
                onClick={() => void remove()}
              >
                {t({ id: 'projects.remove.confirm', defaultMessage: 'Remove' })}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
