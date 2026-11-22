import { useEffect, useRef, useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ChevronDown } from 'lucide-react';
import type { RuntimeChoice } from '@pantheon/domain';
import type { BoardSnapshot, EffortLevel, WorkbenchSession } from '@pantheon/protocol';
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '../../components/Menu';
import { RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { clearGlobal, setGlobal, settingOf, useProjectDefaults } from '../../data/project-defaults';
import { visibleProjects } from '../../data/projects';
import { useRuntimeModels, type ModelsState } from '../../data/runtime-models';
import { offeredRuntimes, useRuntimeStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import {
  defaultModelFor,
  defaultPermissionMode,
  defaultRuntime,
  modelPermissionModes,
  permissionModeLabel,
} from '../sessions/model';
import { ModelMenu } from '../sessions/parts';
import { Overrides } from './Overrides';
import { failureText, Row, Section, type Failure } from './ProjectSettingsScreen';
import { registerPageHeader } from './settings-header';
import './defaults-page.css';

type Project = BoardSnapshot['projects'][number];
/** The new sessions' section or the review's. */
type Group = 'new' | 'review';
type Role = 'lead' | 'writer' | 'reviewer';

type Defaults = {
  runtime: string;
  permission_mode: WorkbenchSession['permission_mode'];
  /** null starts on the runtime's default model. */
  model: string | null;
  effort: EffortLevel | null;
  /** Tasks and reviews also run on this runtime, model and effort; only with a model. */
  single_model: boolean;
  /** null uses the new sessions' model; kept as saved, the page offers no choice for it. */
  writer: RuntimeChoice | null;
  /** null reviews on a runtime other than the writer's. */
  reviewer: RuntimeChoice | null;
  /** What a role switches to when its runtime is out of quota or unavailable; a role left out does not switch. */
  fallbacks: Partial<Record<Role, RuntimeChoice>>;
};

/** The header's projects with session defaults of their own. */
export function DefaultsOverrides() {
  const defaults = useProjectDefaults();
  const global = settingOf(defaults.data, 'session_defaults')?.global;
  return (
    <Overrides
      name={t({ id: 'settings.pages.defaults', defaultMessage: 'Default model' })}
      setting="session_defaults"
      valueText={(value) => listText(runtimeName(value.runtime), value.model)}
      clearGlobal={global ? () => clearGlobal('session_defaults') : undefined}
      editor={(project) => <SessionDefaults project={project} />}
    />
  );
}
registerPageHeader('defaults', { tools: DefaultsOverrides });

/** The reviewer while reviews run on the new sessions' model. */
function FollowedModel({ label }: { label: string }) {
  return (
    <button type="button" className="chip dp-chip" aria-label={label} disabled>
      {t({ id: 'settings.defaults.sameAsNew', defaultMessage: 'Same as new sessions' })}
      <ChevronDown aria-hidden="true" />
    </button>
  );
}

const choiceKey = (choice: RuntimeChoice) => `${choice.runtime}\n${choice.model ?? ''}`;

/** A role's model chip; its menu offers `none` first, then each model of each runtime given. */
function RoleModel({
  label,
  none,
  value,
  runtimes,
  models,
  onChange,
}: {
  label: string;
  /** The entry that sends no choice. */
  none: string;
  value: RuntimeChoice | null;
  runtimes: readonly string[];
  models: Readonly<Record<string, ModelsState>>;
  onChange: (next: RuntimeChoice | null) => void;
}) {
  // A runtime whose models are not read offers itself, on its default model.
  const options = runtimes.flatMap((runtime) => {
    const read = models[runtime];
    return read?.state === 'ready' && read.models.length > 0
      ? read.models.map((m) => ({ runtime, model: m.id as string | undefined, text: m.label }))
      : [{ runtime, model: undefined, text: runtimeName(runtime) }];
  });
  const shown =
    value &&
    (options.find((o) => choiceKey(o) === choiceKey(value))?.text ??
      value.model ??
      runtimeName(value.runtime));
  return (
    <Menu
      label={label}
      trigger={
        <button type="button" className="chip dp-chip" aria-label={label}>
          {value ? (
            <>
              <RuntimeGlyph runtime={value.runtime} />
              <span className="mono dp-cut">{shown}</span>
            </>
          ) : (
            <span className="dp-cut">{none}</span>
          )}
          <ChevronDown aria-hidden="true" />
        </button>
      }
    >
      <MenuRadioGroup
        value={value ? choiceKey(value) : ''}
        onChange={(key) => {
          const o = options.find((x) => choiceKey(x) === key);
          onChange(
            o ? { runtime: o.runtime, ...(o.model !== undefined && { model: o.model }) } : null,
          );
        }}
      >
        <MenuRadioItem value="">{none}</MenuRadioItem>
        <MenuSeparator />
        {options.map((o) => (
          <MenuRadioItem
            key={choiceKey(o)}
            value={choiceKey(o)}
            icon={<RuntimeGlyph runtime={o.runtime} />}
          >
            {o.text}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
}

/** What a new session starts on and what outside review runs on, in every project or with a project in it; every change saves at once. */
export function SessionDefaults({ project }: { project: Project | null }) {
  const { read, runtimes, unavailable, disconnected } = useRuntimeStatus('writer');
  const defaults = useProjectDefaults();
  // Models are listed in a project's folder, and every project lists the same ones.
  const listedIn = useBoard((s) =>
    project ? project.id : (visibleProjects(s.board?.projects ?? [])[0]?.id ?? null),
  );
  // The choice shown until the board has it; one made while a save is on its way waits here.
  const [draft, setDraft] = useState<Defaults | null>(null);
  // A failed save shows under the group whose control made the last change.
  const [failure, setFailure] = useState<{ at: Group; failure: Failure } | null>(null);
  const changedIn = useRef<Group>('new');
  const sending = useRef(false);
  // A global save is in once a read lands after it.
  const [savedAt, setSavedAt] = useState<{ revision: number; at: number; sent: Defaults } | null>(
    null,
  );

  const global = settingOf(defaults.data, 'session_defaults')?.global;
  const saved = project ? (project.session_defaults ?? global) : global;
  const runtime =
    draft?.runtime ?? saved?.runtime ?? defaultRuntime(runtimes, undefined, unavailable);
  const offered = offeredRuntimes(read, [runtime]);
  const models = useRuntimeModels(listedIn, offered);
  const model = draft ? draft.model : (saved?.model ?? null);
  const listed = models[runtime];
  // The modes of the new sessions' model, or of the runtime's default model without a listed one.
  const modes = modelPermissionModes(
    runtime,
    listed?.state === 'ready' ? defaultModelFor(listed.models, model ?? undefined) : null,
  );
  const preferred = draft?.permission_mode ?? saved?.permission_mode;
  const current: Defaults = {
    runtime,
    permission_mode:
      preferred !== undefined && modes.includes(preferred)
        ? preferred
        : defaultPermissionMode(runtime, preferred),
    model,
    effort: draft ? draft.effort : (saved?.effort ?? null),
    single_model: draft ? draft.single_model : saved?.single_model === true,
    writer: draft ? draft.writer : (saved?.writer ?? null),
    reviewer: draft ? draft.reviewer : (saved?.reviewer ?? null),
    fallbacks: draft ? draft.fallbacks : (saved?.fallbacks ?? {}),
  };
  const usable = runtimes.filter((r) => unavailable[r] === undefined);

  const send = async (next: Defaults) => {
    sending.current = true;
    const value = {
      runtime: next.runtime,
      permission_mode: next.permission_mode,
      ...(next.model !== null && { model: next.model }),
      ...(next.effort !== null && { effort: next.effort }),
      ...(next.single_model && { single_model: true }),
      ...(next.writer && { writer: next.writer }),
      ...(next.reviewer && { reviewer: next.reviewer }),
      ...(Object.keys(next.fallbacks).length > 0 && { fallbacks: next.fallbacks }),
    };
    const result = project
      ? await runCommand(
          'project.sessionDefaults.set',
          { project_id: project.id, ...value },
          project.revision,
        )
      : await setGlobal('session_defaults', value);
    sending.current = false;
    setFailure(result.ok ? null : { at: changedIn.current, failure: result.error });
    if (result.ok)
      setSavedAt({
        revision: project ? ((result.value as Project).revision ?? project.revision + 1) : 0,
        at: Date.now(),
        sent: next,
      });
    else setDraft(null);
  };

  useEffect(() => {
    if (!savedAt) return;
    if (project ? project.revision < savedAt.revision : (defaults.readAt ?? 0) <= savedAt.at)
      return;
    setSavedAt(null);
    if (draft === savedAt.sent) setDraft(null);
    else if (draft) void send(draft);
  }, [project?.revision, defaults.readAt, savedAt]);

  const change = (next: Defaults, at: Group) => {
    changedIn.current = at;
    setDraft(next);
    if (!sending.current && !savedAt) void send(next);
  };

  const newSessions = t({ id: 'settings.defaults.newSessions', defaultMessage: 'New sessions' });
  const reviewer = t({ id: 'settings.defaults.reviewer', defaultMessage: 'Outside review' });
  const modelLabel = t({ id: 'settings.defaults.model', defaultMessage: 'Model' });
  const fallbackLabel = t({ id: 'settings.defaults.fallback', defaultMessage: 'If unavailable' });
  const fallback = (role: Role, name: string, at: Group) => (
    <RoleModel
      label={t(
        { id: 'settings.defaults.fallbackOf', defaultMessage: '{role} if unavailable' },
        { role: name },
      )}
      none={t({ id: 'settings.defaults.noFallback', defaultMessage: "Don't switch" })}
      value={current.fallbacks[role] ?? null}
      runtimes={usable}
      models={models}
      onChange={(next) => {
        const { [role]: _, ...rest } = current.fallbacks;
        change({ ...current, fallbacks: next ? { ...rest, [role]: next } : rest }, at);
      }}
    />
  );
  const reviewerModel = t(
    { id: 'settings.defaults.roleModel', defaultMessage: "{role}'s model" },
    { role: reviewer },
  );
  const singleModelLabel = t({
    id: 'settings.defaults.sameModelForReviews',
    defaultMessage: "Reviews also use the new sessions' model",
  });
  const permissionLabel = t({
    id: 'settings.defaults.permissionMode',
    defaultMessage: 'Permission mode',
  });
  const error = (at: Group) =>
    failure?.at === at && (
      <div className="ps-err" role="alert">
        {failureText(failure.failure)}
      </div>
    );
  return (
    <div className="dp">
      <Section title={newSessions} settingId="defaults.runtime">
        <div className="ps-rows">
          <Row label={modelLabel} settingId="defaults.model">
            <span className="dp-lead">
              <ModelMenu
                runtimes={offered}
                unavailable={unavailable}
                disconnected={disconnected}
                models={models}
                value={{
                  runtime: current.runtime,
                  backend: null,
                  model: current.model,
                  effort: current.effort,
                }}
                onChange={(next) =>
                  change(
                    {
                      ...current,
                      runtime: next.runtime,
                      permission_mode: defaultPermissionMode(next.runtime, current.permission_mode),
                      model: next.model,
                      effort: next.effort,
                      single_model: current.single_model && next.model !== null,
                    },
                    'new',
                  )
                }
              />
            </span>
          </Row>
          <Row label={permissionLabel} settingId="defaults.permissionMode">
            <RadioGroup<Defaults['permission_mode']>
              className="seg"
              aria-label={permissionLabel}
              value={current.permission_mode}
              onValueChange={(m) => change({ ...current, permission_mode: m }, 'new')}
            >
              {modes.map((m) => (
                <Radio.Root key={m} value={m}>
                  {permissionModeLabel(current.runtime, m)}
                </Radio.Root>
              ))}
            </RadioGroup>
          </Row>
          <Row label={fallbackLabel} settingId="defaults.fallback">
            {fallback('lead', newSessions, 'new')}
          </Row>
        </div>
      </Section>
      {error('new')}
      {read.state === 'failed' && <span className="ps-why">{read.text}</span>}
      <Section title={reviewer}>
        <div className="ps-rows">
          <Row label={modelLabel} settingId="defaults.reviewer">
            {current.single_model ? (
              <FollowedModel label={reviewerModel} />
            ) : (
              <RoleModel
                label={reviewerModel}
                none={t({
                  id: 'settings.defaults.otherRuntime',
                  defaultMessage: "A runtime other than the writer's",
                })}
                value={current.reviewer}
                runtimes={usable}
                models={models}
                onChange={(next) => change({ ...current, reviewer: next }, 'review')}
              />
            )}
          </Row>
          <Row label={fallbackLabel} settingId="defaults.reviewerFallback">
            {fallback('reviewer', reviewer, 'review')}
          </Row>
          <Row label={singleModelLabel} settingId="defaults.singleModel">
            <input
              type="checkbox"
              className="ps-sw"
              checked={current.single_model}
              disabled={current.model === null}
              aria-label={singleModelLabel}
              onChange={(e) => change({ ...current, single_model: e.target.checked }, 'review')}
            />
          </Row>
        </div>
      </Section>
      {error('review')}
    </div>
  );
}
