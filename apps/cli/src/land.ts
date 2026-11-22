import type { Landing } from '@pantheon/domain';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import {
  currentBranch,
  poll,
  projectRoot,
  sendCommand,
  sharedRef,
  usageError,
  type Daemon,
} from './review.js';

export const landUsage = 'land [BRANCH] [--message TEXT] [--allow-gate-change]';

const gateState = (gate: NonNullable<Landing['gate_results']>[number]) =>
  gate.state ?? (gate.exit_code === 0 ? 'passed' : 'failed');

/** The line that starts a gate search of the project, ready to run. */
const findGate = (projectId: string) =>
  `Find gate commands: pantheon command --json '${JSON.stringify(
    command(USER_PRINCIPAL_ID, 'project.baseline.start', { project_id: projectId }),
  )}'`;

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The line that lands the branch again, letting it change the files that protect the gate. */
const allowGateChange = (branch: string, message: string | undefined) =>
  `Land with the gate files changed: pantheon land ${quote(branch)}${
    message === undefined ? '' : ` --message=${quote(message)}`
  } --allow-gate-change`;

export const land = async (
  connect: () => Daemon,
  positionals: string[],
  values: { message?: string; 'allow-gate-change'?: boolean },
) => {
  if (positionals.length > 1) usageError(`Usage: pantheon ${landUsage}`);
  const branch = positionals[0]
    ? sharedRef(positionals[0])
    : (currentBranch() ?? usageError('HEAD is detached; name the branch to land.'));
  const root = projectRoot(),
    daemon = connect();
  const sent = await sendCommand(
    daemon,
    'project.land',
    {
      root,
      branch,
      ...(values.message === undefined ? {} : { message: values.message }),
      ...(values['allow-gate-change'] ? { allow_gate_change: true } : {}),
    },
    5000,
  );
  if (!sent.ok) {
    console.error(JSON.stringify(sent.body, null, 2));
    const refusal = sent.body as { error?: string; details?: { project_id: string } };
    if (refusal.error === 'no_gate_commands') console.error(findGate(refusal.details!.project_id));
    return 1;
  }
  const started = sent.body.receipt as Landing;
  console.error(`Landing ${started.id} ${started.state}`);
  let state = started.state,
    gates = 0;
  const result = await poll<Landing>(
    daemon,
    'project.landing.read',
    'landing_id',
    started.id,
    (value) => ['landed', 'no_changes', 'blocked'].includes(value.state),
    (value) => {
      if (value.state !== state) console.error(`Landing ${value.state}`);
      state = value.state;
      const results = value.gate_results ?? [];
      for (const [index, gate] of results.slice(gates).entries())
        console.error(
          `gate ${gates + index + 1} ${gate.name} ${gateState(gate)} ${(gate.duration_ms / 1000).toFixed(1)}s`,
        );
      gates = results.length;
    },
  );
  if (result.state === 'landed') {
    console.log(
      `landed ${result.branch} onto ${result.target_branch} ${result.from_sha?.slice(0, 8)}..${result.to_sha?.slice(0, 8)}`,
    );
    return 0;
  }
  if (result.state === 'no_changes') {
    console.log(`no changes: ${result.branch} is already in ${result.target_branch}`);
    return 0;
  }
  console.log(`blocked: ${result.reason}`);
  if (result.reason === 'no_gate_commands') console.log(findGate(result.project_id));
  for (const gate of result.gate_results ?? [])
    if (gateState(gate) === 'failed') console.log(`gate ${gate.name} failed:\n${gate.output}`);
  if (result.conflicts?.length) console.log(`conflicts:\n${result.conflicts.join('\n')}`);
  if (result.reason === 'gate_files_changed') console.log(allowGateChange(branch, values.message));
  return 1;
};
