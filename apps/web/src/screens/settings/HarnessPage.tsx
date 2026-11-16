import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import type {
  BackendSummary,
  BridgeResult,
  DesktopBridge,
  RuntimeStatus,
} from '@pantheon/protocol';
import {
  compareRuntimes,
  ModelMark,
  RuntimeGlyph,
  runtimeName,
} from '../../components/RuntimeGlyph';
import { useBackends } from '../../data/backends';
import { runCommand } from '../../data/commands';
import { ageText, failureText, useNow } from '../../data/needs-you';
import { useRuntimeModels, type ModelsState } from '../../data/runtime-models';
import {
  sessionKinds,
  unavailableReason,
  useRuntimeStatus,
  versionNumber,
  type SessionKind,
} from '../../data/runtime-status';
import { t } from '../../i18n';
import { ipcFailure } from './editors';
import { Loading, Row, Section } from './ProjectSettingsScreen';
import { registerPageHeader } from './settings-header';
import { openBoardTab } from './settings-jump';
import { EmptyState } from '../../components/EmptyState';
import './harness-page.css';

type LoginRuntime = Parameters<DesktopBridge['runtimeLogin']>[0];
export const loginRuntime = (runtime: string): runtime is LoginRuntime =>
  runtime === 'claude' || runtime === 'codex';

/** Runs the runtime's own login through the desktop app. */
export const logIn = async (runtime: LoginRuntime): Promise<BridgeResult<void>> =>
  window.pantheon
    ? await window.pantheon.runtimeLogin(runtime).catch(ipcFailure)
    : { ok: false, error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' } };

/** The mounted page's check, and whether one it ran has not answered yet. */
const useRecheck = create<{ run: (() => void) | null; busy: boolean }>(() => ({
  run: null,
  busy: false,
}));

function RecheckTool() {
  const busy = useRecheck((s) => s.busy);
  return (
    <button
      type="button"
      className="btn ghost sm"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => useRecheck.getState().run?.()}
    >
      <RefreshCw size={14} aria-hidden="true" />
      {busy
        ? t({ id: 'settings.harness.checking', defaultMessage: 'Checking' })
        : t({ id: 'settings.harness.recheck', defaultMessage: 'Check again' })}
    </button>
  );
}

registerPageHeader('harness', { tools: RecheckTool });

function models(state: ModelsState | undefined): ReactNode {
  if (!state) return null;
  if (state.state === 'loading') return <Loading />;
  if (state.state === 'failed') return <span className="ps-why">{state.text}</span>;
  if (state.models.length === 0) return null;
  return (
    <ul
      className="hp-chips"
      aria-label={t({ id: 'settings.harness.models', defaultMessage: 'Available models' })}
    >
      {state.models.map((m) => (
        <li key={m.id} className="chip mono">
          <ModelMark model={m.id} size={14} />
          {m.id}
        </li>
      ))}
    </ul>
  );
}

const KIND_LABEL: Record<SessionKind, string> = {
  get writer() {
    return t({ id: 'settings.harness.kind.writer', defaultMessage: 'Code' });
  },
  get reviewer() {
    return t({ id: 'settings.harness.kind.reviewer', defaultMessage: 'Review' });
  },
  get text() {
    return t({ id: 'settings.harness.kind.text', defaultMessage: 'Text' });
  },
};

/**
 * Whether sessions reach the runtime: not connected after a failed check, with its reason when it
 * has one, else the sign-in when it stops them, else connected.
 */
export function connectionState(s: RuntimeStatus): { s: string; text: string } {
  if (s.connection?.connected === false)
    return {
      s: 'bad',
      text: s.connection.reason
        ? t(
            {
              id: 'settings.runtimes.disconnectedBecause',
              defaultMessage: 'Not connected: {reason}',
            },
            { reason: s.connection.reason },
          )
        : t({ id: 'settings.runtimes.disconnected', defaultMessage: 'Not connected' }),
    };
  return (
    signIn(s.auth) ?? {
      s: 'ok',
      text: t({ id: 'settings.runtimes.connected', defaultMessage: 'Connected' }),
    }
  );
}

/** The sign-in state that stops a session, with the status its dot takes; nothing otherwise. */
function signIn(auth: RuntimeStatus['auth']): { s: string; text: string } | null {
  if (auth.state === 'logged_out')
    return {
      s: 'idle',
      text: t({ id: 'settings.runtimes.signedOut', defaultMessage: 'Not signed in' }),
    };
  if (auth.state === 'unsupported_channel')
    return {
      s: 'wait',
      text: t({
        id: 'settings.runtimes.notSubscription',
        defaultMessage: 'Not signed in with a subscription account',
      }),
    };
  return null;
}

/** The agent harnesses the daemon checked on this machine; models need a project to list them in. */
export function HarnessPage({ projectId }: { projectId: string | null }) {
  const { read, refresh } = useRuntimeStatus();
  /** Why the last change or login of a runtime failed, by runtime. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  /** Binary paths as typed, and as last saved, by runtime. */
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [savedPaths, setSavedPaths] = useState<Record<string, string>>({});
  /** Launch arguments as typed, and as last saved, by runtime, space-separated. */
  const [args, setArgs] = useState<Record<string, string>>({});
  const [savedArgs, setSavedArgs] = useState<Record<string, string>>({});
  const now = useNow(30_000);
  const statuses = read.state === 'ready' ? read.statuses : [];
  const installed = statuses.filter((s) => s.enabled && s.installed).map((s) => s.runtime);
  const listed = useRuntimeModels(projectId, installed);
  const backends = useBackends();
  /** The runtimes whose account email the user chose to show. */
  const [shownEmails, setShownEmails] = useState<Record<string, boolean>>({});
  const recheck = useRef(refresh);
  recheck.current = refresh;
  /** Whether the header check's read has not landed yet. */
  const waiting = useRef(false);
  useEffect(() => {
    useRecheck.setState({
      run: () => {
        waiting.current = true;
        useRecheck.setState({ busy: true });
        recheck.current();
      },
    });
    return () => useRecheck.setState({ run: null, busy: false });
  }, []);
  // Every read that lands is a new object.
  useEffect(() => {
    if (!waiting.current) return;
    waiting.current = false;
    useRecheck.setState({ busy: false });
  }, [read]);

  const fail = (runtime: string, text: string | null) =>
    setErrors(({ [runtime]: _, ...rest }) => (text === null ? rest : { ...rest, [runtime]: text }));

  const configure = async (
    runtime: string,
    change: {
      enabled?: boolean;
      binary?: string;
      args?: string[];
      artifacts?: boolean;
      unverified_isolation?: boolean;
    },
  ) => {
    setSaving(runtime);
    const result = await runCommand('runtime.config.set', { runtime, ...change }, null);
    setSaving(null);
    if (!result.ok) {
      fail(runtime, failureText(result.error));
      return false;
    }
    fail(runtime, null);
    refresh();
    return true;
  };

  const savePath = async ({ runtime, binary: configured }: RuntimeStatus) => {
    const binary = paths[runtime]?.trim();
    if (!binary || binary === (savedPaths[runtime] ?? configured)) return;
    if (await configure(runtime, { binary }))
      setSavedPaths((saved) => ({ ...saved, [runtime]: binary }));
  };

  const argsText = (s: RuntimeStatus) =>
    args[s.runtime] ?? savedArgs[s.runtime] ?? (s.args ?? []).join(' ');

  const saveArgs = async (s: RuntimeStatus) => {
    const typed = args[s.runtime];
    if (typed === undefined) return;
    const argv = typed.split(/\s+/).filter(Boolean);
    const text = argv.join(' ');
    if (text === (savedArgs[s.runtime] ?? (s.args ?? []).join(' '))) return;
    if (await configure(s.runtime, { args: argv }))
      setSavedArgs((saved) => ({ ...saved, [s.runtime]: text }));
  };

  const login = async (runtime: LoginRuntime) => {
    fail(runtime, null);
    const result = await logIn(runtime);
    if (!result.ok) fail(runtime, failureText(result.error));
    refresh();
  };

  const head = (s: RuntimeStatus) => {
    const { runtime, enabled } = s;
    // The account row names a sign-in problem.
    const why = s.installed
      ? unavailableReason({ ...s, auth: { state: 'ok' } })
      : t({ id: 'settings.runtimes.noBinary', defaultMessage: 'No executable found' });
    return (
      <div className="ps-row" data-setting-id="harness.enable">
        <span className="hp-hd">
          <RuntimeGlyph runtime={runtime} />
          <span className="hp-hd-tx">
            <b>{runtimeName(runtime)}</b>
            <span className="hp-sub">
              {s.installed && s.version !== null && (
                <span className="mono">{versionNumber(s.version)}</span>
              )}
              {s.installed && (
                <time dateTime={s.checked_at}>
                  {t(
                    { id: 'settings.runtimes.checked', defaultMessage: 'Last checked {age}' },
                    { age: ageText(Date.parse(s.checked_at), now) },
                  )}
                </time>
              )}
              {why !== null && (
                <span className="hp-st">
                  <span className="hp-dot" data-s="idle" aria-hidden="true" />
                  {why}
                </span>
              )}
            </span>
          </span>
        </span>
        <input
          type="checkbox"
          className="ps-sw"
          checked={enabled}
          disabled={saving === runtime}
          aria-label={t(
            { id: 'settings.harness.enable', defaultMessage: 'Enable {runtime}' },
            { runtime: runtimeName(runtime) },
          )}
          onChange={(e) => void configure(runtime, { enabled: e.target.checked })}
        />
      </div>
    );
  };

  const account = (s: RuntimeStatus) => {
    const { runtime } = s;
    if (!s.installed) return null;
    const state = connectionState(s);
    const email = s.auth.email;
    const shown = shownEmails[runtime] === true;
    return (
      <Row
        label={t({ id: 'settings.runtimes.account', defaultMessage: 'Account' })}
        settingId="harness.account"
      >
        {email !== undefined && (
          <button
            type="button"
            className="hp-mail"
            data-hidden={shown ? undefined : ''}
            aria-label={
              shown
                ? t(
                    { id: 'settings.runtimes.hideEmail', defaultMessage: 'Hide {email}' },
                    { email },
                  )
                : t({ id: 'settings.runtimes.showEmail', defaultMessage: 'Show email' })
            }
            onClick={() => setShownEmails((all) => ({ ...all, [runtime]: !shown }))}
          >
            {email}
          </button>
        )}
        {s.auth.plan !== undefined && <span className="chip">{s.auth.plan}</span>}
        <span className="hp-st">
          <span className="hp-dot" data-s={state.s} aria-hidden="true" />
          <span className="mu">{state.text}</span>
        </span>
        {s.enabled && s.auth.state === 'logged_out' && loginRuntime(runtime) && (
          <button type="button" className="btn" onClick={() => void login(runtime)}>
            {t({ id: 'settings.harness.logIn', defaultMessage: 'Sign in' })}
          </button>
        )}
      </Row>
    );
  };

  const group = (s: RuntimeStatus) => {
    const runtime = s.runtime;
    const name = runtimeName(runtime);
    const kinds = sessionKinds(s);
    const listedModels = s.enabled && s.installed && projectId ? models(listed[runtime]) : null;
    return (
      <div key={runtime} className="ps-grp" role="group" aria-label={name}>
        <div className="ps-rows">
          {head(s)}
          <Row
            label={t({ id: 'settings.runtimes.binary', defaultMessage: 'Executable' })}
            settingId="harness.binary"
          >
            <input
              className="inp mono hp-path"
              spellCheck={false}
              disabled={saving === runtime}
              aria-label={t(
                { id: 'settings.harness.binary', defaultMessage: 'Binary path of {runtime}' },
                { runtime: name },
              )}
              placeholder={t(
                { id: 'settings.harness.binary', defaultMessage: 'Binary path of {runtime}' },
                { runtime: name },
              )}
              value={paths[runtime] ?? savedPaths[runtime] ?? s.binary ?? ''}
              onChange={(e) => setPaths((typed) => ({ ...typed, [runtime]: e.target.value }))}
              onBlur={() => void savePath(s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePath(s);
              }}
            />
          </Row>
          {s.installed && (
            <Row
              label={t({ id: 'settings.search.harnessArgs', defaultMessage: 'Launch arguments' })}
              settingId="harness.args"
            >
              <input
                className="inp mono hp-path"
                spellCheck={false}
                disabled={saving === runtime}
                aria-label={t(
                  { id: 'settings.harness.args', defaultMessage: 'Launch arguments of {runtime}' },
                  { runtime: name },
                )}
                placeholder={t({ id: 'settings.runtimes.argsNone', defaultMessage: 'None' })}
                value={argsText(s)}
                onChange={(e) => setArgs((typed) => ({ ...typed, [runtime]: e.target.value }))}
                onBlur={() => void saveArgs(s)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveArgs(s);
                }}
              />
            </Row>
          )}
          {account(s)}
          {s.installed && runtime === 'claude' && (
            <Row
              label={t({ id: 'settings.harness.artifacts', defaultMessage: 'Publish artifacts' })}
              settingId="harness.artifacts"
            >
              <input
                type="checkbox"
                className="ps-sw"
                checked={s.artifacts !== false}
                disabled={saving === runtime}
                aria-label={t({
                  id: 'settings.harness.artifacts',
                  defaultMessage: 'Publish artifacts',
                })}
                onChange={(e) => void configure(runtime, { artifacts: e.target.checked })}
              />
            </Row>
          )}
          {s.installed && s.capabilities?.write_isolation?.status !== 'supported' && (
            <Row
              label={t({
                id: 'settings.runtimes.unverifiedIsolation',
                defaultMessage: 'Allow without verified isolation',
              })}
              hint={t({
                id: 'settings.runtimes.unverifiedIsolationHint',
                defaultMessage:
                  'Code, review and text sessions start on this runtime though nothing verified that it stays in its worktree',
              })}
              settingId="harness.unverifiedIsolation"
            >
              <input
                type="checkbox"
                className="ps-sw"
                checked={s.unverified_isolation === true}
                disabled={saving === runtime}
                aria-label={t({
                  id: 'settings.runtimes.unverifiedIsolation',
                  defaultMessage: 'Allow without verified isolation',
                })}
                onChange={(e) =>
                  void configure(runtime, { unverified_isolation: e.target.checked })
                }
              />
            </Row>
          )}
          {s.installed && kinds.length > 0 && (
            <Row
              label={t({ id: 'settings.harness.kinds', defaultMessage: 'Session kinds' })}
              settingId="harness.kinds"
            >
              <ul
                className="hp-chips"
                aria-label={t({ id: 'settings.harness.kinds', defaultMessage: 'Session kinds' })}
              >
                {kinds.map((kind) => (
                  <li key={kind} className="chip">
                    {KIND_LABEL[kind]}
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {listedModels !== null && (
            <Row
              label={t({ id: 'settings.harness.models', defaultMessage: 'Available models' })}
              settingId="harness.models"
            >
              {listedModels}
            </Row>
          )}
          {s.installed && projectId !== null && (s.quota?.windows.length ?? 0) > 0 && (
            <Row
              label={t({ id: 'settings.harness.quota', defaultMessage: 'Quota' })}
              settingId="harness.quota"
            >
              <button type="button" className="btn ghost sm" onClick={() => openBoardTab('usage')}>
                {t({ id: 'settings.runtimes.seeUsage', defaultMessage: 'See usage' })}
              </button>
            </Row>
          )}
        </div>
        {errors[runtime] !== undefined && (
          <div className="ps-err hp-err" role="alert">
            {errors[runtime]}
          </div>
        )}
      </div>
    );
  };

  let body: ReactNode;
  if (read.state === 'loading') body = <Loading />;
  else if (read.state === 'failed')
    body = (
      <div className="ps-err" role="alert">
        {read.text}
      </div>
    );
  else if (statuses.length === 0)
    body = (
      <EmptyState
        inline
        title={t({
          id: 'settings.harness.none',
          defaultMessage: 'The daemon reported no harnesses',
        })}
      />
    );
  else {
    const sorted = [...statuses].sort((a, b) => compareRuntimes(a.runtime, b.runtime));
    const missing = sorted.filter((s) => !s.installed);
    body = (
      <>
        {sorted.filter((s) => s.installed).map(group)}
        {missing.length > 0 && (
          <Collapsible.Root className="hp-other" defaultOpen={false}>
            <Collapsible.Trigger className="hp-tg">
              <ChevronRight className="hp-chev" aria-hidden="true" />
              {t({ id: 'settings.harness.notInstalled', defaultMessage: 'Not installed' })}
              <span className="hp-cnt">{missing.length}</span>
            </Collapsible.Trigger>
            <Collapsible.Panel className="hp-fold">{missing.map(group)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
      </>
    );
  }

  const backendRow = (b: BackendSummary) => (
    <div key={b.id} className="ps-row" role="group" aria-label={b.id}>
      <span className="hp-be">
        <span className="hp-be-hd">
          <b className="mono">{b.id}</b>
          <span className="chip">{b.protocol}</span>
        </span>
        <span className="mono hp-url hp-sel">{b.base_url}</span>
      </span>
      <span className="hp-be-end">
        {b.runtimes.map((runtime) => (
          <span key={runtime} className="hp-st">
            <RuntimeGlyph runtime={runtime} />
            <span>{runtimeName(runtime)}</span>
          </span>
        ))}
        {'env' in b.key ? (
          <span className="hp-st">
            {b.key_present === false && (
              <span className="hp-dot" data-s="wait" aria-hidden="true" />
            )}
            <span className="mono hp-sel">{b.key.env}</span>
            {b.key_present === false && (
              <span className="mu">
                {t({ id: 'settings.runtimes.keyMissing', defaultMessage: 'Not set' })}
              </span>
            )}
          </span>
        ) : (
          <span className="hp-st">
            <span className="mu">
              {t({ id: 'settings.harness.backendKeychain', defaultMessage: 'Keychain' })}
            </span>
            <span className="mono hp-sel">{b.key.keychain}</span>
          </span>
        )}
      </span>
    </div>
  );

  return (
    <>
      {body}
      {backends.length > 0 && (
        <Section title={t({ id: 'settings.harness.backends', defaultMessage: 'Backends' })}>
          <div className="ps-rows" data-setting-id="harness.backends">
            {backends.map(backendRow)}
          </div>
        </Section>
      )}
    </>
  );
}
