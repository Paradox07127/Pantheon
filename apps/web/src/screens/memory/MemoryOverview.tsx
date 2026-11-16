import { useState, type ReactNode } from 'react';
import { Skeleton } from '../../components/Skeleton';
import { useBaselineRead } from '../../data/baseline-read';
import { useBoard } from '../../data/board';
import { useIntroRead } from '../../data/intro-read';
import { useNow } from '../../data/needs-you';
import { useProjectHead } from '../../data/runtime-models';
import { IntroView } from '../board/IntroView';
import { ProjectProfile } from './ProjectProfile';
import './memory-overview.css';

/** The memory overview: the project profile, then the memory panel, then the introduction. */
export function MemoryOverview({
  projectId,
  baseline,
  memory,
}: {
  projectId: string;
  /** The board's baseline start, passed on to the introduction. */
  baseline?: { busy: boolean; onStart: () => void };
  /** The memory panel; it calls `onHold(true)` while its first reads are out. */
  memory: (onHold: (held: boolean) => void) => ReactNode;
}) {
  const project = useBoard((s) => s.board?.projects.find((p) => p.id === projectId) ?? null);
  const introRead = useIntroRead(projectId);
  const assessedRead = useBaselineRead(projectId);
  const headRead = useProjectHead(projectId);
  const now = useNow(60_000);
  // Held until the panel's layout effect reports, which is before the first paint.
  const [held, setHeld] = useState(true);
  // The page draws once, when every block's first reads are in, so no block pushes another down.
  const [drawn, setDrawn] = useState(false);
  const ready =
    drawn || (!held && !introRead.loading && !assessedRead.loading && !headRead.loading);
  if (ready && !drawn) setDrawn(true);
  const intro = introRead.read?.intro ?? null;
  const assessed = assessedRead.read;
  const head = headRead.read;
  const folders = assessed?.state === 'confirmed' ? (assessed.result?.folders ?? []) : [];
  const stack = [...new Set(folders.flatMap((folder) => folder.stack ?? []))];
  return (
    <>
      {!ready && (
        <div className="mo-pg">
          <Skeleton />
        </div>
      )}
      {/* Kept mounted while hidden, so the memory panel's reads run. */}
      <div className="mo-pg" hidden={!ready}>
        {ready && project && (
          <ProjectProfile
            id={project.id}
            name={project.name}
            summary={intro?.summary ?? null}
            sources={intro?.sources ?? []}
            base={project.roots[0]}
            branch={head?.branch ?? null}
            committedAt={head?.committed_at ?? null}
            now={now}
            stack={stack}
            languages={intro?.languages ?? []}
          />
        )}
        {memory(setHeld)}
        {ready && <IntroView key={projectId} projectId={projectId} baseline={baseline} />}
      </div>
    </>
  );
}
