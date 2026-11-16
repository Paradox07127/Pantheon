import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  defaultStoreDir,
  sha256File,
  writeJsonAtomic,
} from '../tests/acceptance/lib/human-review.mjs';

const usage = 'usage: node scripts/acceptance-review.mjs [--store <dir>] <case-id>';

async function main(args) {
  let storeDir = defaultStoreDir;
  if (args[0] === '--store' && args.length > 1) {
    storeDir = path.resolve(args[1]);
    args = args.slice(2);
  }
  if (args.length !== 1 || args[0].startsWith('--')) {
    console.error(usage);
    return 64;
  }
  const caseId = args[0];

  const requestPath = path.join(storeDir, `${caseId}.request.json`);
  let request;
  try {
    request = JSON.parse(await readFile(requestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(`no review request at ${requestPath}`);
    return 64;
  }

  const rl = createInterface({ input: process.stdin });
  // The iterator buffers lines, so answers piped in all at once are not lost between prompts.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    if (done) process.stdout.write('\n');
    return done ? '' : value.trim();
  };
  try {
    console.log(`case: ${request.case.id} ${request.case.title}`);
    console.log(`check_spec_hash: ${request.check_spec_hash}`);
    console.log(`build_manifest_sha256: ${request.build_manifest_sha256}`);
    const items = [];
    for (const item of request.items) {
      const sha256 = await sha256File(item.path);
      console.log(`\nname: ${item.name}\npath: ${item.path}\nsha256: ${sha256}`);
      const answer = (await ask(`Confirm ${item.name}? [y/N] `)).toLowerCase();
      items.push({ name: item.name, sha256, confirmed: answer === 'y' || answer === 'yes' });
    }
    const confirmedBy = await ask('Reviewer name: ');
    if (confirmedBy === '') {
      console.error('reviewer name is required; no receipt written');
      return 64;
    }

    const receiptPath = path.join(storeDir, `${caseId}.json`);
    await writeJsonAtomic(receiptPath, {
      check_spec_hash: request.check_spec_hash,
      build_manifest_sha256: request.build_manifest_sha256,
      items,
      confirmed_by: confirmedBy,
      confirmed_at: new Date().toISOString(),
    });
    console.log(`receipt written to ${receiptPath}`);
    const rejected = items.filter((item) => !item.confirmed).map((item) => item.name);
    if (rejected.length === 0) return 0;
    console.error(`not confirmed: ${rejected.join(', ')}`);
    return 1;
  } finally {
    rl.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
