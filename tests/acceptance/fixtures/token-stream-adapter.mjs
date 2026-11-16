import { FixtureAdapter } from '@pantheon/adapters';

/**
 * The fixture runtime, plus a virtual token stream: a turn input of `token-stream`, then
 * `{"count","size"}` on the next line, streams that many text deltas of that many characters.
 * The stored turn input stays this short; only the runtime sees the expanded script.
 */
export class TokenStreamAdapter extends FixtureAdapter {
  send(handle, turn) {
    const [marker, line] = turn.input.split('\n');
    if (marker !== 'token-stream') return super.send(handle, turn);
    const { count, size } = JSON.parse(line);
    const steps = Array.from({ length: count }, (_, index) => ({
      say: `${index} `.padEnd(size, 'x'),
    }));
    return super.send(handle, { ...turn, input: `fixture-script\n${JSON.stringify(steps)}` });
  }
}
