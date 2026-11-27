import type { AppInfo, DaemonInfo, RuntimeStatus } from '@pantheon/protocol';
import type { SignalIssue } from '../../data/signals';

/** What the diagnostics can name; a fact left out is not known. */
export interface DiagnosticsFacts {
  app?: AppInfo;
  daemon?: Pick<DaemonInfo, 'version' | 'protocol_version' | 'data_dir'>;
  /** The protocol version the interface speaks, named when the daemon's is not known. */
  protocol: number;
  logs_dir?: string;
  runtimes?: readonly RuntimeStatus[];
  /** The daemon's recorded errors; only the unresolved ones are named. */
  errors?: readonly SignalIssue[];
}

const OS_NAME: Record<AppInfo['os'], string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
};

/** The plain text for a support request, one fact per line; it holds no account names. */
export function diagnosticsText(facts: DiagnosticsFacts): string {
  const { app, daemon } = facts;
  const lines: string[] = [];
  if (app)
    lines.push(
      `App: ${app.version}`,
      `Electron: ${app.electron}`,
      `OS: ${OS_NAME[app.os]} ${app.os_version}`,
      `Architecture: ${app.arch}`,
    );
  if (daemon) lines.push(`Daemon: ${daemon.version}`);
  lines.push(`Protocol: ${daemon?.protocol_version ?? facts.protocol}`);
  if (daemon) lines.push(`Data folder: ${daemon.data_dir}`);
  if (facts.logs_dir !== undefined) lines.push(`Logs folder: ${facts.logs_dir}`);
  for (const s of facts.runtimes ?? []) {
    const version = s.installed ? (s.version ?? 'unknown version') : 'not installed';
    lines.push(`Runtime ${s.runtime}: ${version}, signed in: ${s.auth.state}`);
  }
  for (const e of facts.errors ?? [])
    if (e.state !== 'resolved')
      lines.push(`Daemon error: ${e.title.replace(/\s*\n\s*/g, ' ')} (${e.count} times)`);
  return lines.join('\n');
}
