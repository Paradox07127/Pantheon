import * as appReopenRecovery from './app-reopen-recovery.mjs';
import * as commandDedupRevisions from './command-dedup-revisions.mjs';
import * as conductorSpawnReviewLand from './conductor-spawn-review-land.mjs';
import * as daemonCrashRecovery from './daemon-crash-recovery.mjs';
import * as eventResumeBackpressure from './event-resume-backpressure.mjs';
import * as firstRunImport from './first-run-import.mjs';
import * as folderSessionLanding from './folder-session-landing.mjs';
import * as nativeRuntimeAdmission from './native-runtime-admission.mjs';
import * as nativeSessionRecovery from './native-session-recovery.mjs';
import * as nativeExtensionIsolation from './native-extension-isolation.mjs';
import * as repositoryFixtureReproducibility from './repository-fixture-reproducibility.mjs';
import * as reviewIsolationFindings from './review-isolation-findings.mjs';
import * as storageCrashRecovery from './storage-crash-recovery.mjs';

export const scenarios = new Map();
for (const scenario of [
  repositoryFixtureReproducibility,
  storageCrashRecovery,
  commandDedupRevisions,
  eventResumeBackpressure,
  reviewIsolationFindings,
  daemonCrashRecovery,
  appReopenRecovery,
  nativeRuntimeAdmission,
  nativeSessionRecovery,
  nativeExtensionIsolation,
  firstRunImport,
  folderSessionLanding,
  conductorSpawnReviewLand,
]) {
  if (scenarios.has(scenario.title)) throw new Error(`Duplicate scenario title: ${scenario.title}`);
  scenarios.set(scenario.title, scenario);
}
