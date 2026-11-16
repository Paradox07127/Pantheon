import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultStoreDir = fileURLToPath(
  new URL('../../../.notes/evidence/human-review', import.meta.url),
);
const reviewScript = fileURLToPath(
  new URL('../../../scripts/acceptance-review.mjs', import.meta.url),
);

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

export async function sha256File(file) {
  return sha256hex(await readFile(file));
}

export async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await rename(temp, file);
}

export function verifyReceipt(receipt, request) {
  const reasons = [];
  for (const field of ['check_spec_hash', 'build_manifest_sha256']) {
    if (receipt?.[field] !== request[field])
      reasons.push(
        `${field} differs: receipt has ${receipt?.[field]}, this run has ${request[field]}`,
      );
  }
  const receiptItems = Array.isArray(receipt?.items) ? receipt.items : [];
  for (const item of request.items) {
    const confirmed = receiptItems.find((r) => r.name === item.name);
    if (!confirmed)
      reasons.push(`item ${item.name} is missing: receipt has none, this run has ${item.sha256}`);
    else if (confirmed.sha256 !== item.sha256)
      reasons.push(
        `item ${item.name} sha256 differs: receipt has ${confirmed.sha256}, this run has ${item.sha256}`,
      );
    else if (confirmed.confirmed !== true)
      reasons.push(
        `item ${item.name} is not confirmed: receipt has confirmed ${confirmed.confirmed}, this run requires true`,
      );
  }
  for (const item of receiptItems) {
    if (!request.items.some((r) => r.name === item.name))
      reasons.push(
        `item ${item.name} is not requested: receipt has sha256 ${item.sha256}, this run has no such item`,
      );
  }
  if (typeof receipt?.confirmed_by !== 'string' || receipt.confirmed_by.trim() === '')
    reasons.push(
      `confirmed_by is empty: receipt has ${JSON.stringify(receipt?.confirmed_by)}, this run requires a reviewer name`,
    );
  if (typeof receipt?.confirmed_at !== 'string' || Number.isNaN(Date.parse(receipt.confirmed_at)))
    reasons.push(
      `confirmed_at is not a valid time: receipt has ${JSON.stringify(receipt?.confirmed_at)}, this run requires an ISO time`,
    );
  return reasons;
}

async function checkReceipt(receiptPath, request) {
  let text;
  try {
    text = await readFile(receiptPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { reasons: [`receipt ${receiptPath} does not exist`] };
  }
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch (error) {
    return { reasons: [`receipt ${receiptPath} is not valid JSON: ${error.message}`] };
  }
  return { receipt, reasons: verifyReceipt(receipt, request) };
}

// items: [{ name, path }]; waitMs: how long to keep polling for a valid receipt, 0 reads once.
export async function requireHumanReview({
  spec,
  buildManifestSha256,
  items,
  storeDir,
  waitMs,
  pollMs = 500,
}) {
  const request = {
    case: { id: spec.id, title: spec.title },
    check_spec_hash: sha256hex(JSON.stringify(spec)),
    build_manifest_sha256: buildManifestSha256,
    items: [],
    created_at: new Date().toISOString(),
  };
  for (const item of items) {
    const file = path.resolve(item.path);
    request.items.push({ name: item.name, path: file, sha256: await sha256File(file) });
  }
  await mkdir(storeDir, { recursive: true });
  await writeJsonAtomic(path.join(storeDir, `${spec.id}.request.json`), request);

  const receiptPath = path.join(storeDir, `${spec.id}.json`);
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const { receipt, reasons } = await checkReceipt(receiptPath, request);
    if (reasons.length === 0) return { ok: true, reasons, receipt };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reasons.push(`no valid receipt within ${waitMs} ms`);
      for (const reason of reasons) process.stderr.write(`human review: ${reason}\n`);
      return { ok: false, reasons, receipt: undefined };
    }
    if (!announced) {
      process.stderr.write(
        `human review: waiting ${waitMs / 1000} s for receipt ${receiptPath}; run: node ${reviewScript} --store ${storeDir} ${spec.id}\n`,
      );
      announced = true;
    }
    await delay(Math.min(pollMs, remaining));
  }
}
