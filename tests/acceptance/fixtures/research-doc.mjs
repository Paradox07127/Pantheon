import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

// Group 1 is the source id, group 2 the verbatim quote; quotes cannot contain a double quote.
const CITATION_PATTERN = String.raw`\[\[([a-z0-9-]+):"([^"]+)"\]\]`;

const QUESTION = `# Question

Should the offline-first notes app store notes in SQLite or in IndexedDB on desktop clients?
`;

const TEMPLATE = `# Storage decision for the offline-first notes app

Every section below is required. Each factual claim must cite a source by id with a verbatim quote.

## Question

## Findings

## Recommendation

## Open judgments
`;

const SOURCES = {
  'indexeddb-quota-guide': `# Browser storage quota guide (excerpt)

Browsers may evict IndexedDB data for an origin when the device runs low on disk space.
Persistent storage must be requested explicitly, and the browser may refuse the request.
`,
  'sqlite-wal-notes': `# SQLite write-ahead logging notes (excerpt)

In WAL mode, readers do not block the writer and the writer does not block readers.
A checkpoint copies committed pages from the WAL file back into the main database file.
`,
  'sync-incident-review': `# Sync incident review (excerpt)

Two clients wrote the same note while offline, and the last upload silently replaced the other edit.
The review recommends keeping a per-note revision counter to detect conflicting writes.
`,
};

const REQUIRED_JUDGMENTS = [
  {
    id: 'accept-eviction-risk',
    statement: 'Whether losing locally cached notes to browser eviction is acceptable for users.',
  },
  {
    id: 'approve-native-dependency',
    statement: 'Whether shipping a native SQLite binary with the desktop client is approved.',
  },
];

const draft = (walCitation) => `# Storage decision for the offline-first notes app

## Question

Should the offline-first notes app store notes in SQLite or in IndexedDB on desktop clients?

## Findings

- IndexedDB data is not guaranteed to stay on disk: [[indexeddb-quota-guide:"Browsers may evict IndexedDB data for an origin when the device runs low on disk space."]]
- SQLite lets the sync worker write while the editor reads: ${walCitation}
- Either engine needs conflict detection: [[sync-incident-review:"keeping a per-note revision counter to detect conflicting writes"]]

## Recommendation

Use SQLite on desktop clients and add a per-note revision counter.

## Open judgments

- accept-eviction-risk: pending a human decision.
- approve-native-dependency: pending a human decision.
`;

const WAL_CITATION_VERBATIM = `[[sqlite-wal-notes:"readers do not block the writer and the writer does not block readers"]]`;
// Paraphrased, so the quote does not occur in the source.
const WAL_CITATION_PARAPHRASED = `[[sqlite-wal-notes:"readers and writers never block each other"]]`;

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export async function createResearchDoc(root) {
  root = path.resolve(root);
  const dir = path.join(root, 'doc');
  await mkdir(path.join(dir, 'sources'), { recursive: true });
  await mkdir(path.join(dir, 'drafts'));

  const question = path.join(dir, 'question.md');
  const template = path.join(dir, 'template.md');
  const required_judgments = path.join(dir, 'required-judgments.json');
  const complete = path.join(dir, 'drafts', 'complete.md');
  const missing_citation = path.join(dir, 'drafts', 'missing-citation.md');
  await writeFile(question, QUESTION);
  await writeFile(template, TEMPLATE);
  await writeFile(required_judgments, `${JSON.stringify(REQUIRED_JUDGMENTS, null, 2)}\n`);
  await writeFile(complete, draft(WAL_CITATION_VERBATIM));
  await writeFile(missing_citation, draft(WAL_CITATION_PARAPHRASED));

  const sources = [];
  for (const id of Object.keys(SOURCES).sort()) {
    const file = path.join(dir, 'sources', `${id}.md`);
    await writeFile(file, SOURCES[id]);
    sources.push({ id, path: file });
  }

  const files = [];
  for (const file of await listFiles(root)) {
    files.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      sha256: sha256hex(await readFile(file)),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = sha256hex(JSON.stringify({ files }));

  return {
    dir,
    question,
    template,
    sources,
    required_judgments,
    drafts: { complete, missing_citation },
    citation_pattern: CITATION_PATTERN,
    hash,
  };
}
