import type { ProjectIntroRead } from '@pantheon/protocol';
import { REPOSITORY_KINDS, sendProjectCommand, useProjectQuery } from './project-read';

export type { ProjectIntroRead };
export type ProjectIntro = NonNullable<ProjectIntroRead['intro']>;

const isIntroRead = (value: unknown): boolean => {
  const read = value as Partial<ProjectIntroRead> | null;
  const intro = read?.intro;
  return (
    !!read &&
    (read.behind === null || typeof read.behind === 'number') &&
    (read.writing_session_id === null || typeof read.writing_session_id === 'string') &&
    (intro === null ||
      (typeof intro?.summary === 'string' &&
        Array.isArray(intro.sources) &&
        Array.isArray(intro.features) &&
        Array.isArray(intro.modules) &&
        Array.isArray(intro.languages) &&
        Array.isArray(intro.weeks) &&
        Array.isArray(intro.heads)))
  );
};

/** Events that write the introduction, start or end a writing turn, or move a root's commits. */
const INTRO_KINDS: ReadonlySet<string> = new Set([
  'project.intro.written',
  'session.opened',
  'turn.queued',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  ...REPOSITORY_KINDS,
]);

/** GET /v1/project.intro.read: the saved introduction, read again after the events that change it. */
export function useIntroRead(project_id: string | null) {
  return useProjectQuery<ProjectIntroRead>(
    'project.intro.read',
    project_id,
    isIntroRead,
    undefined,
    { kinds: INTRO_KINDS },
  );
}

/** Starts an introduction session; its events move the board, so the read follows. */
export const startIntro = (project_id: string) =>
  sendProjectCommand('project.intro.start', { project_id }, null);
