import type { ProjectIntroRead } from '@pantheon/protocol';
import { sendProjectCommand, useProjectQuery } from './project-read';

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

/** GET /v1/project.intro.read: the saved introduction, read again whenever the board moves. */
export function useIntroRead(project_id: string | null) {
  return useProjectQuery<ProjectIntroRead>('project.intro.read', project_id, isIntroRead);
}

/** Starts an introduction session; its events move the board, so the read follows. */
export const startIntro = (project_id: string) =>
  sendProjectCommand('project.intro.start', { project_id }, null);
