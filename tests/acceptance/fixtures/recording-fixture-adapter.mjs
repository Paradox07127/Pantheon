import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { FixtureAdapter } from '@pantheon/adapters';

/** Orders the records of every adapter in this process against each other. */
let sequence = 0;

/**
 * The fixture runtime under a name of its own that keeps what the daemon hands it: each session
 * spec, native start and close, and turn input. `input` may replace a turn's input before the
 * fixture runs it.
 */
export class RecordingFixtureAdapter extends FixtureAdapter {
  specs = new Map();
  starts = [];
  closes = [];
  sends = [];
  #input;
  #forged;

  constructor(name, { input } = {}) {
    super();
    this.name = name;
    this.#input = input;
  }

  /** The next native start reports this native session id instead of a new one. */
  forgeNextStart(nativeSessionId) {
    this.#forged = nativeSessionId;
  }

  async start(spec, emit) {
    this.specs.set(spec.platform_session_id, spec);
    const forged = this.#forged;
    this.#forged = undefined;
    const handle = forged ? await this.resume(spec, forged, emit) : await super.start(spec, emit);
    this.starts.push({
      sequence: ++sequence,
      session_id: spec.platform_session_id,
      native_session_id: handle.native_session_id,
      forged: Boolean(forged),
    });
    return handle;
  }

  async send(handle, turn) {
    const session_id = handle.platform_session_id;
    this.sends.push({ sequence: ++sequence, session_id, turn_id: turn.turn_id, input: turn.input });
    const input = this.#input
      ? await this.#input({ session_id, input: turn.input, spec: this.specs.get(session_id) })
      : turn.input;
    return super.send(handle, { ...turn, input });
  }

  async close(handle, deadline) {
    const receipt = await super.close(handle, deadline);
    this.closes.push({
      sequence: ++sequence,
      session_id: handle.platform_session_id,
      native_session_id: handle.native_session_id,
      stopped: receipt.stopped,
    });
    return receipt;
  }
}

/** The path with its longest existing ancestor resolved through links. */
const realTarget = (target) => {
  const absolute = path.resolve(target);
  const parent = path.dirname(absolute);
  return existsSync(absolute) || parent === absolute
    ? realpathSync(absolute)
    : path.join(realTarget(parent), path.basename(absolute));
};
const covers = (root, target) => {
  const relative = path.relative(realTarget(root), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Reads the file as the fixture runtime would under the session's sandbox: a read_write denial
 * over the path refuses it; a session without a sandbox reads what the user can.
 */
export async function sandboxedRead(spec, file) {
  const target = realTarget(file);
  const denied = spec?.sandbox?.protected_entries.some(
    (entry) => entry.deny === 'read_write' && covers(entry.path, target),
  );
  if (denied) return { read: false };
  return { read: true, text: await readFile(target, 'utf8') };
}
