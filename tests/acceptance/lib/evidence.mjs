import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeEvidence(evidenceDir, contents) {
  const evidence = [];
  for (const [name, value] of Object.entries(contents)) {
    const file = path.resolve(evidenceDir, name);
    await writeFile(
      file,
      typeof value === 'string' || value instanceof Uint8Array
        ? value
        : JSON.stringify(value, null, 2) + '\n',
    );
    evidence.push({ name, path: file });
  }
  return evidence;
}
