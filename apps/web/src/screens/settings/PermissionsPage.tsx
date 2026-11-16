import { useRef, useState } from 'react';
import { LoadError } from '../../components/LoadError';
import { Dialog } from '@base-ui/react/dialog';
import { Check, ShieldCheck, X } from 'lucide-react';
import type { BoardSnapshot, BridgeResult, ProjectPermissionRule } from '@pantheon/protocol';
import { EmptyState } from '../../components/EmptyState';
import { RuntimeGlyph } from '../../components/RuntimeGlyph';
import { Select } from '../../components/Select';
import { useBoard } from '../../data/board';
import { useCurrentProject } from '../../data/current-project';
import { removePermissionRule, usePermissionRules } from '../../data/permission-rules';
import { addGlobalRule, removeGlobalRule, useProjectDefaults } from '../../data/project-defaults';
import { visibleProjects } from '../../data/projects';
import { sessionTitle } from '../../data/transcript';
import { t } from '../../i18n';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import { failureText, Loading, type Failure } from './ProjectSettingsScreen';
import { useSettingsView } from './view';
import './permissions-page.css';

type Project = BoardSnapshot['projects'][number];

const removeLabel = (rule: string) =>
  t({ id: 'settings.permissions.removeRule', defaultMessage: 'Remove rule {rule}' }, { rule });

function openWaiting(projectId: string) {
  useSettingsView.getState().close();
  useCurrentProject.getState().choose(projectId);
  useShell.getState().openSessionGroup('inbox');
}

/** The session a rule came from: a link while it is open, muted once it ended or is gone. */
function ruleSource(project: Project, entry: ProjectPermissionRule, board: BoardSnapshot | null) {
  const session = board?.sessions.find((s) => s.id === entry.session_id);
  const title = session
    ? sessionTitle(session, board!)
    : (entry.session_title ??
      t({ id: 'settings.permissions.sessionGone', defaultMessage: 'Deleted session' }));
  const inner = [
    session && <RuntimeGlyph key="glyph" runtime={session.runtime} size={14} />,
    <span key="title" className="pm-cut">
      {title}
    </span>,
  ];
  if (!session || session.state === 'closed') return <span className="pm-src mu">{inner}</span>;
  return (
    <button
      type="button"
      className="pm-src"
      onClick={() => {
        useSettingsView.getState().close();
        useShell.getState().openProjectSession(project.id, session.id);
      }}
    >
      {inner}
    </button>
  );
}

/** The rules that allow matching requests in every project, and a look at each project's own. */
export function GlobalPermissions() {
  const defaults = useProjectDefaults();
  const board = useBoard((s) => s.board);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [viewing, setViewing] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const rules = defaults.data?.permission_rules ?? null;
  const projects = visibleProjects(board?.projects ?? []);
  const picked = projects.find((p) => p.id === chosen) ?? projects[0];
  const newRule = t({ id: 'settings.permissions.newRule', defaultMessage: 'New rule' });
  const projectRules = t({
    id: 'settings.permissions.projectRules',
    defaultMessage: "Each project's rules",
  });

  const run = async (command: () => Promise<BridgeResult<unknown>>) => {
    if (busy) return false;
    setBusy(true);
    setFailure(null);
    const result = await command();
    setBusy(false);
    if (!result.ok) setFailure(result.error);
    return result.ok;
  };
  const add = async () => {
    const rule = draft.trim();
    if (rule && (await run(() => addGlobalRule(rule)))) setDraft('');
  };

  const now = Date.now();
  return (
    <div className="pm-pg" data-setting-id="permissions.rules">
      {rules === null ? (
        defaults.error !== null ? (
          <LoadError message={defaults.error} onRetry={defaults.reload} />
        ) : (
          <Loading />
        )
      ) : (
        <div className="ps-grp">
          {rules.length > 0 && (
            <div
              role="list"
              aria-label={t({
                id: 'settings.permissions.rules',
                defaultMessage: 'Always-allowed rules',
              })}
            >
              {rules.map((entry) => (
                <div key={entry.rule} className="pm-row pm-gl" role="listitem">
                  <span className="mono pm-rule" title={entry.rule}>
                    {entry.rule}
                  </span>
                  <span className="mu pm-at">{dayText(entry.added_at, now, { time: true })}</span>
                  <button
                    type="button"
                    className="ib"
                    disabled={busy}
                    aria-label={removeLabel(entry.rule)}
                    onClick={() => void run(() => removeGlobalRule(entry.rule))}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pm-row pm-gl pm-new">
            <input
              className="inp mono"
              spellCheck={false}
              aria-label={newRule}
              placeholder={newRule}
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <span />
            <button
              type="button"
              className="btn sm"
              disabled={busy || !draft.trim()}
              onClick={() => void add()}
            >
              {t({ id: 'settings.permissions.add', defaultMessage: 'Add' })}
            </button>
          </div>
        </div>
      )}
      {failure && (
        <div className="ps-err" role="alert">
          {failureText(failure)}
        </div>
      )}
      {picked && (
        <div className="pm-more">
          <button type="button" className="btn" onClick={() => setViewing(true)}>
            {projectRules}
          </button>
        </div>
      )}
      <Dialog.Root open={viewing} onOpenChange={(next) => setViewing(next)}>
        <Dialog.Portal>
          <Dialog.Backdrop className="pj-scrim" />
          <Dialog.Popup className="pj-dlg pop">
            <div className="pj-dh">
              <Dialog.Title className="pj-dt">{projectRules}</Dialog.Title>
              <span style={{ flex: 1 }} />
              {picked && (
                <Select
                  aria-label={t({ id: 'settings.permissions.project', defaultMessage: 'Project' })}
                  value={picked.id}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                  onChange={setChosen}
                />
              )}
            </div>
            <div className="pm-dlg-bd">
              {picked && <PermissionsPage key={picked.id} project={picked} readOnly />}
            </div>
            <div className="pj-df">
              <Dialog.Close className="btn ghost">
                {t({ id: 'settings.permissions.close', defaultMessage: 'Close' })}
              </Dialog.Close>
              {picked && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setViewing(false);
                    useSettingsView.setState({ page: 'projects', detail: picked.id });
                  }}
                >
                  {t({ id: 'settings.permissions.openProject', defaultMessage: 'Open project' })}
                </button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** The rules the project always allows, each chosen on an approval card, with a delete per rule unless read only. */
export function PermissionsPage({ project, readOnly }: { project: Project; readOnly?: boolean }) {
  const rules = usePermissionRules(project);
  const board = useBoard((s) => s.board);
  // The rule waiting for the delete to be confirmed.
  const [asked, setAsked] = useState<string | null>(null);
  // The closing dialog keeps naming the rule it asked about.
  const named = useRef('');
  if (asked !== null) named.current = asked;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const allowProject = t({
    id: 'sessions.card.allowProject',
    defaultMessage: 'Always allow for this project',
  });

  const remove = async () => {
    if (busy || asked === null) return;
    setBusy(true);
    setFailure(null);
    const result = await removePermissionRule(project.id, asked);
    setBusy(false);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    setAsked(null);
    rules.reload();
  };

  const now = Date.now();
  const body =
    rules.data === null ? (
      rules.error !== null ? (
        <LoadError message={rules.error} onRetry={rules.reload} />
      ) : (
        <Loading />
      )
    ) : rules.data.length === 0 ? (
      <EmptyState
        graphic={<ShieldCheck aria-hidden="true" />}
        title={t({
          id: 'settings.permissions.empty',
          defaultMessage: 'This project has no always-allowed rules yet',
        })}
        action={{
          icon: <Check aria-hidden="true" size={14} />,
          label: t({
            id: 'settings.permissions.goWaiting',
            defaultMessage: 'Go to sessions waiting for your approval',
          }),
          onClick: () => openWaiting(project.id),
        }}
      />
    ) : (
      <>
        <div className="pm-top">
          <span className="cap">
            {t({ id: 'settings.permissions.chosenOn', defaultMessage: 'Chosen on approval cards' })}
          </span>
          <span className="chip">{allowProject}</span>
          <span className="mu pm-n">
            {t(
              {
                id: 'settings.permissions.count',
                defaultMessage: '{count, plural, one {# rule} other {# rules}}',
              },
              { count: rules.data.length },
            )}
          </span>
        </div>
        <div
          className="ps-grp"
          role="list"
          aria-label={t({
            id: 'settings.permissions.rules',
            defaultMessage: 'Always-allowed rules',
          })}
        >
          <div className="pm-row pm-hd">
            <span className="cap">
              {t({ id: 'settings.permissions.rule', defaultMessage: 'Rule' })}
            </span>
            <span className="cap">
              {t({ id: 'settings.permissions.fromSession', defaultMessage: 'From session' })}
            </span>
            <span className="cap">
              {t({ id: 'settings.permissions.added', defaultMessage: 'Added' })}
            </span>
            <span />
          </div>
          {rules.data.map((entry) => (
            <div key={entry.rule} className="pm-row" role="listitem">
              <span className="mono pm-rule" title={entry.rule}>
                {entry.rule}
              </span>
              {ruleSource(project, entry, board)}
              <span className="mu pm-at">{dayText(entry.added_at, now, { time: true })}</span>
              {readOnly ? (
                <span />
              ) : (
                <button
                  type="button"
                  className="ib"
                  aria-label={removeLabel(entry.rule)}
                  onClick={() => {
                    setFailure(null);
                    setAsked(entry.rule);
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      </>
    );

  return (
    <div className="pm-pg" data-setting-id="permissions.rules">
      {body}
      <Dialog.Root
        open={asked !== null}
        onOpenChange={(next) => {
          if (next || busy) return;
          setFailure(null);
          setAsked(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="pj-scrim" />
          <Dialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <Dialog.Title className="pj-dt">{removeLabel(named.current)}</Dialog.Title>
            </div>
            <Dialog.Description className="pj-rm-body">
              {t({
                id: 'settings.permissions.removeBody',
                defaultMessage:
                  'Requests this rule lets through will wait for your approval again, in every session of this project.',
              })}
            </Dialog.Description>
            {failure && (
              <div className="pj-err" role="alert">
                <b>{failureText(failure)}</b>
              </div>
            )}
            <div className="pj-df">
              <span style={{ flex: 1 }} />
              <Dialog.Close className="btn ghost">
                {t({ id: 'settings.permissions.cancel', defaultMessage: 'Cancel' })}
              </Dialog.Close>
              <button
                type="button"
                className="btn dng"
                disabled={busy}
                aria-disabled={busy || undefined}
                onClick={() => void remove()}
              >
                {t({ id: 'settings.permissions.remove', defaultMessage: 'Remove' })}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
