import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scenarios } from './scenarios/index.mjs';
import { writeEvidence } from './lib/evidence.mjs';
import { buildManifest, productVersion } from './lib/build-manifest.mjs';
import { defaultStoreDir, requireHumanReview } from './lib/human-review.mjs';

export async function runCase({ spec, workspace, evidenceDir, reviewStore = defaultStoreDir }) {
  const scenario = scenarios.get(spec.title);
  if (!scenario) {
    const error = new Error(`NOT_IMPLEMENTED: product driver does not implement ${spec.id}`);
    error.code = 'NOT_IMPLEMENTED';
    throw error;
  }
  if (scenario.mode !== spec.mode)
    throw new Error(`Scenario mode ${scenario.mode} does not match ${spec.id} mode ${spec.mode}`);
  const manifest = await buildManifest(fileURLToPath(new URL('../../', import.meta.url)));
  const [manifestEvidence] = await writeEvidence(evidenceDir, { 'build-manifest.json': manifest });
  const buildManifestSha256 = createHash('sha256')
    .update(await readFile(manifestEvidence.path))
    .digest('hex');
  const humanReview = (items, { waitMs = 0 } = {}) =>
    requireHumanReview({ spec, buildManifestSha256, items, storeDir: reviewStore, waitMs });
  const result = await scenario.run({ spec, workspace, evidenceDir, humanReview });
  const evidence = await writeEvidence(evidenceDir, result.evidence);
  evidence.push(manifestEvidence);
  return {
    observations: result.observations,
    evidence,
    provenance: {
      kind: spec.mode,
      product_version: productVersion(manifest),
      build_manifest_sha256: buildManifestSha256,
      adapters: result.adapters,
      devices: [{ platform: process.platform, arch: process.arch, node: process.version }],
    },
  };
}
