import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Project, Review, Session } from '@pantheon/domain';
import { inside, projectFolders, resolvedPath, type ControlContext } from './context.js';
import { reviewerDirectory } from './review.js';

/** The existing reviews folders of a project, one per project folder in the managed roots. */
function reviewsRoots(ctx: ControlContext, projectId: string): string[] {
  // Each folder as its parent and its name, so the parent is resolved and the name checked.
  const folders: [string, string][] = ctx.workspaceRoot
    ? projectFolders(ctx, projectId).map((folder) => [path.dirname(folder), path.basename(folder)])
    : [[path.dirname(ctx.files.directory), '']];
  return folders.flatMap(([parent, name]) => {
    try {
      const base = realpathSync(parent),
        expected = path.join(base, name, 'reviews'),
        root = realpathSync(expected);
      // A symlinked reviews path could point recovery at any directory under the managed root.
      if (root !== expected || !inside(base, root) || !lstatSync(root).isDirectory()) return [];
      return [root];
    } catch {
      return [];
    }
  });
}

export function removeReviewDirectories(
  ctx: ControlContext,
  reviewId: string,
  jobId: string,
): void {
  ctx.store.transaction(() => {
    const skip = () => ctx.store.mark(jobId, 'done'),
      review = ctx.store.get<Review>('reviews', reviewId);
    if (!review || review.state === 'running') return skip();
    const sessions = review.session_ids.map((sessionId) =>
      ctx.store.get<Session>('sessions', sessionId),
    );
    if (
      sessions.some(
        (session) =>
          !session ||
          session.review_id !== review.id ||
          session.project_id !== review.project_id ||
          session.state !== 'closed',
      ) ||
      ctx.store
        .list<Session>('sessions')
        .some((session) => session.review_id === review.id && session.state !== 'closed')
    )
      return skip();
    const root = reviewsRoots(ctx, review.project_id).find((candidate) =>
      existsSync(path.join(candidate, review.id)),
    );
    if (!root) return skip();
    const parent = path.join(root, review.id);
    if (path.dirname(parent) !== root || path.basename(parent) !== review.id) return skip();
    try {
      if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) return skip();
    } catch {
      return skip();
    }
    const paths: string[] = [];
    for (const session of sessions) {
      if (!session) continue;
      const directory = reviewerDirectory(ctx, review.project_id, review.id, session.id),
        expected = path.join(parent, session.id);
      if (path.dirname(expected) !== parent || path.basename(expected) !== session.id) continue;
      try {
        const target = resolvedPath(directory);
        if (!inside(root, target) || target !== expected || !lstatSync(directory).isDirectory())
          continue;
      } catch {
        continue;
      }
      rmSync(directory, { recursive: true, force: true });
      paths.push(directory);
    }
    try {
      rmdirSync(parent);
      paths.push(parent);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
    if (paths.length)
      ctx.store.event('review.directories_removed', review, review.project_id, { paths });
    ctx.store.mark(jobId, 'done');
  });
}

/** The caller owns the startup transaction. */
export function recoverReviewDirectories(ctx: ControlContext): void {
  const reviews = ctx.store.list<Review>('reviews'),
    pending = new Set(
      ctx.store
        .pending()
        .filter((job) => job.kind === 'review.remove')
        .map((job) => (JSON.parse(job.payload) as { review_id: string }).review_id),
    );
  for (const review of reviews) {
    if (review.state === 'running' || pending.has(review.id)) continue;
    if (
      reviewsRoots(ctx, review.project_id).some((root) => existsSync(path.join(root, review.id))) ||
      review.session_ids.some((sessionId) => {
        const session = ctx.store.get<Session>('sessions', sessionId);
        return (
          session !== undefined &&
          existsSync(reviewerDirectory(ctx, review.project_id, review.id, session.id))
        );
      })
    )
      ctx.store.enqueue('review.remove', { review_id: review.id });
  }
  const ids = new Set(reviews.map((review) => review.id)),
    roots = new Set(
      ctx.workspaceRoot
        ? ctx.store.list<Project>('projects').flatMap((project) => reviewsRoots(ctx, project.id))
        : reviewsRoots(ctx, ''),
    ),
    paths: string[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || ids.has(entry.name)) continue;
      const directory = path.join(root, entry.name),
        target = realpathSync(directory);
      if (!inside(root, target) || target !== directory) continue;
      rmSync(directory, { recursive: true, force: true });
      paths.push(directory);
    }
  }
  if (paths.length)
    ctx.store.event('review.orphans_removed', { id: 'reviews', revision: 1 }, '', { paths });
}
