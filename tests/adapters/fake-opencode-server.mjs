// A scripted OpenCode 2 CLI. `--version` prints FAKE_OPENCODE_VERSION (2.3.2 when unset); `serve`
// runs an HTTP server on the given loopback port that checks Basic credentials against
// OPENCODE_PASSWORD, or against FAKE_OPENCODE_SERVER_PASSWORD when set, and answers the session
// routes the adapter uses. FAKE_OPENCODE_LOG records the launch and every request. The prompt text
// picks the script: hold, steer, permission (a bash request, or an edit request with edit), form,
// drop, fail, title, child; anything else says hello. A request goes to the client only when the
// session's permission rules ask for it; the last matching rule wins, and no match allows it.
// Session ids starting with ses_saved exist on every server, as a shared database would keep them.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(process.env.FAKE_OPENCODE_VERSION ?? '2.3.2');
  process.exit(0);
}
if (args[0] !== 'serve') {
  console.error(`fake opencode: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
const log = process.env.FAKE_OPENCODE_LOG;
const record = (entry) => log && appendFileSync(log, JSON.stringify(entry) + '\n');
const password = process.env.FAKE_OPENCODE_SERVER_PASSWORD ?? process.env.OPENCODE_PASSWORD;
const expected = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
// A tool process in the server's process group.
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

let counter = 0;
const next = (prefix) => `${prefix}_${++counter}`;
const sessions = new Map();
const clients = new Set();
// Durable events published while no stream was open; the next stream gets them again.
let missed;

function publish(type, data, durable = true) {
  const event = {
    id: next('evt'),
    created: Date.now(),
    type,
    data,
    ...(durable ? { durable: { aggregateID: data.sessionID, seq: counter, version: 1 } } : {}),
  };
  if (missed && durable) missed.push(event);
  for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

function sessionInfo(id, body = {}) {
  return {
    id,
    projectID: 'prj_fake',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
    location: body.location ?? { directory: process.cwd() },
    ...(body.title ? { title: body.title } : {}),
    model: body.model ?? { id: 'fake-model', providerID: 'fake' },
  };
}

function effect(rules, action) {
  return (
    (rules ?? []).findLast((rule) => rule.action === '*' || rule.action === action)?.effect ??
    'allow'
  );
}

function getSession(id) {
  if (!sessions.has(id) && id.startsWith('ses_saved'))
    sessions.set(id, {
      info: sessionInfo(id, { title: 'Saved' }),
      messages: [],
      permissions: new Map(),
      forms: new Map(),
    });
  return sessions.get(id);
}

async function run(session, text) {
  const sessionID = session.info.id;
  const exec = { interrupt: deferred(), steer: deferred() };
  session.exec = exec;
  const assistant = {
    id: next('msg'),
    type: 'assistant',
    agent: 'build',
    model: session.info.model,
    content: [],
    time: { created: Date.now() },
  };
  const part = (type, chunks) => {
    // OpenCode numbers text and reasoning parts separately within a message.
    const ordinal = assistant.content.filter((item) => item.type === type).length;
    const item = { type, text: '' };
    assistant.content.push(item);
    const base = { sessionID, assistantMessageID: assistant.id, ordinal };
    publish(`session.${type}.started`, base);
    for (const delta of chunks) {
      item.text += delta;
      publish(`session.${type}.delta`, { ...base, delta }, false);
    }
    return () => publish(`session.${type}.ended`, { ...base, text: item.text });
  };
  const say = (type, chunks) => part(type, chunks)();
  const endStep = () => {
    assistant.time.completed = Date.now();
    assistant.finish = 'stop';
    assistant.cost = 0.01;
    assistant.tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };
    publish('session.step.ended', {
      sessionID,
      assistantMessageID: assistant.id,
      finish: 'stop',
      cost: assistant.cost,
      tokens: assistant.tokens,
    });
  };
  const finish = (outcome, extra = {}) => {
    session.messages.push({
      id: next('msg'),
      time: { created: Date.now() },
      type: 'idle',
      outcome,
    });
    publish(`session.execution.${outcome}`, { sessionID, ...extra });
    publish('session.idle', { sessionID }, false);
    session.exec = undefined;
  };
  publish('session.execution.started', { sessionID });
  session.messages.push(assistant);
  publish('session.step.started', {
    sessionID,
    assistantMessageID: assistant.id,
    agent: 'build',
    model: session.info.model,
    started: Date.now(),
  });
  if (text.includes('hold')) {
    say('text', ['Working']);
    await exec.interrupt.promise;
    finish('interrupted', { reason: 'user' });
    return;
  }
  if (text.includes('steer')) {
    say('text', ['Waiting']);
    const steered = await exec.steer.promise;
    say('text', [`Steered: ${steered}`]);
    endStep();
    finish('succeeded');
    return;
  }
  if (text.includes('permission')) {
    const edit = text.includes('edit');
    const request = {
      id: next('per'),
      sessionID,
      action: edit ? 'edit' : 'bash',
      resources: [edit ? 'probe.txt' : 'ls -la'],
      source: { type: 'tool', messageID: assistant.id, id: edit ? 'call_edit' : 'call_bash' },
    };
    const ruled = effect(session.rules, request.action);
    if (ruled !== 'ask') {
      say('text', [`${ruled} by rule`]);
      endStep();
      finish('succeeded');
      return;
    }
    const answered = deferred();
    session.permissions.set(request.id, { request, answered });
    publish('permission.asked', request, false);
    const reply = await answered.promise;
    session.permissions.delete(request.id);
    publish(
      'permission.replied',
      { sessionID, requestID: request.id, reply: reply.decision },
      false,
    );
    say('text', [reply.message ? `${reply.decision}: ${reply.message}` : reply.decision]);
    endStep();
    finish('succeeded');
    return;
  }
  if (text.includes('form')) {
    const form = {
      id: next('frm'),
      sessionID,
      title: 'Choose',
      fields: [
        {
          key: 'color',
          type: 'string',
          title: 'Which color?',
          options: [
            { value: 'r', label: 'Red' },
            { value: 'b', label: 'Blue' },
          ],
        },
        { key: 'sure', type: 'boolean', title: 'Sure?' },
      ],
    };
    const answered = deferred();
    session.forms.set(form.id, { form, answered });
    publish('form.created', { form }, false);
    const answer = await answered.promise;
    session.forms.delete(form.id);
    say('text', [JSON.stringify(answer)]);
    endStep();
    finish('succeeded');
    return;
  }
  if (text.includes('drop')) {
    const ended = part('text', ['Part one ']);
    publish('session.tool.input.started', {
      sessionID,
      assistantMessageID: assistant.id,
      id: 'call_read',
      name: 'read',
    });
    const tool = {
      type: 'tool',
      id: 'call_read',
      name: 'read',
      state: { status: 'running', input: { path: 'a.txt' }, metadata: {} },
      time: { created: Date.now() },
    };
    publish('session.tool.called', {
      sessionID,
      assistantMessageID: assistant.id,
      id: 'call_read',
      input: { path: 'a.txt' },
      executed: true,
    });
    // The stream breaks; the rest happens before any client can reconnect.
    for (const res of clients) res.end();
    clients.clear();
    missed = [];
    assistant.content.push(tool);
    tool.state = {
      status: 'completed',
      input: { path: 'a.txt' },
      content: [{ type: 'text', text: 'A' }],
    };
    publish('session.tool.success', {
      sessionID,
      assistantMessageID: assistant.id,
      id: 'call_read',
      content: tool.state.content,
      executed: true,
    });
    assistant.content[0].text += 'and part two';
    ended();
    endStep();
    finish('succeeded');
    return;
  }
  if (text.includes('fail')) {
    finish('failed', { error: { type: 'APIError', message: 'Provider refused the request' } });
    return;
  }
  if (text.includes('title')) {
    session.info.title = 'Fake title';
    publish('session.renamed', { sessionID, title: 'Fake title' });
  }
  if (text.includes('child')) {
    const child = next('ses');
    // OpenCode copies the parent's rules into a child once, at creation.
    sessions.set(child, {
      info: sessionInfo(child, { location: session.info.location }),
      messages: [],
      permissions: new Map(),
      forms: new Map(),
      rules: session.rules,
    });
    publish('session.created', {
      sessionID: child,
      parentID: sessionID,
      projectID: 'prj_fake',
      location: session.info.location,
      slug: 'child',
      title: 'Explore the code',
      agent: 'explore',
      version: '2.3.2',
    });
    publish('session.execution.started', { sessionID: child });
    publish('session.execution.succeeded', { sessionID: child });
  }
  say('reasoning', ['Thinking']);
  say('text', ['Hel', 'lo']);
  endStep();
  finish('succeeded');
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text ? JSON.parse(text) : undefined));
  });
}

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const body = await readBody(req);
  const authorized = req.headers.authorization === expected;
  record({
    kind: 'request',
    method: req.method,
    path: url.pathname,
    query: url.search,
    body,
    authorized,
  });
  if (!authorized) return send(res, 401, { _tag: 'UnauthorizedError', message: 'Unauthorized' });
  const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
  const route = `${req.method} /${parts.map((part, index) => (index === 2 && parts[1] === 'session' ? ':id' : part)).join('/')}`;
  const session = parts[1] === 'session' && parts[2] ? getSession(parts[2]) : undefined;
  if (parts[1] === 'session' && parts[2] && parts[2] !== 'active' && !session)
    return send(res, 404, {
      _tag: 'SessionNotFoundError',
      sessionID: parts[2],
      message: 'Not found',
    });
  if (route === 'GET /api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      `event: server.connected\ndata: ${JSON.stringify({ id: next('evt'), type: 'server.connected', data: {} })}\n\n`,
    );
    clients.add(res);
    req.on('close', () => clients.delete(res));
    if (missed) {
      for (const event of missed)
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      missed = undefined;
    }
    return;
  }
  if (route === 'GET /api/info')
    return send(res, 200, { version: '2.3.2', pid: process.pid, urls: [], paths: { tmp: '/tmp' } });
  if (route === 'GET /api/session') return send(res, 200, { data: [], cursor: {} });
  if (route === 'POST /api/session') {
    const id = next('ses');
    sessions.set(id, {
      info: sessionInfo(id, body),
      messages: [],
      permissions: new Map(),
      forms: new Map(),
      rules: body.permissions,
    });
    publish('session.created', {
      sessionID: id,
      projectID: 'prj_fake',
      location: body.location,
      slug: 'fake',
      version: '2.3.2',
    });
    return send(res, 200, { data: sessions.get(id).info });
  }
  if (route === 'GET /api/session/:id') return send(res, 200, { data: session.info });
  if (route === 'PATCH /api/session/:id') {
    if (body.permissions !== undefined) session.rules = body.permissions;
    return send(res, 204);
  }
  if (route === 'POST /api/session/:id/model') {
    session.info.model = body.model;
    return send(res, 204);
  }
  if (route === 'POST /api/session/:id/prompt') {
    const id = next('msg');
    const delivery = body.delivery ?? 'queue';
    session.messages.push({ id, time: { created: Date.now() }, type: 'user', text: body.text });
    send(res, 200, {
      data: {
        id,
        sessionID: session.info.id,
        time: { created: Date.now() },
        type: 'user',
        payload: { text: body.text },
        delivery,
      },
    });
    if (delivery === 'steer' && session.exec) session.exec.steer.resolve(body.text);
    else setImmediate(() => void run(session, body.text));
    return;
  }
  if (route === 'POST /api/session/:id/interrupt') {
    const running = session.exec;
    running?.interrupt.resolve();
    return send(res, 200, { interrupted: Boolean(running) });
  }
  if (route.startsWith('DELETE /api/session/:id/inbox/')) return send(res, 204);
  if (route === 'GET /api/session/:id/message') {
    const order = url.searchParams.get('order') ?? 'asc';
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const list = order === 'desc' ? [...session.messages].reverse() : session.messages;
    const page = list.slice(start, start + limit);
    return send(res, 200, {
      data: page,
      cursor: { next: start + limit < list.length ? String(start + limit) : null },
    });
  }
  if (route === 'GET /api/session/:id/permission')
    return send(res, 200, {
      data: [...session.permissions.values()].map(({ request }) => request),
    });
  if (route === 'GET /api/session/:id/form')
    return send(res, 200, { data: [...session.forms.values()].map(({ form }) => form) });
  if (parts[3] === 'permission' && parts[5] === 'reply' && req.method === 'POST') {
    const pending = session.permissions.get(parts[4]);
    if (!pending)
      return send(res, 404, {
        _tag: 'PermissionNotFoundError',
        requestID: parts[4],
        message: 'Not found',
      });
    pending.answered.resolve(body);
    return send(res, 204);
  }
  if (parts[3] === 'form' && parts[4]) {
    const pending = session.forms.get(parts[4]);
    if (!pending)
      return send(res, 404, { _tag: 'FormNotFoundError', id: parts[4], message: 'Not found' });
    if (req.method === 'POST' && parts[5] === 'reply') pending.answered.resolve(body.answer);
    else if (req.method === 'DELETE')
      pending.answered.resolve({ cancelled: url.searchParams.get('message') ?? true });
    return send(res, 204);
  }
  if (route === 'GET /api/model')
    return send(res, 200, {
      location: { directory: process.cwd() },
      data: [
        {
          id: 'fake-model',
          modelID: 'fake-model',
          providerID: 'fake',
          name: 'Fake model',
          enabled: true,
          variants: [{ id: 'low' }, { id: 'high' }],
        },
        {
          id: 'other-model',
          modelID: 'other-model',
          providerID: 'fake',
          name: 'Other model',
          enabled: true,
          variants: [],
        },
      ],
    });
  if (route === 'GET /api/model/default')
    return send(res, 200, {
      location: { directory: process.cwd() },
      data: {
        id: 'fake-model',
        modelID: 'fake-model',
        providerID: 'fake',
        name: 'Fake model',
        variants: [],
      },
    });
  send(res, 404, { _tag: 'NotFound', message: `No route ${route}` });
});

const hostname = args[args.indexOf('--hostname') + 1];
const port = Number(args[args.indexOf('--port') + 1]);
server.listen(port, hostname, () => {
  const address = server.address();
  record({
    kind: 'launch',
    argv: args,
    cwd: process.cwd(),
    port: address.port,
    helper: helper.pid,
    config: process.env.OPENCODE_CONFIG_CONTENT,
    password: Boolean(process.env.OPENCODE_PASSWORD),
  });
  console.log(`server listening on http://${hostname}:${address.port}`);
});
