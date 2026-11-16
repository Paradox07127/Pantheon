import { readFileSync } from 'node:fs';

/** The Pantheon release version. The release step sets it in every package.json of the workspace. */
export const PANTHEON_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
