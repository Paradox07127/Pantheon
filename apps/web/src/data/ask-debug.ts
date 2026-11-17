import type { BridgeResult, ProjectDefaultsRead, WorkbenchSession } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { t } from '../i18n';
import { messageCommand } from '../screens/sessions/model';
import { defaultRuntime } from '../screens/sessions/thread-model';
import { askFix } from '../screens/sessions/panel';
import { useShell } from '../store';
import { appErrors, debugTarget, type AppError } from './app-errors';
import { useBoard } from './board';
import { runCommand } from './commands';
import { currentProject, useCurrentProject } from './current-project';
import { failureText } from './needs-you';
import { effectiveSessionDefaults } from './project-defaults';
import { composeState, type Session } from './transcript';
import { readQuery } from './workbench-sessions';

/** Whether session.send or session.steer, whichever the session's state takes, can go to it now. */
export const canMessage = (session: Session): boolean =>
  composeState(session)[messageCommand(session.state) === 'session.steer' ? 'steer' : 'send']
    .enabled;

/** The report a debug session gets: the error, where the user was, and the app's recent problems. */
async function debugPrompt(
  title: string,
  detail: string | undefined,
  error: AppError | undefined,
): Promise<string> {
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
    .filter((entry) => entry.id !== error?.id)
    .slice(-20)
    .map((entry) => JSON.stringify(entry));
  // Sent to the model, so it stays in one language.
  return [
    `The user asked about this in the running Pantheon app:\n\n${title}`,
    error ? `The error:\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\`` : '',
    detail ? `Detail:\n\n${detail}` : '',
    [
      `Screen: ${screen}`,
      `Project id: ${projectId ?? 'none'}`,
      `Session id: ${sessionId ?? 'none'}`,
      `App version: ${version ?? 'unknown'}`,
      `Daemon log folder: ${logs ?? 'unknown'}`,
    ].join('\n'),
    recent.length ? `Recent problems the app recorded, oldest first:\n\n${recent.join('\n')}` : '',
    'Reproduce the problem in the running app first; after fixing it, reproduce it again to confirm it is gone.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const copied = async (prompt: string): Promise<void> => {
  await navigator.clipboard?.writeText(prompt).catch(() => {});
};

/** The newest debug session of the project that is live and takes messages. */
async function debugSession(projectId: string): Promise<Session | null> {
  const listed = await readQuery('session.list', { project_id: projectId });
  if (!listed.ok || !Array.isArray(listed.value)) return null;
  const board = useBoard.getState().board?.sessions ?? [];
  const found = (listed.value as WorkbenchSession[])
    .filter((s) => s.app_debug && !s.archived_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((s) => board.find((session) => session.id === s.id))
    .find((session) => session !== undefined && canMessage(session));
  return found ?? null;
}

/**
 * Sends the error, with what the app knows around it, to the Pantheon repository's debug session,
 * opening one when there is none; copies the report where no debug session can reach this app.
 * False when the upload or the send failed, so the report is neither sent nor copied.
 */
export async function askDebugAgent({
  title,
  detail,
  images,
  error,
}: {
  title: string;
  detail?: string;
  /** The recorded entry the report is about, set apart from the recent ones. */
  error?: AppError;
  /** PNG data URLs, attached to the message; dropped when the report is copied. */
  images?: readonly string[];
}): Promise<boolean> {
  const prompt = await debugPrompt(title, detail, error);
  const target = window.pantheon ? await debugTarget() : null;
  if (!target) {
    await copied(prompt);
    toast({
      title: t({ id: 'data.askDebug.copied', defaultMessage: 'Copied the error report' }),
    });
    return true;
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
    return true;
  }
  const attachments: string[] = [];
  for (const [index, image] of (images ?? []).entries()) {
    const bytes = Uint8Array.from(atob(image.slice(image.indexOf(',') + 1)), (c) =>
      c.charCodeAt(0),
    );
    const uploaded = await window.pantheon!.attachFile(
      project.id,
      `debug-${index + 1}.png`,
      'image/png',
      bytes,
    );
    if (!uploaded.ok) {
      toast({ title: failureText(uploaded.error), kind: 'failure', askAgent: false });
      return false;
    }
    attachments.push(uploaded.value.id);
  }
  const session = await debugSession(project.id);
  // The daemon picks no runtime of its own, so a new session takes the defaults the new-session box does.
  const read = session ? null : await readQuery('project.defaults', {});
  const defaults = effectiveSessionDefaults(
    project,
    read?.ok ? (read.value as ProjectDefaultsRead) : null,
  );
  const runtime = defaultRuntime([], defaults?.runtime);
  const result: BridgeResult<unknown> = session
    ? await askFix(
        session.id,
        session.state,
        session.revision,
        [{ id: `app-debug:${Date.now()}`, kind: 'reference', label: title, text: prompt }],
        attachments,
      )
    : await runCommand(
        'session.create',
        {
          project_id: project.id,
          input: prompt,
          purpose: 'app_debug',
          runtime,
          ...(attachments.length ? { attachments } : {}),
          ...(defaults?.runtime === runtime
            ? {
                ...(defaults.model ? { model: defaults.model } : {}),
                ...(defaults.effort ? { effort: defaults.effort } : {}),
                permission_mode: defaults.permission_mode,
              }
            : {}),
        },
        null,
      );
  if (!result.ok) {
    toast({ title: failureText(result.error), kind: 'failure', askAgent: false });
    return false;
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
  return true;
}
