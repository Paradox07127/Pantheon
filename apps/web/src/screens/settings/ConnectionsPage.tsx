import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { create } from 'zustand';
import type { ConnectionsStatus } from '@pantheon/protocol';
import { BrandMark, type Brand } from '../../components/BrandMark';
import { useConnectionsStatus } from '../../data/runtime-status';
import { t } from '../../i18n';
import { Loading, Section } from './ProjectSettingsScreen';
import { registerPageHeader } from './settings-header';
import './about-page.css';
import './harness-page.css';

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
      {t({ id: 'settings.connections.recheck', defaultMessage: 'Check again' })}
    </button>
  );
}

registerPageHeader('connections', { tools: RecheckTool });

/** The services signed in through their command-line tools on this computer. */
export function ConnectionsPage() {
  const connections = useConnectionsStatus();
  const again = useRef(connections.refresh);
  again.current = connections.refresh;
  /** Whether the header check's read has not landed yet. */
  const waiting = useRef(false);
  useEffect(() => {
    useRecheck.setState({
      run: () => {
        waiting.current = true;
        useRecheck.setState({ busy: true });
        again.current();
      },
    });
    return () => useRecheck.setState({ run: null, busy: false });
  }, []);
  // Every read that lands is a new object.
  useEffect(() => {
    if (!waiting.current) return;
    waiting.current = false;
    useRecheck.setState({ busy: false });
  }, [connections.read]);

  return (
    <Section>
      <div className="ps-rows">
        <GithubRow github={connections} />
        <ServiceRow connections={connections} service="huggingface" />
        <ServiceRow connections={connections} service="cloudflare" />
      </div>
    </Section>
  );
}

/** A service's mark, or its initial in an outlined square when it has none. */
function ServiceMark({ brand, letter }: { brand?: Brand; letter: string }) {
  return brand ? (
    <BrandMark brand={brand} size={16} fill="currentColor" />
  ) : (
    <span className="cn-ltr" aria-hidden="true">
      {letter}
    </span>
  );
}

/** The gh sign-in: its state and account, with a check that skips the daemon's cache. */
export function GithubRow({ github }: { github: ReturnType<typeof useConnectionsStatus> }) {
  const gh = github.read;
  const ghState =
    gh.state === 'ready'
      ? connectionState(
          gh.github,
          t({ id: 'settings.connections.githubMissing', defaultMessage: 'gh not installed' }),
        )
      : null;
  const githubName = t({ id: 'settings.connections.github', defaultMessage: 'GitHub' });
  return (
    <div
      className="ps-row cn-row"
      role="group"
      aria-label={githubName}
      data-setting-id="connections.github"
    >
      <span className="cn-rt">
        <ServiceMark brand="github" letter="G" />
        <b>{githubName}</b>
      </span>
      {gh.state === 'loading' ? (
        <Loading />
      ) : (
        <span className="cn-acct">
          {ghState !== null && (
            <span className="hp-st">
              <span className="hp-dot" data-s={ghState.s} aria-hidden="true" />
              <span>{ghState.text}</span>
            </span>
          )}
          {gh.state === 'ready' && gh.github.state === 'signed_in' && (
            <>
              {gh.github.account !== undefined && (
                <span className="cn-mail">{gh.github.account}</span>
              )}
              {gh.github.host !== undefined && <span className="chip">{gh.github.host}</span>}
            </>
          )}
        </span>
      )}
      <button
        type="button"
        className="btn ghost sm"
        aria-label={t({
          id: 'settings.connections.recheckGithub',
          defaultMessage: 'Check GitHub again',
        })}
        aria-busy={github.checking || undefined}
        disabled={github.checking}
        onClick={github.refresh}
      >
        <RefreshCw size={14} aria-hidden="true" />
      </button>
      {gh.state === 'failed' && (
        <div className="ps-err cn-err" role="alert">
          {gh.text}
        </div>
      )}
    </div>
  );
}

/** The services signed in through another command-line tool, and its commands. */
const SERVICES = {
  huggingface: {
    brand: 'huggingface',
    letter: 'H',
    name: () => t({ id: 'settings.connections.huggingface', defaultMessage: 'Hugging Face' }),
    missing: () =>
      t({ id: 'settings.connections.huggingfaceMissing', defaultMessage: 'hf not installed' }),
    install: 'pip install -U huggingface_hub',
    login: 'hf auth login',
  },
  cloudflare: {
    brand: undefined,
    letter: 'C',
    name: () => t({ id: 'settings.connections.cloudflare', defaultMessage: 'Cloudflare' }),
    missing: () =>
      t({ id: 'settings.connections.cloudflareMissing', defaultMessage: 'wrangler not installed' }),
    install: 'npm install -g wrangler',
    login: 'wrangler login',
  },
} as const;

/** A sign-in through hf or wrangler: its state and account, or the command that installs or signs in. */
export function ServiceRow({
  connections,
  service,
}: {
  connections: ReturnType<typeof useConnectionsStatus>;
  service: keyof typeof SERVICES;
}) {
  const read = connections.read;
  const status = read.state === 'ready' ? read[service] : undefined;
  // A daemon that does not check the service answers without it.
  if (read.state === 'ready' && status === undefined) return null;
  const { brand, letter, name, missing, install, login } = SERVICES[service];
  const state = status ? connectionState(status, missing()) : null;
  const command =
    status?.state === 'missing' ? install : status?.state === 'signed_out' ? login : null;
  return (
    <div
      className="ps-row cn-row"
      role="group"
      aria-label={name()}
      data-setting-id={`connections.${service}`}
    >
      <span className="cn-rt">
        <ServiceMark brand={brand} letter={letter} />
        <b>{name()}</b>
      </span>
      {read.state === 'loading' ? (
        <Loading />
      ) : (
        <span className="cn-acct">
          {state !== null && (
            <span className="hp-st">
              <span className="hp-dot" data-s={state.s} aria-hidden="true" />
              <span>{state.text}</span>
            </span>
          )}
          {status?.state === 'signed_in' && status.account !== undefined && (
            <span className="cn-mail">{status.account}</span>
          )}
        </span>
      )}
      <span />
      {command !== null && (
        <>
          <span />
          <code className="cn-mail">{command}</code>
          <button
            type="button"
            className="btn ghost sm"
            aria-label={t(
              { id: 'setup.copyCommand', defaultMessage: 'Copy {command}' },
              { command },
            )}
            onClick={() => void navigator.clipboard.writeText(command)}
          >
            {t({ id: 'setup.copy', defaultMessage: 'Copy' })}
          </button>
        </>
      )}
    </div>
  );
}

function connectionState(
  status: Pick<ConnectionsStatus['github'], 'state'>,
  missing: string,
): { s: string; text: string } {
  if (status.state === 'signed_in')
    return {
      s: 'ok',
      text: t({ id: 'settings.connections.githubConnected', defaultMessage: 'Connected' }),
    };
  if (status.state === 'signed_out')
    return {
      s: 'wait',
      text: t({ id: 'settings.connections.needsSignIn', defaultMessage: 'Needs sign-in' }),
    };
  if (status.state === 'missing') return { s: 'idle', text: missing };
  return {
    s: 'unknown',
    text: t({ id: 'settings.connections.githubUnknown', defaultMessage: 'Sign-in unknown' }),
  };
}
