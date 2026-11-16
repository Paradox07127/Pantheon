import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(check, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

export async function subscribeEvents(daemon, cursor, project_id, receive = () => {}) {
  const socket = new WebSocket(daemon.url.replace(/^http/, 'ws') + '/v1/events/ws');
  const frames = [];
  let ended;
  const closed = new Promise((resolve) =>
    socket.addEventListener('close', (event) => {
      ended = { code: event.code, reason: event.reason };
      resolve(ended);
    }),
  );
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data));
    frames.push(frame);
    receive(frame);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.send(JSON.stringify({ token: daemon.token, cursor, project_id }));
  return {
    frames,
    closed,
    get ended() {
      return ended;
    },
    waitFor: (check) => waitFor(() => check(frames), 'event stream frames'),
    async close() {
      socket.close(1000);
      await closed;
    },
  };
}

export function createEventProjection({ dropRepeatedSequences = true } = {}) {
  let cursor = 0,
    board,
    events = [],
    droppedIds = 0,
    droppedSequences = 0,
    maxEvents = 0,
    maxSeen = 0;
  const seen = new Set(),
    presentations = new Map(),
    delivered = new Set(),
    snapshots = [];
  return {
    get cursor() {
      return cursor;
    },
    snapshot(value) {
      board = value;
      cursor = board.cursor;
      events = [];
      seen.clear();
      snapshots.push(value);
    },
    refresh(value) {
      board = value;
    },
    receive(frame) {
      if (frame.type !== 'event') return;
      const event = frame.event;
      if (seen.has(event.event_id)) {
        droppedIds++;
        return;
      }
      if (dropRepeatedSequences && event.sequence <= cursor) {
        droppedSequences++;
        return;
      }
      seen.add(event.event_id);
      events.push(event);
      cursor = event.sequence;
      delivered.add(event.event_id);
      presentations.set(event.sequence, (presentations.get(event.sequence) ?? 0) + 1);
      if (events.length > 2000)
        for (const old of events.splice(0, events.length - 2000)) seen.delete(old.event_id);
      maxEvents = Math.max(maxEvents, events.length);
      maxSeen = Math.max(maxSeen, seen.size);
    },
    coverage(event) {
      if (delivered.has(event.event_id)) return 'replay';
      return snapshots.some((snapshot) =>
        Object.values(snapshot).some(
          (rows) =>
            Array.isArray(rows) &&
            rows.some(
              (row) => row.id === event.aggregate_id && row.revision >= event.aggregate_revision,
            ),
        ),
      )
        ? 'snapshot'
        : 'missing';
    },
    inspect() {
      return {
        cursor,
        board,
        snapshots,
        logical_items: presentations.size,
        duplicate_logical_items: [...presentations.values()].reduce(
          (sum, count) => sum + count - 1,
          0,
        ),
        dropped_event_ids: droppedIds,
        dropped_sequences: droppedSequences,
        max_buffered_events: maxEvents,
        max_seen_event_ids: maxSeen,
      };
    },
  };
}

/**
 * A subscriber on a plain TCP socket that can stop reading: pause() leaves the daemon's frames
 * in the kernel and in the daemon's own send buffer, as a client that has stopped consuming does.
 */
export async function slowEventSocket(daemon, cursor, project_id) {
  const { hostname, port } = new URL(daemon.url);
  const socket = net.connect(Number(port), hostname);
  await once(socket, 'connect');
  socket.write(
    [
      'GET /v1/events/ws HTTP/1.1',
      `Host: ${hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  const frames = [];
  let buffer = Buffer.alloc(0),
    upgraded = false,
    bytes = 0,
    ended,
    settle;
  const closed = new Promise((resolve) => (settle = resolve));
  const finish = (value) => {
    if (ended) return;
    ended = value;
    settle(value);
  };
  socket.on('close', () => finish({ code: 1006, reason: 'socket closed' }));
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    bytes += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const head = buffer.indexOf('\r\n\r\n');
      if (head === -1) return;
      if (!buffer.subarray(0, head).toString().startsWith('HTTP/1.1 101'))
        return finish({ code: 0, reason: buffer.subarray(0, head).toString() });
      upgraded = true;
      buffer = buffer.subarray(head + 4);
    }
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f,
        offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) frames.push(JSON.parse(payload.toString('utf8')));
      if (opcode === 8) {
        finish({
          code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
          reason: payload.subarray(2).toString('utf8'),
        });
        socket.destroy();
        return;
      }
    }
  });
  // Client frames are masked (RFC 6455, 5.3).
  const text = Buffer.from(JSON.stringify({ token: daemon.token, cursor, project_id }));
  const mask = randomBytes(4);
  const header =
    text.length < 126
      ? Buffer.from([0x81, 0x80 | text.length])
      : Buffer.from([0x81, 0x80 | 126, text.length >> 8, text.length & 0xff]);
  socket.write(
    Buffer.concat([header, mask, Buffer.from(text.map((byte, index) => byte ^ mask[index % 4]))]),
  );
  return {
    frames,
    closed,
    get ended() {
      return ended;
    },
    get bytes() {
      return bytes;
    },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    destroy: () => socket.destroy(),
  };
}
