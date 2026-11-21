import * as appDailyLoop from './app-daily-loop.mjs';
import * as appReopenRecovery from './app-reopen-recovery.mjs';
import * as approvalTimerRecovery from './approval-timer-recovery.mjs';
import * as cancelLateEvents from './cancel-late-events.mjs';
import * as changedGoalGeneration from './changed-goal-generation.mjs';
import * as codexSmoke from './codex-smoke.mjs';
import * as codexZeroClick from './codex-zero-click.mjs';
import * as commandDedupRevisions from './command-dedup-revisions.mjs';
import * as daemonCrashRecovery from './daemon-crash-recovery.mjs';
import * as documentTaskHumanAcceptance from './document-task-human-acceptance.mjs';
import * as eventResumeBackpressure from './event-resume-backpressure.mjs';
import * as firstRunImport from './first-run-import.mjs';
import * as folderSessionLanding from './folder-session-landing.mjs';
import * as gateVersionBinding from './gate-version-binding.mjs';
import * as nativeRuntimeAdmission from './native-runtime-admission.mjs';
import * as nativeSessionRecovery from './native-session-recovery.mjs';
import * as nativeExtensionIsolation from './native-extension-isolation.mjs';
import * as repositoryFixtureReproducibility from './repository-fixture-reproducibility.mjs';
import * as residentAssistant from './resident-assistant.mjs';
import * as reviewIsolationFindings from './review-isolation-findings.mjs';
import * as runtimeHandoff from './runtime-handoff.mjs';
import * as steerAndDelivery from './steer-and-delivery.mjs';
import * as storageCrashRecovery from './storage-crash-recovery.mjs';
import * as workbenchLoop from './workbench-loop.mjs';
import * as workbenchScreens from './workbench-screens.mjs';
import * as zeroClickLoop from './zero-click-loop.mjs';

export const scenarios = new Map();
for (const scenario of [
  repositoryFixtureReproducibility,
  workbenchLoop,
  codexSmoke,
  zeroClickLoop,
  codexZeroClick,
  storageCrashRecovery,
  commandDedupRevisions,
  eventResumeBackpressure,
  steerAndDelivery,
  changedGoalGeneration,
  gateVersionBinding,
  runtimeHandoff,
  reviewIsolationFindings,
  documentTaskHumanAcceptance,
  daemonCrashRecovery,
  cancelLateEvents,
  approvalTimerRecovery,
  appReopenRecovery,
  nativeRuntimeAdmission,
  nativeSessionRecovery,
  workbenchScreens,
  nativeExtensionIsolation,
  appDailyLoop,
  firstRunImport,
  residentAssistant,
  folderSessionLanding,
]) {
  if (scenarios.has(scenario.title)) throw new Error(`Duplicate scenario title: ${scenario.title}`);
  scenarios.set(scenario.title, scenario);
}
