// Answers MCP initialize and tools/call over stdio; the first argument selects ok, error, silent or exit.
import { createInterface } from 'node:readline';

const mode = process.argv[2];
if (mode === 'exit') {
  process.stderr.write('fake server refused to start\n');
  process.exit(4);
}
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
let initialized = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'notifications/initialized') initialized = true;
  if (frame.id === undefined || mode === 'silent') return;
  if (frame.method === 'initialize')
    send({
      id: frame.id,
      result: {
        protocolVersion: frame.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      },
    });
  else if (frame.method === 'tools/call' && !initialized)
    send({ id: frame.id, error: { code: -32600, message: 'not initialized' } });
  else if (frame.method === 'tools/call')
    send({
      id: frame.id,
      result: {
        ...(mode === 'error' ? { isError: true } : {}),
        content: [
          {
            type: 'text',
            text: `${frame.params.name} ${JSON.stringify(frame.params.arguments)} token=${process.env.FAKE_TOKEN} pid=${process.pid}`,
          },
        ],
      },
    });
  else send({ id: frame.id, error: { code: -32601, message: 'not in the fake' } });
});
