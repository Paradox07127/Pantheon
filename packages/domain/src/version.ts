import { globSync, readFileSync, statSync } from 'node:fs';

/** The Pantheon release version. The release step sets it in every package.json of the workspace. */
export const PANTHEON_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Newest compiled JS in the daemon and its Pantheon packages, in a checkout or desktop install. */
export function daemonBuildTime(daemon: URL): number {
  const packages = new URL('node_modules/@pantheon/', daemon);
  const roots = [
    new URL('dist/', daemon),
    ...globSync('*', { cwd: packages }).map((name) => new URL(`${name}/dist/`, packages)),
  ];
  return Math.max(
    0,
    ...roots.flatMap((root) =>
      globSync('**/*.js', { cwd: root }).map(
        // A rebuild can delete a listed file before it is read.
        (file) => statSync(new URL(file, root), { throwIfNoEntry: false })?.mtimeMs ?? 0,
      ),
    ),
  );
}
