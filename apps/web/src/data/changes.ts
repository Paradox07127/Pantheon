import type { Review, ReviewFinding } from '@pantheon/domain';
import type { ChangeRow, ProjectChanges } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';
import { STREAM_KINDS } from './sync';
import { useNewestEvent, useQuery, useRefetchTick } from './workbench-sessions';

export type { ChangeRow };

/** The list's filters: every row, or the rows of one status. */
export type ChangeFilter = 'all' | 'ready' | 'needs_you' | 'merged';

export const CHANGE_FILTERS: readonly ChangeFilter[] = ['all', 'ready', 'needs_you', 'merged'];

const isChanges = (value: unknown): boolean =>
  Array.isArray((value as Partial<ProjectChanges> | null)?.changes);

/** The project's changes: sessions with work to land and branch landings no session owns. */
export function useProjectChanges(projectId: string | null) {
  return useProjectQuery<ProjectChanges>('project.changes', projectId, isChanges);
}

/** The rows newest `updated_at` first. */
export const sortChanges = (rows: readonly ChangeRow[]): ChangeRow[] =>
  [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));

export const inFilter = (row: ChangeRow, filter: ChangeFilter): boolean =>
  filter === 'all' || row.status === filter;

/** The session a row stands for; null on a branch landing. */
export const changeSessionId = (row: ChangeRow): string | null =>
  row.id.startsWith('session:') ? row.id.slice('session:'.length) : null;

/** The landing a branch row stands for; null on a session row. */
export const changeLandingId = (row: ChangeRow): string | null =>
  row.id.startsWith('landing:') ? row.id.slice('landing:'.length) : null;

const reviewParams = (review_id: string) => ({ review_id });
const acceptReview = (value: unknown): Review | null =>
  Array.isArray((value as Partial<Review> | null)?.findings) ? (value as Review) : null;

/** One review with its findings; read again after the review's own events. */
export function useReview(reviewId: string | null) {
  const last = useNewestEvent(reviewId, (e) => reviewId !== null && e.aggregate_id === reviewId);
  const tick = useRefetchTick(last?.sequence ?? 0, STREAM_KINDS.has(last?.kind ?? ''));
  return useQuery('review.read', reviewId, reviewParams, acceptReview, tick);
}

/** The files the guide lists by risk. */
export const GUIDE_FILES = 8;

export interface FileRisk {
  path: string;
  blocking: number;
  reports: number;
}

export interface ReviewGuideModel {
  /** Open blocking findings, in the review's order. */
  blocking: ReviewFinding[];
  /** Open findings that do not block. */
  reports: number;
  /** Files by open blocking findings, then by reports; at most GUIDE_FILES. */
  files: FileRisk[];
  /** Files left out of `files`. */
  more: number;
}

const isOpen = (finding: ReviewFinding): boolean =>
  finding.status === 'open' && !finding.resolution;

/** The path of a `path:line` location; the whole location when it has no line. */
export const locationPath = (location: string): string => location.replace(/:\d+(?::\d+)?$/, '');

/** What to read first: open blocking findings, the count of reports, and the riskiest files. */
export function reviewGuide(review: Pick<Review, 'findings'>): ReviewGuideModel {
  const open = review.findings.filter(isOpen);
  const byPath = new Map<string, FileRisk>();
  for (const finding of open) {
    const path = locationPath(finding.location);
    const risk = byPath.get(path) ?? { path, blocking: 0, reports: 0 };
    if (finding.blocking) risk.blocking++;
    else risk.reports++;
    byPath.set(path, risk);
  }
  const files = [...byPath.values()].sort(
    (a, b) => b.blocking - a.blocking || b.reports - a.reports,
  );
  const blocking = open.filter((finding) => finding.blocking);
  return {
    blocking,
    reports: open.length - blocking.length,
    files: files.slice(0, GUIDE_FILES),
    more: Math.max(0, files.length - GUIDE_FILES),
  };
}
