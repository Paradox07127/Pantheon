import type { TaskKind } from '@pantheon/domain';

const rootConfig = (file: string) =>
  !file.includes('/') && (/\.(json|ya?ml|toml)$/.test(file) || file.startsWith('.'));

/** True when the path is the directory or lies under it. */
const under = (file: string, directory: string) =>
  file === directory || file.startsWith(`${directory}/`);

/** One rule a line, tried in order; a rule matches when every path passes it. */
const DOMAIN_RULES: [TaskKind['domain'], (file: string) => boolean][] = [
  ['frontend-ui', (file) => under(file, 'apps/web/src')],
  ['script-infra', (file) => under(file, 'scripts') || under(file, '.github') || rootConfig(file)],
  ['docs-chore', (file) => file.endsWith('.md')],
];

/** `apps/<name>` or `packages/<name>`; undefined for a path outside every package. */
const packageOf = (file: string) => /^(?:apps|packages)\/[^/]+(?=\/|$)/.exec(file)?.[0];

/** A last segment without a name and an extension names a directory, which holds any number of files. */
const directory = (file: string) => !/[^/]\.[^./]+$/.test(file);

/** Whether the text names migrations, authentication, concurrency, a public API or secrets. */
export const risky = (text: string) =>
  /(?:^|[^a-z])(?:migrat(?:e|ion)s?|auth(?:entication|orization)?|concurren(?:cy|t)|public[\s/_-]*api|secrets?)(?=$|[^a-z])|迁移|认证|并发|公开\s*api|密钥/i.test(
    text,
  );

/** The kind of a change to these repository paths; undefined when there are none. */
export function kindOfPaths(scope: string[]): TaskKind | undefined {
  if (!scope.length) return undefined;
  const paths = scope.map((file) => file.replace(/\/+$/, ''));
  const domain = DOMAIN_RULES.find(([, matches]) => paths.every(matches))?.[0] ?? 'backend-logic';
  const packages = new Set(paths.map(packageOf).filter((name) => name !== undefined));
  const tier =
    paths.some(risky) || packages.size > 1
      ? 't3'
      : paths.length <= 2 && !paths.some(directory)
        ? 't1'
        : 't2';
  return { domain, tier };
}
