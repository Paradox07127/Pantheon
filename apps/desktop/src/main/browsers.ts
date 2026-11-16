import { statSync } from 'node:fs';
import path from 'node:path';
import { applicationRoots } from './editors.js';

const KNOWN_BROWSERS = [
  'Safari',
  'Google Chrome',
  'Arc',
  'Firefox',
  'Microsoft Edge',
  'Brave Browser',
];

export const browserRoots = (): string[] => [...applicationRoots(), '/System/Applications'];

export interface Browser {
  id: string;
  name: string;
  path: string;
}

export function scanBrowsers(roots: string[]): Browser[] {
  return KNOWN_BROWSERS.flatMap((id) => {
    for (const root of roots) {
      const bundle = path.join(root, `${id}.app`);
      try {
        if (statSync(bundle, { throwIfNoEntry: false })?.isDirectory())
          return [{ id, name: id, path: bundle }];
      } catch {
        // An unreadable bundle (EACCES, ELOOP) is not installed in this root.
      }
    }
    return [];
  });
}
