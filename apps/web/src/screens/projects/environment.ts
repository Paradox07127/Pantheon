import { t } from '../../i18n';

/** One editable environment variable; id keeps the row's identity while rows move. */
export type EnvRow = { id: number; key: string; value: string };

/** The editable form of a project's folders and environment variables. */
export type EnvironmentDraft = { roots: string[]; env: EnvRow[] };

export type Environment = { roots: string[]; env: Record<string, string> };

export type EnvironmentCheck = {
  roots: (string | null)[];
  rows: (string | null)[];
  environment: Environment | null;
};

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

const trimRoot = (root: string): string => root.replace(/[\\/]+$/, '');
const sameRoot = (a: string, b: string): boolean => trimRoot(a) === trimRoot(b);
const inside = (inner: string, outer: string): boolean => {
  const [a, b] = [trimRoot(inner), trimRoot(outer)];
  return a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
};

/** Why root cannot join the listed folders: it repeats, lies inside or contains one of them. */
function rootError(root: string, listed: readonly string[]): string | null {
  if (listed.some((r) => sameRoot(r, root)))
    return t({ id: 'projects.folders.listed', defaultMessage: 'Already in the list' });
  if (listed.some((r) => inside(root, r)))
    return t({
      id: 'projects.folders.insideListed',
      defaultMessage: 'Inside a folder in the list',
    });
  if (listed.some((r) => inside(r, root)))
    return t({
      id: 'projects.folders.containsListed',
      defaultMessage: 'Contains a folder in the list',
    });
  return null;
}

export const envRows = (env: Record<string, string> | undefined): EnvRow[] =>
  Object.entries(env ?? {}).map(([key, value], id) => ({ id, key, value }));

export const draftOf = (project: {
  roots?: string[];
  env?: Record<string, string>;
}): EnvironmentDraft => ({
  roots: [...(project.roots ?? [])],
  env: envRows(project.env),
});

export const addEnvRow = (rows: readonly EnvRow[]): EnvRow[] => [
  ...rows,
  { id: Math.max(-1, ...rows.map((r) => r.id)) + 1, key: '', value: '' },
];

/** Rows with a key, trimmed; rows with neither key nor value are left out. */
export const envRecord = (rows: readonly EnvRow[]): Record<string, string> =>
  Object.fromEntries(
    rows.flatMap((row) => (row.key.trim() ? [[row.key.trim(), row.value] as const] : [])),
  );

/** Appends the chosen folders in order; one that repeats or nests with the list is skipped. */
export function addRoots(
  roots: readonly string[],
  paths: readonly string[],
): { roots: string[]; rejected: { path: string; error: string }[] } {
  const next = [...roots];
  const rejected: { path: string; error: string }[] = [];
  for (const path of paths) {
    const error = rootError(path, next);
    if (error) rejected.push({ path, error });
    else next.push(path);
  }
  return { roots: next, rejected };
}

/** Per folder, why it cannot stay: it repeats or nests with a folder listed before it. */
export const rootErrors = (roots: readonly string[]): (string | null)[] =>
  roots.map((root, i) => rootError(root, roots.slice(0, i)));

/** Errors per folder and per variable row; environment is set only with a folder and no errors. */
export function checkEnvironment(draft: EnvironmentDraft): EnvironmentCheck {
  const roots = rootErrors(draft.roots);
  const seen = new Set<string>();
  const rows = draft.env.map((row) => {
    const key = row.key.trim();
    if (!key)
      return row.value
        ? t({ id: 'projects.variables.nameMissing', defaultMessage: 'Variable name missing' })
        : null;
    if (!ENV_KEY.test(key))
      return t({
        id: 'projects.variables.nameInvalid',
        defaultMessage:
          "A variable name can only contain letters, digits and underscores, and can't start with a digit",
      });
    if (seen.has(key))
      return t({
        id: 'projects.variables.nameRepeated',
        defaultMessage: 'Duplicate variable name',
      });
    seen.add(key);
    return null;
  });
  const valid =
    draft.roots.length > 0 && roots.every((e) => e === null) && rows.every((e) => e === null);
  return {
    roots,
    rows,
    environment: valid ? { roots: [...draft.roots], env: envRecord(draft.env) } : null,
  };
}

/** Whether name and environment match what the project has saved; variable order is ignored. */
export function sameEnvironment(
  project: { name: string; roots?: string[]; env?: Record<string, string> },
  name: string,
  environment: Environment,
): boolean {
  const roots = project.roots ?? [];
  const env = project.env ?? {};
  const keys = Object.keys(environment.env);
  return (
    project.name === name &&
    roots.length === environment.roots.length &&
    roots.every((r, i) => r === environment.roots[i]) &&
    keys.length === Object.keys(env).length &&
    keys.every((k) => env[k] === environment.env[k])
  );
}

/** project.open with the environment's folders; empty variables are left out. */
export const openRequest = (name: string, environment: Environment) => ({
  type: 'project.open' as const,
  input: {
    name,
    roots: environment.roots,
    ...(Object.keys(environment.env).length > 0 && { env: environment.env }),
  },
  expected_revision: null,
});

/** project.environment.set replaces name, folders and variables at the project's revision. */
export const environmentSetRequest = (
  project: { id: string; revision: number },
  name: string,
  environment: Environment,
) => ({
  type: 'project.environment.set' as const,
  input: {
    project_id: project.id,
    name,
    roots: environment.roots,
    env: environment.env,
  },
  expected_revision: project.revision,
});
