import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { t } from '../i18n';
import { messageCommand } from '../screens/sessions/model';
import { askFix } from '../screens/sessions/panel';
import { useShell } from '../store';
import { appErrors, debugTarget } from './app-errors';
import { useBoard } from './board';
import { runCommand } from './commands';
import { currentProject, useCurrentProject } from './current-project';
import { failureText } from './needs-you';
import { composeState, type Session } from './transcript';
import { readQuery } from './workbench-sessions';

/** Whether session.send or session.steer, whichever the session's state takes, can go to it now. */
export const canMessage = (session: Session): boolean =>
  composeState(session)[messageCommand(session.state) === 'session.steer' ? 'steer' : 'send']
    .enabled;

/** The report a debug session gets: the error, where the user was, and the app's recent problems. */
async function debugPrompt(title: string, detail: string | undefined): Promise<string> {
  const bridge = window.pantheon;
  const { screen, sessionId } = useShell.getState();
  const projectId = currentProject(
    useBoard.getState().board,
    useCurrentProject.getState().projectId,
  )?.id;
  const version = await bridge
    ?.appInfo()
    .then((info) => info.version)
    .catch(() => null);
  const logs = await bridge?.logsDir().catch(() => null);
  const recent = appErrors()
    .slice(-20)
    .map((entry) => JSON.stringify(entry));
  // Sent to the model, so it stays in one language.
  return [
    `The user asked about this error in the running Pantheon app:\n\n${title}`,
    detail ? `Detail:\n\n${detail}` : '',
    [
      `Screen: ${screen}`,
      `Project id: ${projectId ?? 'none'}`,
      `Session id: ${sessionId ?? 'none'}`,
      `App version: ${version ?? 'unknown'}`,
      `Daemon log folder: ${logs ?? 'unknown'}`,
    ].join('\n'),
    recent.length ? `Recent problems the app recorded, oldest first:\n\n${recent.join('\n')}` : '',
    'Reproduce the error in the running app first; after fixing it, reproduce it again to confirm it is gone.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const copied = async (prompt: string): Promise<void> => {
  await navigator.clipboard?.writeText(prompt).catch(() => {});
};

/** The newest debug session of the project for this app's port that is live and takes messages. */
async function debugSession(projectId: string, port: number | null): Promise<Session | null> {
  const listed = await readQuery('session.list', { project_id: projectId });
  if (!listed.ok || !Array.isArray(listed.value)) return null;
  const board = useBoard.getState().board?.sessions ?? [];
  const found = (listed.value as WorkbenchSession[])
    .filter((s) => s.app_debug && s.app_debug.cdp_port === (port ?? undefined) && !s.archived_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((s) => board.find((session) => session.id === s.id))
    .find((session) => session !== undefined && canMessage(session));
  return found ?? null;
}

/**
 * Sends the error, with what the app knows around it, to the Pantheon repository's debug session,
 * opening one when there is none; copies the report where no debug session can reach this app.
 */
export async function askDebugAgent({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}): Promise<void> {
  const prompt = await debugPrompt(title, detail);
  const target = window.pantheon ? await debugTarget() : null;
  if (!target) {
    await copied(prompt);
    toast({
      title: t({ id: 'data.askDebug.copied', defaultMessage: 'Copied the error report' }),
    });
    return;
  }
  const project = useBoard.getState().board?.projects.find((p) => p.roots[0] === target.repo_root);
  if (!project) {
    await copied(prompt);
    toast({
      title: t({
        id: 'data.askDebug.noProject',
        defaultMessage:
          'Add the Pantheon repository as a project to ask an agent; the report was copied',
      }),
      kind: 'failure',
      askAgent: false,
    });
    return;
  }
  const session = await debugSession(project.id, target.cdp_port);
  const result: BridgeResult<unknown> = session
    ? await askFix(session.id, session.state, session.revision, [
        { id: `app-debug:${Date.now()}`, kind: 'reference', label: title, text: prompt },
      ])
    : await runCommand(
        'session.create',
        {
          project_id: project.id,
          input: prompt,
          purpose: 'app_debug',
          ...(target.cdp_port !== null ? { cdp_port: target.cdp_port } : {}),
        },
        null,
      );
  if (!result.ok) {
    toast({ title: failureText(result.error), kind: 'failure', askAgent: false });
    return;
  }
  const id = session?.id ?? (result.value as { id?: unknown } | null)?.id;
  toast({
    title: t({ id: 'data.askDebug.sent', defaultMessage: 'Sent to the debug session' }),
    ...(typeof id === 'string'
      ? {
          action: {
            label: t({ id: 'data.askDebug.open', defaultMessage: 'Open' }),
            run: () => useShell.getState().openProjectSession(project.id, id),
          },
        }
      : {}),
  });
}
