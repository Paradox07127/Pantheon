import { splitPath } from '../data/format';

/** Gives the last two path segments space first, with the full path available in the title. */
export function PathText({ path, className }: { path: string; className?: string }) {
  const [head, tail] = splitPath(path);
  return (
    <span className={className ? `path ${className}` : 'path'} title={path}>
      <span>{head}</span>
      <span>
        <bdi dir="ltr">{tail}</bdi>
      </span>
    </span>
  );
}
