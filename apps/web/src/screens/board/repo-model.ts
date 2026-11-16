import type { ProjectFactsRead } from '@pantheon/protocol';

export type RepoFacts = NonNullable<ProjectFactsRead['facts']>;

const DAY = 86_400_000;
const SERIES_COLORS = 6;
export const HOTSPOT_ROWS = 10;
/** Docs untouched for longer than this count as stale. */
export const STALE_DOC_DAYS = 90;

export interface RepoSeries {
  key: string;
  label: string;
  color: string;
}

/** The last segment of a folder root. */
export const folderName = (root: string) =>
  root
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || root;

const gitFolders = (facts: RepoFacts) => facts.folders.filter((f) => f.git);

/** A folder's relative path, led by the folder's name when the project has more than one. */
const pathLabel = (facts: RepoFacts, root: string, path: string) =>
  facts.folders.length > 1 ? `${folderName(root)}/${path}` : path;

/** One category color per Git folder in folder order; folders without Git have no series. */
export function repoSeries(facts: RepoFacts): RepoSeries[] {
  return gitFolders(facts).map((f, i) => ({
    key: f.root,
    label: folderName(f.root),
    color: `var(--series-${(i % SERIES_COLORS) + 1})`,
  }));
}

export interface CommitDay {
  day: string;
  parts: { series: RepoSeries; count: number }[];
  total: number;
}

/** Each day's commits stacked by Git folder, in date order. */
export function commitDays(facts: RepoFacts): { series: RepoSeries[]; days: CommitDay[] } {
  const series = repoSeries(facts);
  const counts = gitFolders(facts).map(
    (f) => new Map(f.commits_per_day.map((d) => [d.date, d.count])),
  );
  const dates = [...new Set(counts.flatMap((c) => [...c.keys()]))].sort();
  const days = dates.map((day) => {
    const parts = series.map((s, i) => ({ series: s, count: counts[i]!.get(day) ?? 0 }));
    return { day, parts, total: parts.reduce((sum, p) => sum + p.count, 0) };
  });
  return { series, days };
}

export interface HotspotRow {
  key: string;
  path: string;
  label: string;
  commits: number;
  /** Commits against the top row's. */
  share: number;
  series: RepoSeries;
}

/** The most committed paths across Git folders; ties keep folder order. */
export function hotspotRows(facts: RepoFacts): HotspotRow[] {
  const series = repoSeries(facts);
  const rows = gitFolders(facts)
    .flatMap((f, i) =>
      f.hotspots.map((h) => ({
        key: `${f.root}\0${h.path}`,
        path: h.path,
        label: pathLabel(facts, f.root, h.path),
        commits: h.commits,
        series: series[i]!,
      })),
    )
    .sort((a, b) => b.commits - a.commits)
    .slice(0, HOTSPOT_ROWS);
  const max = rows[0]?.commits ?? 0;
  return rows.map((r) => ({ ...r, share: max ? r.commits / max : 0 }));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local "YYYY-MM-DD". */
export function dateText(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DocRow {
  key: string;
  path: string;
  label: string;
  date: string;
  age_days: number;
  /** Age against the oldest doc's. */
  share: number;
  stale: boolean;
}

/** Every folder's docs, oldest first. */
export function docRows(facts: RepoFacts, now: number): DocRow[] {
  const docs = facts.folders
    .flatMap((f) => f.docs.map((d) => ({ root: f.root, ...d })))
    .sort((a, b) => a.modified_at - b.modified_at);
  const ages = docs.map((d) => Math.max(0, now - d.modified_at));
  const max = Math.max(0, ...ages);
  return docs.map((d, i) => ({
    key: `${d.root}\0${d.path}`,
    path: d.path,
    label: pathLabel(facts, d.root, d.path),
    date: dateText(d.modified_at),
    age_days: Math.floor(ages[i]! / DAY),
    share: max ? ages[i]! / max : 0,
    stale: ages[i]! > STALE_DOC_DAYS * DAY,
  }));
}
