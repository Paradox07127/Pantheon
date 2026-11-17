import type { SignalIssue } from '@pantheon/domain';
import { useProjectQuery, type ProjectReadState } from './project-read';

/** An issue as signal.list returns it, without its samples. */
export type ListedSignal = Omit<SignalIssue, 'samples' | 'recent'>;

const SIGNAL_KINDS: ReadonlySet<string> = new Set(['signal_issue.changed']);

/** The project's signal issues of every state, newest signal first; read again on each change. */
export const useSignalIssues = (
  projectId: string | null,
): Omit<ProjectReadState, 'read'> & { read: ListedSignal[] | null } =>
  useProjectQuery<ListedSignal[]>('signal.list', projectId, Array.isArray, undefined, {
    kinds: SIGNAL_KINDS,
  });
