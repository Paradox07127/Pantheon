import { useEffect, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  CheckIcon,
  ChevronDown,
  ChevronRight,
  Plus,
  TriangleAlert,
  Workflow,
  Zap,
} from 'lucide-react';
import {
  type BackendSummary,
  type EffortLevel,
  type RuntimeModel,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { ModelMark, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { KeyHint } from '../../components/Shortcuts';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import { type ModelsState } from '../../data/runtime-models';
import { t } from '../../i18n';
import { fastModeText } from '../../lib/daemon-text';
import { listText } from '../../lib/list-text';
import { shortcutKeys, useShortcut } from '../../lib/shortcuts';
import { useShell } from '../../store';
import { useSettingsView } from '../settings/view';
import {
  defaultModel,
  EFFORT_LABEL,
  modelPermissionModes,
  modelText,
  permissionModeLabel,
} from './model';
import { modelLabel, runningModel } from './thread-model';
import './model-menu.css';

export interface ModelChoice {
  runtime: string;
  /** The configured backend; null sends to the runtime's own endpoint. */
  backend: string | null;
  /** null runs the runtime's default model. */
  model: string | null;
  effort: EffortLevel | null;
}

type PermissionMode = WorkbenchSession['permission_mode'];
type FastMode = NonNullable<WorkbenchSession['fast_mode']>;

const LOADING: ModelsState = { state: 'loading' };
const NO_RUNTIMES: readonly string[] = [];
const listOf = (read: ModelsState | undefined): RuntimeModel[] =>
  read?.state === 'ready' ? read.models : [];

// Numbers of one or two digits joined by dots or dashes, between dashes or underscores.
const VERSION = /(^|[-_])(\d{1,2}(?:[.-]\d{1,2})*)(?=$|[-_])/;
// A release date after the version: -20250805 or -2025-08-07.
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The family and version of a model id, as claude-opus-# and [4, 5]; null for an id without one. */
function familyVersion(id: string): { family: string; version: number[] } | null {
  const bare = id.replace(DATED, '');
  const found = VERSION.exec(bare);
  if (!found) return null;
  const at = found.index + found[1]!.length;
  return {
    family: `${bare.slice(0, at)}#${bare.slice(at + found[2]!.length)}`,
    version: found[2]!.split(/[.-]/).map(Number),
  };
}

function newer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const by = (a[i] ?? 0) - (b[i] ?? 0);
    if (by !== 0) return by > 0;
  }
  return false;
}

/** The ids a newer version of the same family in the list replaces: claude-opus-4-1 beside claude-opus-4-5. */
export function supersededModels(ids: readonly string[]): Set<string> {
  const parsed = ids.flatMap((id) => {
    const found = familyVersion(id);
    return found ? [{ id, ...found }] : [];
  });
  return new Set(
    parsed
      .filter((a) => parsed.some((b) => b.family === a.family && newer(b.version, a.version)))
      .map((a) => a.id),
  );
}

/** A row that shows or hides the rows after it. */
function fold(label: string, count: number, open: boolean, onToggle: () => void) {
  return (
    <Menu.Item className="cp-mi" closeOnClick={false} aria-expanded={open} onClick={onToggle}>
      {open ? (
        <ChevronDown className="cp-mic" aria-hidden="true" />
      ) : (
        <ChevronRight className="cp-mic" aria-hidden="true" />
      )}
      <span className="cp-mil">{label}</span>
      <span className="cp-mmn">{count}</span>
    </Menu.Item>
  );
}

function Check() {
  return (
    <Menu.RadioItemIndicator className="cp-ck">
      <CheckIcon aria-hidden="true" />
    </Menu.RadioItemIndicator>
  );
}

/** Opens the settings on the page that connects providers. */
function addProvider() {
  useSettingsView.getState().setPage('connections');
  useShell.getState().openSettings(null);
}

/** One button for the runtime, model, effort and permission mode; the model-menu keys open it. */
export function ModelMenu({
  runtimes,
  models,
  value,
  onChange,
  mode = null,
  onMode = () => {},
  disabled = false,
  unavailable = {},
  disconnected = NO_RUNTIMES,
  backends = [],
  backendLocked,
  keys = true,
  inSession = false,
  fast = null,
  onFast = () => {},
  ultracode = null,
  onUltracode = () => {},
  reported = null,
}: {
  runtimes: readonly string[];
  models: Readonly<Record<string, ModelsState>>;
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  /** null offers no permission mode: the session's is not known, or the caller sets it elsewhere. */
  mode?: PermissionMode | null;
  onMode?: (mode: PermissionMode) => void;
  disabled?: boolean;
  /** Why a runtime cannot start a session, by runtime. */
  unavailable?: Readonly<Record<string, string>>;
  /** The unavailable runtimes that are not set up to run at all; they fold away under the others. */
  disconnected?: readonly string[];
  backends?: readonly BackendSummary[];
  /** Why the session cannot leave its backend; every other backend row is off. */
  backendLocked?: string;
  /** Whether the model-menu keys open it. */
  keys?: boolean;
  /** Whether it changes the model of a running session. */
  inSession?: boolean;
  /** null offers no fast mode switch. */
  fast?: FastMode | null;
  /** May answer with why the switch was refused; null when it was not. */
  onFast?: (on: boolean) => void | Promise<string | null>;
  /** Whether ultracode is on; null offers no ultracode switch. Only Claude shows it. */
  ultracode?: boolean | null;
  /** May answer with why the switch was refused; null when it was not. */
  onUltracode?: (on: boolean) => void | Promise<string | null>;
  /** The model the runtime reported for the session; null when none is known. */
  reported?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [fastError, setFastError] = useState<string | null>(null);
  const [ultracodeError, setUltracodeError] = useState<string | null>(null);
  const [foldedShown, setFoldedShown] = useState(false);
  useShortcut(
    'model-menu',
    () => {
      if (!disabled) setOpen((now) => !now);
    },
    keys,
  );
  // Escape closes the menu alone: taken before a dialog or the composer under it hears the key.
  useEffect(() => {
    if (!open || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, disabled]);
  const usable = backends.filter((b) => b.runtimes.includes(value.runtime));
  const backend = usable.find((b) => b.id === value.backend) ?? null;
  const read: ModelsState = backend?.models.length
    ? {
        state: 'ready',
        models: backend.models.map((id) => ({
          id,
          label: id,
          efforts: [],
          default_effort: null,
          default: false,
          permission_modes: [],
        })),
      }
    : (models[value.runtime] ?? LOADING);
  const listed = listOf(read);
  const current = listed.find((m) => m.id === value.model || m.resolved === value.model) ?? null;
  // A session without a listed model runs on the default one, and takes its modes and fast mode.
  const running = current ?? defaultModel(listed);
  const older = supersededModels(listed.map((m) => m.id));
  const top = listed.filter((m) => m === running || !older.has(m.id));
  const versionOf = (m: RuntimeModel) => familyVersion(m.id)?.version ?? [];
  const more = listed
    .filter((m) => !top.includes(m))
    .sort((a, b) =>
      newer(versionOf(a), versionOf(b)) ? -1 : newer(versionOf(b), versionOf(a)) ? 1 : 0,
    );
  const folded = runtimes.filter(
    (r) => r !== value.runtime && unavailable[r] !== undefined && disconnected.includes(r),
  );
  const modes =
    mode === null
      ? []
      : modelPermissionModes(value.runtime, running).map((m) => ({
          value: m,
          label: permissionModeLabel(value.runtime, m),
        }));
  const modeLabel = modes.find((m) => m.value === mode)?.label ?? null;
  const fastShown = fast !== null && running?.fast === true;
  const fastState =
    fast?.on && fast.state !== undefined && fast.state !== 'on'
      ? fastModeText(fast.state, fast.reason)
      : null;
  const fastLabel = t({ id: 'sessions.composer.fastMode', defaultMessage: 'Fast mode' });
  const ultracodeShown = ultracode !== null && value.runtime === 'claude';
  const ultracodeLabel = t({ id: 'sessions.composer.ultracode', defaultMessage: 'Ultracode' });
  const runs = runningModel(listed, value.model, value.effort, reported);
  const effort = runs.effort ? EFFORT_LABEL[runs.effort] : null;
  const efforts = current?.efforts ?? [];
  const effortLabel = t({ id: 'sessions.composer.effort', defaultMessage: 'Reasoning effort' });
  const modeGroupLabel = t({
    id: 'sessions.composer.permissionMode',
    defaultMessage: 'Permission mode',
  });
  const switchBackend = (next: BackendSummary | null) => {
    const to = { ...value, backend: next?.id ?? null };
    if (next?.models.length)
      return onChange(
        value.model !== null && next.models.includes(value.model)
          ? to
          : { ...to, model: next.models[0]!, effort: null },
      );
    // A model only the left backend serves gives way to the runtime's default.
    const own = listOf(models[value.runtime]);
    const preset =
      value.model !== null && !own.some((m) => m.id === value.model || m.resolved === value.model)
        ? defaultModel(own)
        : null;
    onChange(preset ? { ...to, model: preset.id, effort: preset.default_effort } : to);
  };
  const choose = (runtime: string, next: RuntimeModel | null) =>
    onChange({
      runtime,
      backend: value.backend,
      model: next?.id ?? null,
      effort: !next
        ? null
        : value.effort && next.efforts.includes(value.effort)
          ? value.effort
          : next.default_effort,
    });
  const runtimeRow = (runtime: string) => {
    const why = unavailable[runtime];
    const own = models[runtime];
    const item = (
      <Menu.RadioItem
        key={runtime}
        className="cp-mi"
        value={runtime}
        closeOnClick={false}
        disabled={why !== undefined}
        onClick={() => {
          const preset = defaultModel(listOf(models[runtime]));
          onChange({
            runtime,
            backend: null,
            model: preset?.id ?? null,
            effort: preset?.default_effort ?? null,
          });
        }}
      >
        <RuntimeGlyph runtime={runtime} />
        <span className="cp-mil">{runtimeName(runtime)}</span>
        {why !== undefined
          ? !folded.includes(runtime) && <span className="cp-mmn">{why}</span>
          : own?.state === 'ready' && <span className="cp-mmn">{own.models.length}</span>}
      </Menu.RadioItem>
    );
    return why === undefined ? (
      item
    ) : (
      <Tip key={runtime} content={why}>
        {item}
      </Tip>
    );
  };
  const modelRow = (m: RuntimeModel) => {
    const item = (
      <Menu.RadioItem
        key={m.id}
        className="cp-mi cp-mdr"
        value={m.id}
        closeOnClick
        onClick={() => choose(value.runtime, m)}
      >
        <ModelMark model={m.resolved ?? m.id} />
        <span className="cp-mil">{modelLabel(m, listed)}</span>
        {m.description && <span className="cp-mmd">{m.description}</span>}
        <Check />
      </Menu.RadioItem>
    );
    return m.description ? (
      <Tip key={m.id} content={m.description}>
        {item}
      </Tip>
    ) : (
      item
    );
  };

  return (
    <Menu.Root
      open={open && !disabled}
      onOpenChange={(next) => {
        if (next) {
          setFastError(null);
          setUltracodeError(null);
          setFoldedShown(false);
        }
        setOpen(next);
      }}
      disabled={disabled}
    >
      <Menu.Trigger
        className="cp-mdl"
        aria-label={t(
          { id: 'sessions.composer.modelSummary', defaultMessage: 'Model: {summary}' },
          {
            summary: listText(
              modelText(
                value.runtime,
                listed,
                value.model,
                value.effort,
                backend?.id ?? null,
                reported,
              ),
              modeLabel,
            ),
          },
        )}
        aria-keyshortcuts={shortcutKeys('model-menu') || undefined}
      >
        <RuntimeGlyph runtime={value.runtime} />
        <span className="cp-mdn">{runs.name}</span>
        {backend && <span className="cp-mdx mono">{backend.id}</span>}
        {effort && <span className="cp-mdx">{effort}</span>}
        {modeLabel && <span className="cp-mdx">{modeLabel}</span>}
        <ChevronDown className="cp-mdx" aria-hidden="true" />
        {keys && <KeyHint id="model-menu" />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={4} style={{ zIndex: 40 }}>
          <Menu.Popup
            className="pop cp-mm"
            style={{ maxHeight: 'min(480px, var(--available-height))' }}
          >
            <div className="cp-mml">
              <Menu.RadioGroup
                value={value.runtime}
                aria-label={t({ id: 'sessions.composer.runtime', defaultMessage: 'Runtime' })}
              >
                {runtimes.filter((r) => !folded.includes(r)).map(runtimeRow)}
                {folded.length > 0 &&
                  fold(
                    t({
                      id: 'sessions.composer.runtimeNotConnected',
                      defaultMessage: 'Not connected',
                    }),
                    folded.length,
                    foldedShown,
                    () => setFoldedShown((now) => !now),
                  )}
                {foldedShown && folded.map(runtimeRow)}
              </Menu.RadioGroup>
              <Menu.Separator className="cp-sep" />
              <Menu.Item className="cp-mi" onClick={addProvider}>
                <Plus className="cp-mic" aria-hidden="true" />
                <span className="cp-mil">
                  {t({ id: 'sessions.composer.addProvider', defaultMessage: 'Add provider' })}
                </span>
              </Menu.Item>
            </div>
            <div className="cp-mmr">
              <div className="cp-mmt">
                {usable.length > 0 && (
                  <>
                    <Menu.RadioGroup
                      value={backend?.id ?? ''}
                      aria-label={t({ id: 'sessions.composer.backend', defaultMessage: 'Backend' })}
                    >
                      <Menu.RadioItem
                        className="cp-mi"
                        value=""
                        closeOnClick={false}
                        disabled={backendLocked !== undefined && backend !== null}
                        onClick={() => switchBackend(null)}
                      >
                        <span className="cp-mil">
                          {t(
                            {
                              id: 'sessions.composer.runtimeEndpoint',
                              defaultMessage: '{runtime} default',
                            },
                            { runtime: runtimeName(value.runtime) },
                          )}
                        </span>
                        <Check />
                      </Menu.RadioItem>
                      {usable.map((b) => {
                        const why =
                          backendLocked !== undefined && b.id !== backend?.id
                            ? backendLocked
                            : b.key_present === false && 'env' in b.key
                              ? t(
                                  {
                                    id: 'sessions.composer.backendKeyMissing',
                                    defaultMessage: '{env} is not set',
                                  },
                                  { env: b.key.env },
                                )
                              : undefined;
                        const item = (
                          <Menu.RadioItem
                            key={b.id}
                            className="cp-mi"
                            value={b.id}
                            closeOnClick={false}
                            disabled={why !== undefined}
                            onClick={() => switchBackend(b)}
                          >
                            <span className="cp-mil mono">{b.id}</span>
                            <Check />
                          </Menu.RadioItem>
                        );
                        return why === undefined ? (
                          item
                        ) : (
                          <Tip key={b.id} content={why}>
                            {item}
                          </Tip>
                        );
                      })}
                    </Menu.RadioGroup>
                    <Menu.Separator className="cp-sep" />
                  </>
                )}
                <Menu.Group
                  className="cp-mdg"
                  aria-label={t({ id: 'sessions.composer.model', defaultMessage: 'Model' })}
                >
                  {read.state === 'loading' && (
                    <Skeleton style={{ height: 10, width: '70%', margin: '6px 8px' }} />
                  )}
                  <Menu.RadioGroup className="cp-mdt" value={current?.id ?? value.model ?? ''}>
                    {/* Shown only while it is the choice: a session on a model cannot go back to the default. */}
                    {read.state === 'failed' && value.model === null && (
                      <Menu.RadioItem
                        className="cp-mi"
                        value=""
                        closeOnClick
                        onClick={() => choose(value.runtime, null)}
                      >
                        <span className="cp-mil">
                          {t({ id: 'sessions.composer.defaultModel', defaultMessage: 'Default' })}
                        </span>
                        <Check />
                      </Menu.RadioItem>
                    )}
                    {top.map(modelRow)}
                  </Menu.RadioGroup>
                  {more.length > 0 && (
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger className="cp-mi">
                        <span className="cp-mil">
                          {t({ id: 'sessions.composer.moreModels', defaultMessage: 'More models' })}
                        </span>
                        <ChevronRight className="cp-mic" aria-hidden="true" />
                      </Menu.SubmenuTrigger>
                      <Menu.Portal>
                        <Menu.Positioner sideOffset={4} style={{ zIndex: 40 }}>
                          <Menu.Popup
                            className="pop cp-am cp-mmo"
                            style={{ maxHeight: 'min(480px, var(--available-height))' }}
                          >
                            <Menu.RadioGroup
                              className="cp-mdt"
                              value={current?.id ?? value.model ?? ''}
                            >
                              {more.map(modelRow)}
                            </Menu.RadioGroup>
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  )}
                  {read.state === 'failed' && <span className="tr-why cp-mdw">{read.text}</span>}
                </Menu.Group>
              </div>
              {(efforts.length > 0 || modes.length > 0 || fastShown || ultracodeShown) && (
                <div className="cp-mmb">
                  {efforts.length > 0 && (
                    <Menu.Group className="cp-mmg" aria-label={effortLabel}>
                      <span className="cp-cap" aria-hidden="true">
                        {effortLabel}
                      </span>
                      <Menu.RadioGroup className="cp-seg" value={value.effort}>
                        {efforts.map((level) => (
                          <Menu.RadioItem
                            key={level}
                            className="cp-sgi"
                            value={level}
                            closeOnClick={false}
                            onClick={() => onChange({ ...value, effort: level })}
                          >
                            {EFFORT_LABEL[level]}
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                    </Menu.Group>
                  )}
                  {modes.length > 0 && (
                    <Menu.Group className="cp-mmg" aria-label={modeGroupLabel}>
                      <span className="cp-cap" aria-hidden="true">
                        {modeGroupLabel}
                      </span>
                      <Menu.RadioGroup
                        className="cp-seg"
                        value={mode}
                        aria-keyshortcuts={shortcutKeys('permission-mode') || undefined}
                      >
                        {modes.map((m) => (
                          <Menu.RadioItem
                            key={m.value}
                            className="cp-sgi"
                            value={m.value}
                            closeOnClick={false}
                            onClick={() => onMode(m.value)}
                          >
                            {m.label}
                          </Menu.RadioItem>
                        ))}
                      </Menu.RadioGroup>
                    </Menu.Group>
                  )}
                  {fastShown && (
                    <div className="cp-mmg">
                      <Menu.CheckboxItem
                        className="cp-mi cp-fast"
                        checked={fast.on}
                        closeOnClick={false}
                        aria-label={fastLabel}
                        onCheckedChange={(on) => {
                          const answer = onFast(on);
                          if (answer) void answer.then(setFastError);
                        }}
                      >
                        <Zap aria-hidden="true" />
                        <span className="cp-mil">{fastLabel}</span>
                        <span className="cp-mmn">
                          {t({
                            id: 'sessions.composer.fastModeBilling',
                            defaultMessage: 'Billed by usage',
                          })}
                        </span>
                        <span className="ps-sw" aria-hidden="true" />
                      </Menu.CheckboxItem>
                      {fastState !== null && <span className="cp-mms">{fastState}</span>}
                      {fastError !== null && (
                        <span className="tr-err" role="alert">
                          {fastError}
                        </span>
                      )}
                    </div>
                  )}
                  {ultracodeShown && (
                    <div className="cp-mmg">
                      <Menu.CheckboxItem
                        className="cp-mi cp-fast"
                        checked={ultracode}
                        closeOnClick={false}
                        aria-label={ultracodeLabel}
                        onCheckedChange={(on) => {
                          const answer = onUltracode(on);
                          if (answer) void answer.then(setUltracodeError);
                        }}
                      >
                        <Workflow aria-hidden="true" />
                        <span className="cp-mil">{ultracodeLabel}</span>
                        <span className="ps-sw" aria-hidden="true" />
                      </Menu.CheckboxItem>
                      {ultracodeError !== null && (
                        <span className="tr-err" role="alert">
                          {ultracodeError}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
              {modes.length === 1 && (
                <div className="cp-mmf">
                  <TriangleAlert aria-hidden="true" />
                  <span>
                    {t({
                      id: 'sessions.composer.onePermissionMode',
                      defaultMessage: 'This connection reports one permission mode',
                    })}
                  </span>
                </div>
              )}
              {inSession && (
                <div className="cp-mmf">
                  <CheckIcon aria-hidden="true" />
                  <span>
                    {t({
                      id: 'sessions.composer.sameProviderKeepsContext',
                      defaultMessage: 'Switching models within a provider keeps the context',
                    })}
                  </span>
                </div>
              )}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
