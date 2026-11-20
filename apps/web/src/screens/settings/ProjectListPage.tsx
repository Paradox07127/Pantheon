import { useState } from 'react';
import { LoadError } from '../../components/LoadError';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { BoardSnapshot, ProjectSettingValues } from '@pantheon/protocol';
import { runtimeName } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import {
  clearOverride,
  useProjectDefaults,
  type ProjectSettingKey,
} from '../../data/project-defaults';
import { visibleProjects } from '../../data/projects';
import { PARAM_LABEL } from '../../data/workflow-policy';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { ExtensionsPage } from './ExtensionsPage';
import { MODE_LABEL } from './ExternalPage';
import { ProjectGate } from './GatesPage';
import {
  failureText,
  Loading,
  ProjectEnvironment,
  RemoveProject,
  Row,
  Section,
  type Failure,
} from './ProjectSettingsScreen';
import { allProjects } from './SettingsNav';
import { UsagePage } from './UsagePage';
import { useSettingsView } from './view';
import { PlaybookEditor } from './PlaybookEditor';
import { onOff, WorkflowPage } from './WorkflowPage';
import { WorktreesPage } from './WorktreesPage';

type Project = BoardSnapshot['projects'][number];

const SETTING_NAME: Record<ProjectSettingKey, () => string> = {
  workflow_policy: () => t({ id: 'settings.pages.workflow', defaultMessage: 'Workflow' }),
  session_defaults: () => t({ id: 'settings.pages.defaults', defaultMessage: 'Default model' }),
  usage_targets: () => t({ id: 'settings.usage.targets', defaultMessage: 'Token targets' }),
  external_events: () => t({ id: 'settings.pages.external', defaultMessage: 'External requests' }),
  auto_merge: () =>
    t({ id: 'settings.autoMerge.toggle', defaultMessage: 'Merge automatically once gates pass' }),
};

/** What a project sets itself for one setting, in a few words. */
function ownText(key: ProjectSettingKey, value: ProjectSettingValues[ProjectSettingKey]): string {
  if (key === 'workflow_policy')
    return listText(
      ...Object.keys(value as object).map((param) =>
        param in PARAM_LABEL ? PARAM_LABEL[param as keyof typeof PARAM_LABEL] : param,
      ),
    );
  if (key === 'session_defaults') {
    const defaults = value as ProjectSettingValues['session_defaults'];
    return listText(runtimeName(defaults.runtime), defaults.model);
  }
  if (key === 'usage_targets')
    return listText(
      ...Object.entries(value as ProjectSettingValues['usage_targets']).map(
        ([runtime, target]) => `${runtimeName(runtime)} ${target}`,
      ),
    );
  if (key === 'external_events')
    return MODE_LABEL[value as ProjectSettingValues['external_events']]();
  return onOff(value as boolean);
}

export const ownCount = (count: number) =>
  t(
    {
      id: 'settings.projectList.ownCount',
      defaultMessage: '{count, plural, one {# own value} other {# own values}}',
    },
    { count },
  );

/** Every project with how many settings it sets itself; a project opens its own page. */
export function ProjectListPage() {
  const detail = useSettingsView((s) => s.detail);
  const setDetail = useSettingsView((s) => s.setDetail);
  const board = useBoard((s) => s.board);
  const read = useProjectDefaults();
  const project = detail
    ? visibleProjects(board?.projects ?? []).find((p) => p.id === detail)
    : undefined;
  if (project) return <ProjectDetail key={project.id} project={project} />;
  if (!read.data)
    return read.error !== null ? (
      <div className="ps-grp">
        <LoadError message={read.error} onRetry={read.reload} />
      </div>
    ) : (
      <Loading />
    );
  return (
    <div className="ps-grp">
      <div
        className="ps-rows"
        role="list"
        aria-label={t({ id: 'settings.pages.projects', defaultMessage: 'Projects' })}
      >
        {read.data.projects.map((p) => (
          <div key={p.project_id} role="listitem" className="pl-it">
            <button type="button" className="pl-row" onClick={() => setDetail(p.project_id)}>
              <span className="pl-nm">{p.name}</span>
              {p.overridden > 0 && <span className="pl-n">{ownCount(p.overridden)}</span>}
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One project's own page: the settings it sets itself, then its gates, worktrees, question defaults, playbook, budget, extensions and environment. */
function ProjectDetail({ project }: { project: Project }) {
  const read = useProjectDefaults();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const own = (read.data?.settings ?? []).flatMap((setting) => {
    const found = setting.overrides.find((o) => o.project_id === project.id);
    return found ? [{ key: setting.key, value: found.value }] : [];
  });

  const clear = async (key: ProjectSettingKey) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await clearOverride(project, key);
    setBusy(false);
    if (!result.ok) setFailure(result.error);
  };

  return (
    <div className="pl-pg">
      <div className="pl-top">
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => useSettingsView.getState().setDetail(null)}
        >
          <ChevronLeft aria-hidden="true" />
          {allProjects()}
        </button>
      </div>
      {own.length > 0 && (
        <Section title={t({ id: 'settings.projectList.own', defaultMessage: 'Own values' })}>
          <div className="ps-rows">
            {own.map(({ key, value }) => (
              <Row key={key} label={SETTING_NAME[key]()}>
                <span className="pl-val">{ownText(key, value)}</span>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  aria-label={t(
                    {
                      id: 'settings.projectList.clearNamed',
                      defaultMessage: 'Clear own value: {setting}',
                    },
                    { setting: SETTING_NAME[key]() },
                  )}
                  onClick={() => void clear(key)}
                >
                  {t({ id: 'settings.overrides.clear', defaultMessage: 'Clear' })}
                </button>
              </Row>
            ))}
          </div>
          {failure && (
            <div className="ps-err" role="alert">
              {failureText(failure)}
            </div>
          )}
        </Section>
      )}
      <div className="ps-pane">
        <ProjectGate project={project} />
      </div>
      <WorktreesPage project={project} />
      <Section>
        <WorkflowPage project={project} only="question_defaults" />
      </Section>
      <PlaybookEditor project={project} />
      <Section>
        <UsagePage project={project} only="project_budget" />
      </Section>
      <ExtensionsPage project={project} />
      <ProjectEnvironment project={project} />
      <RemoveProject project={project} />
    </div>
  );
}
