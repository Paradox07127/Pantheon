import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, ChevronLeft, Copy, Plus, RefreshCw, Terminal } from 'lucide-react';
import { create } from 'zustand';
import type { DeviceListItem, SshHost } from '@pantheon/protocol';
import { coresText, deviceName, offlineText, systemName } from '../../components/DevicesSummary';
import { compareRuntimes, RuntimeGlyph, runtimeName } from '../../components/RuntimeGlyph';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { useDevices } from '../../data/devices';
import { ageText, failureText, useNow } from '../../data/needs-you';
import { listedRuntime, useRuntimeStatus } from '../../data/runtime-status';
import { readQuery } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { Loading } from './ProjectSettingsScreen';
import { registerPageHeader } from './settings-header';
import { useSettingsView } from './view';
import '../../components/state-icon.css';
import './devices.css';

const isLocal = (d: DeviceListItem) => d.id === 'local';

/** The runtimes a device probe looks for, with the command that signs each in. */
const LOGIN_COMMAND: Record<string, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

/** The tool's version out of its --version line, else the whole line. */
const toolVersion = (line: string) => /\d+(\.\d+)+/.exec(line)?.[0] ?? line;

/** A device id from an SSH host name, as device.save accepts it. */
const deviceId = (host: string) =>
  host
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '');

const Spinner = () => (
  <svg
    className="si"
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    aria-hidden="true"
  >
    <circle className="si-spin" cx="7" cy="7" r="5" pathLength={4} strokeDasharray="3 1" />
  </svg>
);

/** The mounted page's probe of every device, and whether one it ran has not answered yet. */
const useReprobeAll = create<{ run: (() => void) | null; busy: boolean }>(() => ({
  run: null,
  busy: false,
}));

function ReprobeAll() {
  const busy = useReprobeAll((s) => s.busy);
  return (
    <button
      type="button"
      className="btn ghost sm"
      disabled={busy}
      onClick={() => useReprobeAll.getState().run?.()}
    >
      {busy ? <Spinner /> : <RefreshCw className="ic-sm" aria-hidden="true" />}
      {t({ id: 'settings.devices.reprobeAll', defaultMessage: 'Re-probe all' })}
    </button>
  );
}

registerPageHeader('devices', { tools: ReprobeAll });

/** This machine and the SSH execution devices; a device opens to what its last probe found. */
export function DevicesPage() {
  const { read, reload } = useDevices();
  useEffect(() => {
    useReprobeAll.setState({
      run: () => {
        useReprobeAll.setState({ busy: true });
        void reload(true).then(() => useReprobeAll.setState({ busy: false }));
      },
    });
    return () => useReprobeAll.setState({ run: null, busy: false });
  }, [reload]);
  const reprobingAll = useReprobeAll((s) => s.busy);
  const runtimeStatus = useRuntimeStatus();
  const board = useBoard((s) => s.board);
  const now = useNow(30_000);
  /** The device whose details show instead of the list. */
  const [open, setOpen] = useState<string | null>(null);
  /** The devices whose connection test has not answered yet. */
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  /** The hosts of ~/.ssh/config; null until they are read. */
  const [hosts, setHosts] = useState<SshHost[] | null>(null);
  /** Failures by the control they belong to. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [host, setHost] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const devices = read.state === 'ready' ? read.devices : [];

  useEffect(() => {
    let live = true;
    void readQuery('device.ssh_hosts', {}).then((result) => {
      if (live && result.ok && Array.isArray(result.value)) setHosts(result.value as SshHost[]);
    });
    return () => {
      live = false;
    };
  }, []);

  const fail = (at: string, text: string | null) =>
    setErrors(({ [at]: _, ...rest }) => (text === null ? rest : { ...rest, [at]: text }));

  /** Probes only this device, then reads the list again. */
  const test = async (id: string) => {
    setTesting((b) => ({ ...b, [id]: true }));
    const result = await readQuery('device.probe', { id });
    if (!result.ok) toast({ title: failureText(result.error), kind: 'failure' });
    await reload(false);
    setTesting(({ [id]: _, ...rest }) => rest);
  };

  /** Adds the SSH host as a device and tests it; the failure text, else null. */
  const addHost = async (ssh: string): Promise<string | null> => {
    const id = deviceId(ssh);
    if (devices.some((d) => d.id === id))
      return t(
        { id: 'settings.devices.duplicate', defaultMessage: '{id} is already a device' },
        { id },
      );
    const result = await runCommand('device.save', { id, ssh }, null);
    if (!result.ok) return failureText(result.error);
    await reload(false);
    void test(id);
    return null;
  };

  const add = async () => {
    const ssh = host.trim();
    if (!ssh || read.state !== 'ready') return;
    const error = await addHost(ssh);
    setAddError(error);
    if (error === null) setHost('');
  };

  const remove = async (d: DeviceListItem) => {
    const result = await runCommand('device.remove', { id: d.id }, null);
    if (!result.ok) {
      fail(`${d.id}:remove`, failureText(result.error));
      return;
    }
    fail(`${d.id}:remove`, null);
    setOpen(null);
    await reload(false);
    const config = d.config;
    toast({
      title: t(
        { id: 'settings.devices.removed', defaultMessage: 'Removed {name}' },
        { name: d.name },
      ),
      action: {
        label: t({ id: 'settings.devices.undo', defaultMessage: 'Undo' }),
        run: () =>
          void runCommand('device.save', { id: d.id, ...config }, null).then((result) => {
            if (result.ok) void test(d.id);
            else toast({ title: failureText(result.error), kind: 'failure' });
          }),
      },
    });
  };

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyFailed(null);
    } catch {
      setCopyFailed(command);
    }
  };

  const errorText = (at: string) =>
    errors[at] !== undefined && (
      <span className="ps-err" role="alert">
        {errors[at]}
      </span>
    );

  /** Whether the device answers, or that a probe of it has not answered yet. */
  const dot = (d: DeviceListItem) => {
    const probing = testing[d.id] || reprobingAll;
    return (
      <span
        className="dv-dot"
        data-s={probing ? 'chk' : d.online ? 'ok' : 'bad'}
        role="img"
        aria-label={
          probing
            ? t({ id: 'settings.devices.testing', defaultMessage: 'Testing connection' })
            : d.online
              ? t({ id: 'settings.devices.online', defaultMessage: 'Online' })
              : offlineText()
        }
      />
    );
  };

  const testButton = (d: DeviceListItem, name: string) => {
    const label = t(
      { id: 'settings.devices.testOf', defaultMessage: 'Test connection to {name}' },
      { name },
    );
    return (
      <button
        type="button"
        className="ib"
        aria-label={label}
        title={label}
        disabled={testing[d.id] || reprobingAll}
        onClick={() => void test(d.id)}
      >
        <Activity aria-hidden="true" />
      </button>
    );
  };

  const memoryText = (d: DeviceListItem) =>
    d.memory_bytes !== undefined &&
    t(
      { id: 'settings.devices.memory', defaultMessage: '{count} GB' },
      { count: Math.round(d.memory_bytes / 2 ** 30) },
    );

  const offline = (d: DeviceListItem) => (
    <span className="dv-off">
      <span>{offlineText()}</span>
      {d.last_online_at !== undefined && (
        <time dateTime={d.last_online_at}>
          {t(
            { id: 'settings.devices.lastOnline', defaultMessage: 'Last online {age}' },
            { age: ageText(Date.parse(d.last_online_at), now) },
          )}
        </time>
      )}
    </span>
  );

  /** The runtimes of the device in display order; version is absent for one not installed. */
  const runtimesOf = (
    d: DeviceListItem,
  ): { runtime: string; version?: string; signedIn: boolean }[] =>
    (isLocal(d)
      ? runtimeStatus.read.state === 'ready'
        ? runtimeStatus.read.statuses.filter(listedRuntime).map((s) => ({
            runtime: s.runtime,
            ...(s.installed && { version: s.version ?? '' }),
            signedIn: s.auth.state === 'ok',
          }))
        : []
      : [...new Set([...Object.keys(LOGIN_COMMAND), ...Object.keys(d.runtimes)])].map(
          (runtime) => ({
            runtime,
            ...(d.runtimes[runtime] && { version: d.runtimes[runtime].version }),
            signedIn: d.runtimes[runtime]?.logged_in ?? false,
          }),
        )
    ).sort((a, b) => compareRuntimes(a.runtime, b.runtime));

  const runtimeRows = (d: DeviceListItem) =>
    runtimesOf(d).map(({ runtime, version, signedIn }) => {
      const name = runtimeName(runtime);
      const login = LOGIN_COMMAND[runtime];
      const command = login && (isLocal(d) ? login : `ssh -t ${d.ssh} ${login}`);
      return (
        <Fragment key={runtime}>
          <span className="dv-k dv-rtk">
            <RuntimeGlyph runtime={runtime} size={14} />
            {name}
          </span>
          <div className="dv-v">
            {version === undefined ? (
              <span className="dv-tx2">
                {t({ id: 'settings.devices.notInstalled', defaultMessage: 'Not installed' })}
              </span>
            ) : (
              <>
                <span className="dv-num">{toolVersion(version)}</span>
                <span
                  className="dv-dot"
                  data-s={signedIn ? 'ok' : 'wait'}
                  role="img"
                  aria-label={
                    signedIn
                      ? t(
                          {
                            id: 'settings.devices.signedIn',
                            defaultMessage: '{runtime} signed in',
                          },
                          { runtime: name },
                        )
                      : t(
                          {
                            id: 'settings.devices.needsSignInOf',
                            defaultMessage: '{runtime} needs sign-in',
                          },
                          { runtime: name },
                        )
                  }
                />
                {!signedIn && command && (
                  <>
                    <span className="dv-tx2" aria-hidden="true">
                      {t({ id: 'settings.devices.needsSignIn', defaultMessage: 'Needs sign-in' })}
                    </span>
                    <code className="dv-cmd">{command}</code>
                    <button type="button" className="btn" onClick={() => void copy(command)}>
                      <Copy className="ic-sm" aria-hidden="true" />
                      {t({ id: 'settings.devices.copy', defaultMessage: 'Copy' })}
                    </button>
                    {copyFailed === command && (
                      <span className="ps-err" role="alert">
                        {t({ id: 'settings.devices.copyFailed', defaultMessage: "Couldn't copy" })}
                      </span>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </Fragment>
      );
    });

  const loadRow = (d: DeviceListItem) => {
    if (!d.online || d.load_1m === undefined || !d.cpus) return null;
    const share = Math.min(d.load_1m / d.cpus, 1);
    return (
      <>
        <span className="dv-k">{t({ id: 'settings.devices.load', defaultMessage: 'Load' })}</span>
        <div className="dv-v dv-load">
          <span
            className="dv-meter"
            role="img"
            aria-label={t(
              {
                id: 'settings.devices.loadOf',
                defaultMessage: 'Load {percent}%, 1-minute average {load}',
              },
              { percent: Math.round(share * 100), load: d.load_1m.toFixed(2) },
            )}
          >
            <span className="dv-meter-b" style={{ '--dv-share': share } as CSSProperties} />
          </span>
          <span className="dv-num" aria-hidden="true">
            {d.load_1m.toFixed(2)}
          </span>
        </div>
      </>
    );
  };

  /** The labels the device's probe found. */
  const labelsRow = (d: DeviceListItem) =>
    d.labels.length > 0 && (
      <>
        <span className="dv-k">
          {t({ id: 'settings.devices.labels', defaultMessage: 'Labels' })}
        </span>
        <div className="dv-v">
          {d.labels.map((label) => (
            <span key={label} className="chip dv-lbl">
              {label}
            </span>
          ))}
        </div>
      </>
    );

  /** The open sessions on the device; one opens where the board knows its project. */
  const runningRow = (d: DeviceListItem) =>
    d.load.active_sessions.length > 0 && (
      <>
        <span className="dv-k">
          {t({ id: 'settings.devices.running', defaultMessage: 'Running' })}
        </span>
        <div className="dv-v dv-runs">
          {d.load.active_sessions.map((s) => {
            const projectId = board?.sessions.find((b) => b.id === s.id)?.project_id;
            const inner = (
              <>
                <RuntimeGlyph runtime={s.runtime} size={14} />
                <span className="dv-run-t">{s.title}</span>
                <time className="dv-run-at" dateTime={s.started_at}>
                  {ageText(Date.parse(s.started_at), now)}
                </time>
              </>
            );
            return projectId ? (
              <button
                key={s.id}
                type="button"
                className="dv-run"
                onClick={() => {
                  useSettingsView.getState().close();
                  useShell.getState().openProjectSession(projectId, s.id);
                }}
              >
                {inner}
              </button>
            ) : (
              <span key={s.id} className="dv-run">
                {inner}
              </span>
            );
          })}
        </div>
      </>
    );

  const toolsRow = (d: DeviceListItem) =>
    Object.keys(d.tools).length > 0 && (
      <>
        <span className="dv-k">{t({ id: 'settings.devices.tools', defaultMessage: 'Tools' })}</span>
        <div className="dv-v dv-tools">
          {Object.entries(d.tools).map(([tool, line]) => (
            <span key={tool}>{`${tool} ${toolVersion(line)}`}</span>
          ))}
        </div>
      </>
    );

  const details = (d: DeviceListItem) => {
    if (isLocal(d))
      return (
        <>
          {runtimeRows(d)}
          {loadRow(d)}
          {labelsRow(d)}
          {toolsRow(d)}
          {runningRow(d)}
        </>
      );
    return (
      <>
        {d.online ? (
          <>
            {runtimeRows(d)}
            {loadRow(d)}
            {labelsRow(d)}
            {toolsRow(d)}
          </>
        ) : (
          <>
            <span className="dv-k">
              {t({ id: 'settings.devices.reason', defaultMessage: 'Reason' })}
            </span>
            <code className="dv-err">{d.error}</code>
          </>
        )}
        {runningRow(d)}
        <span />
        <div className="dv-v">
          <button type="button" className="btn ghost dv-end" onClick={() => void remove(d)}>
            {t({ id: 'settings.devices.remove', defaultMessage: 'Remove device' })}
          </button>
          {errorText(`${d.id}:remove`)}
        </div>
      </>
    );
  };

  const detail = (d: DeviceListItem) => {
    const name = deviceName(d);
    return (
      <div className="dv-pg">
        <div className="dv-bar">
          <button type="button" className="btn ghost sm" onClick={() => setOpen(null)}>
            <ChevronLeft className="ic-sm" aria-hidden="true" />
            {t({ id: 'settings.devices.back', defaultMessage: 'All devices' })}
          </button>
        </div>
        <section className="dv-card" aria-label={name}>
          <div className="dv-top">
            {dot(d)}
            <b className="dv-name">{name}</b>
            {d.ssh !== undefined && <span className="dv-ssh">{d.ssh}</span>}
            {d.online ? (
              <span className="dv-sys">
                {[systemName(d), d.arch, coresText(d), memoryText(d)].map((fact, i) =>
                  fact ? <span key={i}>{fact}</span> : null,
                )}
              </span>
            ) : (
              offline(d)
            )}
            {testButton(d, name)}
          </div>
          <div className="dv-x">{details(d)}</div>
        </section>
      </div>
    );
  };

  const row = (d: DeviceListItem) => {
    const name = deviceName(d);
    return (
      <li key={d.id} className="dv">
        <button type="button" className="dv-open" onClick={() => setOpen(d.id)}>
          <span className="dv-nm" data-off={!d.online || undefined}>
            {dot(d)}
            <b className="dv-name">{name}</b>
          </span>
          {d.online ? (
            <>
              <span className="dv-os">{systemName(d)}</span>
              <span className="dv-c">{d.arch}</span>
              <span className="dv-c">{coresText(d)}</span>
              <span className="dv-c">{memoryText(d)}</span>
            </>
          ) : (
            offline(d)
          )}
        </button>
        {testButton(d, name)}
      </li>
    );
  };

  /** A host of ~/.ssh/config with a switch that adds it as a device or removes the device. */
  const hostRow = (h: SshHost) => {
    const device = devices.find((d) => d.ssh === h.host);
    const target =
      h.user || h.hostname ? `${h.user ? `${h.user}@` : ''}${h.hostname ?? h.host}` : undefined;
    return (
      <li key={h.host} className="dv-hr">
        <span className="dv-hn">{h.host}</span>
        <span className="dv-ssh">{target}</span>
        <input
          type="checkbox"
          className="ps-sw"
          aria-label={t(
            { id: 'settings.devices.useHost', defaultMessage: 'Use {host} as a device' },
            { host: h.host },
          )}
          checked={device !== undefined}
          disabled={read.state !== 'ready'}
          onChange={(e) => {
            if (!e.target.checked) {
              if (device) void remove(device);
            } else void addHost(h.host).then(setAddError);
          }}
        />
      </li>
    );
  };

  const current = devices.find((d) => d.id === open);
  if (current) return detail(current);

  let body: ReactNode;
  if (read.state === 'loading') body = <Loading />;
  else if (read.state === 'failed')
    body = (
      <div className="ps-err" role="alert">
        {read.text}
      </div>
    );
  else
    body = (
      <ul
        className="dv-grp"
        aria-label={t({ id: 'settings.devices.title', defaultMessage: 'Devices' })}
      >
        {devices.map(row)}
      </ul>
    );

  return (
    <div className="dv-pg">
      {body}
      {hosts !== null && hosts.length > 0 && (
        <ul
          className="dv-grp"
          aria-label={t({
            id: 'settings.devices.sshHosts',
            defaultMessage: 'Hosts in ~/.ssh/config',
          })}
        >
          {hosts.map(hostRow)}
        </ul>
      )}
      <div className="dv-add">
        <label className="field dv-host">
          <Terminal className="ic-sm" aria-hidden="true" />
          <input
            className="mono"
            spellCheck={false}
            placeholder={t({
              id: 'settings.devices.hostPlaceholder',
              defaultMessage: 'Host name in ~/.ssh/config',
            })}
            aria-label={t({
              id: 'settings.devices.host',
              defaultMessage: 'SSH host name of the device to add',
            })}
            value={host}
            disabled={read.state !== 'ready'}
            onChange={(e) => {
              setHost(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={read.state !== 'ready'}
          onClick={() => void add()}
        >
          <Plus className="ic-sm" aria-hidden="true" />
          {t({ id: 'settings.devices.add', defaultMessage: 'Add device' })}
        </button>
      </div>
      {addError !== null && (
        <div className="ps-err" role="alert">
          {addError}
        </div>
      )}
    </div>
  );
}
