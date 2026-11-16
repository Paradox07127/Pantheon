/** A change's added and removed line counts; a zero count is muted and an unknown one left out. */
export function DiffCounts({
  additions,
  deletions,
}: {
  additions: number | null | undefined;
  deletions: number | null | undefined;
}) {
  return (
    <>
      {additions != null && (
        <span className="df-add" data-zero={additions === 0 || undefined}>
          {`+${additions}`}
        </span>
      )}
      {additions != null && deletions != null && ' '}
      {deletions != null && (
        <span className="df-del" data-zero={deletions === 0 || undefined}>
          {`−${deletions}`}
        </span>
      )}
    </>
  );
}
