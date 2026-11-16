import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readShellPrefsPatch } from '../../apps/desktop/src/main/settings.js';
import {
  readVoiceLine,
  VoiceRecognizer,
  type VoiceEvent,
} from '../../apps/desktop/src/main/voice.js';
import { eventually } from '../helpers.js';

const ELECTRON = '../../apps/desktop/node_modules/electron/index.js';
type Handler = (...args: any[]) => unknown;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-voice-test-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Writes an engine that speaks the engine contract and logs what happens to it in <root>/engine.log.
 * With --file it gives the file's text as final; else it runs body with out, lines and log in scope.
 */
function fakeEngine(
  root: string,
  body: string,
  name = 'engine',
): { engine: string; log: () => string[] } {
  const engine = path.join(root, name);
  const logFile = path.join(root, 'engine.log');
  writeFileSync(
    engine,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const log = (line) => fs.appendFileSync(${JSON.stringify(logFile)}, line + '\\n');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
log('start ' + args.join(' '));
process.on('SIGTERM', () => {
  log('terminated');
  process.exit(143);
});
if (arg('--file')) {
  out({ type: 'ready' });
  out({ type: 'final', text: fs.readFileSync(arg('--file'), 'utf8') });
  process.exit(0);
}
fs.writeFileSync(arg('--record'), 'recorded words');
const lines = require('node:readline').createInterface({ input: process.stdin });
${body}
`,
  );
  chmodSync(engine, 0o755);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n') : []);
  return { engine, log };
}

const dictation = `
out({ type: 'ready' });
process.stdout.write('not json\\n');
out({ type: 'level', value: 7 });
out({ type: 'partial' });
out({ type: 'error', code: 'mystery', message: 'unknown' });
out({ type: 'level', value: 0.42 });
out({ type: 'partial', text: 'hello', extra: true });
lines.on('line', (line) => {
  if (line !== 'stop') return;
  out({ type: 'final', text: 'hello world' });
  process.exit(0);
});
`;
const crash = `
out({ type: 'ready' });
setTimeout(() => process.exit(3), 50);
`;

/** The --record path of the engine's nth start in its log. */
const recordOf = (log: string[], nth = 0) => {
  const start = log.filter((line) => line.startsWith('start '))[nth]!.split(' ');
  return start[start.indexOf('--record') + 1]!;
};

describe('voice engine output', () => {
  it('reads the six events and refuses lines outside the contract', () => {
    expect(readVoiceLine('{"type":"preparing","progress":0.5}')).toEqual({
      type: 'preparing',
      progress: 0.5,
    });
    expect(readVoiceLine('{"type":"preparing"}')).toEqual({ type: 'preparing' });
    expect(readVoiceLine('{"type":"ready"}')).toEqual({ type: 'ready' });
    expect(readVoiceLine('{"type":"level","value":0.42}')).toEqual({ type: 'level', value: 0.42 });
    expect(readVoiceLine('{"type":"partial","text":"今天"}')).toEqual({
      type: 'partial',
      text: '今天',
    });
    expect(readVoiceLine('{"type":"final","text":"今天开会"}')).toEqual({
      type: 'final',
      text: '今天开会',
    });
    expect(
      readVoiceLine('{"type":"error","code":"microphone_denied","message":"no microphone"}'),
    ).toEqual({ type: 'error', code: 'microphone_denied', message: 'no microphone' });
    for (const line of [
      '',
      'hello',
      'null',
      '[]',
      '{"type":"preparing","progress":2}',
      '{"type":"level","value":-0.1}',
      '{"type":"level"}',
      '{"type":"partial","text":3}',
      '{"type":"final"}',
      '{"type":"error","code":"mystery","message":"x"}',
      '{"type":"error","code":"failed"}',
      '{"type":"done"}',
    ])
      expect(readVoiceLine(line)).toBeNull();
  });
});

describe('voice recognizer', () => {
  it('hands the events over in order, drops lines outside the contract, and gives final after stop', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const voice = new VoiceRecognizer();
    cleanups.push(() => voice.cancel());
    const events: VoiceEvent[] = [];
    voice.start(engine, 'zh-CN', (event) => events.push(event));
    await eventually(() => events.some((event) => event.type === 'partial'));
    const recording = recordOf(log());
    expect(log()[0]).toBe(`start --locale zh-CN --record ${recording}`);
    expect(path.dirname(recording)).toBe(os.tmpdir());
    voice.stop();
    await eventually(() => events.some((event) => event.type === 'final'));
    await sleep(100);
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'level', value: 0.42 },
      { type: 'partial', text: 'hello' },
      { type: 'final', text: 'hello world' },
    ]);
    expect(existsSync(recording)).toBe(false);
  });

  it('ends the engine on cancel with no final and deletes the recording', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const voice = new VoiceRecognizer();
    const events: VoiceEvent[] = [];
    voice.start(engine, 'en-US', (event) => events.push(event));
    await eventually(() => events.some((event) => event.type === 'partial'));
    const recording = recordOf(log());
    expect(existsSync(recording)).toBe(true);
    voice.cancel();
    await eventually(() => log().includes('terminated'));
    voice.stop();
    await sleep(200);
    expect(events.map((event) => event.type)).toEqual(['ready', 'level', 'partial']);
    expect(existsSync(recording)).toBe(false);
  });

  it('reports failed when the engine exits without final, then retries the recording as a file', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, crash);
    const voice = new VoiceRecognizer();
    cleanups.push(() => voice.cancel());
    const events: VoiceEvent[] = [];
    voice.start(engine, 'zh-CN', (event) => events.push(event));
    await eventually(() => events.some((event) => event.type === 'error'));
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'error', code: 'failed', message: expect.any(String) },
    ]);
    const recording = recordOf(log());
    expect(existsSync(recording)).toBe(true);
    events.length = 0;
    voice.retry();
    await eventually(() => events.some((event) => event.type === 'final'));
    expect(log()[1]).toBe(`start --locale zh-CN --file ${recording}`);
    expect(events).toEqual([{ type: 'ready' }, { type: 'final', text: 'recorded words' }]);
    expect(existsSync(recording)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'ends what a wrapper engine started when cancelled',
    async () => {
      const root = tempRoot();
      // A sleep that ends by itself, with a length no other process has.
      const length = `20.${process.pid}${Date.now() % 1000}`;
      const pids = path.join(root, 'pids');
      const engine = path.join(root, 'wrapper');
      writeFileSync(engine, `#!/bin/sh\nsleep ${length} &\necho "$$ $!" > '${pids}'\nwait\n`, {
        mode: 0o755,
      });
      const ps = (pid: string) => {
        try {
          return execFileSync('ps', ['-o', 'ppid=,command=', '-p', pid], { encoding: 'utf8' })
            .trim()
            .split(/\s+/);
        } catch {
          return [];
        }
      };
      const voice = new VoiceRecognizer();
      cleanups.push(() => voice.cancel());
      voice.start(engine, 'en-US', () => {});
      await eventually(() => existsSync(pids) && readFileSync(pids, 'utf8').endsWith('\n'));
      const [wrapper, recorder] = readFileSync(pids, 'utf8').trim().split(' ') as [string, string];
      expect(ps(recorder)).toEqual([wrapper, 'sleep', length]);
      voice.cancel();
      await eventually(() => !ps(recorder).includes(length));
    },
  );

  it('cancels the recognition before when started again', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const voice = new VoiceRecognizer();
    cleanups.push(() => voice.cancel());
    const first: VoiceEvent[] = [];
    const second: VoiceEvent[] = [];
    voice.start(engine, 'en-US', (event) => first.push(event));
    await eventually(() => first.some((event) => event.type === 'partial'));
    const firstRecording = recordOf(log());
    voice.start(engine, 'en-US', (event) => second.push(event));
    await eventually(() => log().includes('terminated'));
    await eventually(() => second.some((event) => event.type === 'partial'));
    expect(existsSync(firstRecording)).toBe(false);
    voice.stop();
    await eventually(() => second.some((event) => event.type === 'final'));
    expect(first.map((event) => event.type)).toEqual(['ready', 'level', 'partial']);
  });
});

describe('voice settings', () => {
  it('lets a page clear the engine and refuses any engine path from it', () => {
    expect(readShellPrefsPatch({ voice_engine: null, voice_input: false })).toEqual({
      voice_engine: null,
      voice_input: false,
    });
    for (const patch of [
      { voice_engine: '/opt/engine' },
      { voice_engine: 'bin/engine' },
      { voice_engine: 3 },
      { voice_engine: false },
      { voice_input: 'yes' },
    ])
      expect(readShellPrefsPatch(patch)).toBeNull();
  });
});

/** Records listeners by name and calls them on emit. */
class Emitter {
  listeners = new Map<string, Handler[]>();
  on(name: string, fn: Handler) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }
  once(name: string, fn: Handler) {
    return this.on(name, fn);
  }
  emit(name: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(name) ?? []) fn(...args);
  }
}

function fakeElectron(root: string) {
  const handlers = new Map<string, Handler>();
  const ipcListeners = new Map<string, Handler>();
  const windows: FakeWindow[] = [];
  /** The microphone permission; a prompt waits until the test answers it. */
  const microphone = {
    status: 'granted',
    answer: undefined as ((allowed: boolean) => void) | undefined,
  };
  class FakeContents extends Emitter {
    mainFrame = {};
    sent: unknown[][] = [];
    send(...args: unknown[]) {
      this.sent.push(args);
    }
    isLoading() {
      return false;
    }
    isDestroyed() {
      return false;
    }
    setWindowOpenHandler() {}
  }
  class FakeWindow extends Emitter {
    static getFocusedWindow() {
      return null;
    }
    webContents = new FakeContents();
    constructor(options: { frame?: boolean }) {
      super();
      // The tray's hidden popover is left out; these tests count the other windows.
      if (options.frame !== false) windows.push(this);
    }
    hidden = 0;
    show() {}
    focus() {}
    setIcon() {}
    hide() {
      this.hidden++;
    }
    maximize() {}
    isFullScreen() {
      return false;
    }
    isMaximized() {
      return false;
    }
    getNormalBounds() {
      return { x: 0, y: 0, width: 1200, height: 800 };
    }
    loadURL() {
      return Promise.resolve();
    }
    loadFile() {
      return Promise.resolve();
    }
    /** As Electron does: closed follows unless a close listener prevents it. */
    close() {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      this.emit('close', event);
      if (!event.prevented) this.emit('closed');
    }
  }
  const app = Object.assign(new Emitter(), {
    isPackaged: true,
    name: 'Pantheon',
    setPath() {},
    getPath: (name: string) => path.join(root, name),
    getAppPath: () => path.join(root, 'app'),
    getPreferredSystemLanguages: () => ['en-US'],
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.2.3',
    setAboutPanelOptions() {},
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient() {},
    quit() {},
  });
  const workArea = { x: 0, y: 0, width: 1600, height: 1000 };
  const module = {
    app,
    BrowserWindow: FakeWindow,
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: {
      defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    },
    Notification: class extends Emitter {},
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [picked.engine] }),
    },
    powerMonitor: new Emitter(),
    nativeTheme: { shouldUseDarkColors: false, on() {} },
    shell: {},
    ipcMain: {
      handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
      on: (channel: string, fn: Handler) => ipcListeners.set(channel, fn),
    },
    Menu: { buildFromTemplate: (template: unknown) => ({ template }), setApplicationMenu() {} },
    screen: { getAllDisplays: () => [{ workArea }], getPrimaryDisplay: () => ({ workArea }) },
    Tray: class extends Emitter {
      setTitle() {}
      setToolTip() {}
      setContextMenu() {}
      destroy() {}
    },
    nativeImage: {
      createFromBuffer: () => ({ setTemplateImage() {} }),
    },
    systemPreferences: {
      on() {},
      getMediaAccessStatus: () => microphone.status,
      askForMediaAccess: () =>
        new Promise<boolean>((resolve) => {
          microphone.answer = resolve;
        }),
    },
  };
  return { module, handlers, ipcListeners, windows, microphone };
}
type FakeWindow = ReturnType<typeof fakeElectron>['windows'][number];

/** The file the fake open dialog returns. */
const picked = { engine: '' };

async function startMain(platform: NodeJS.Platform, root: string) {
  vi.stubEnv('PANTHEON_DATA_DIR', path.join(root, 'state'));
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  cleanups.push(() => {
    Object.defineProperty(process, 'platform', real);
    vi.unstubAllEnvs();
    vi.doUnmock(ELECTRON);
    vi.resetModules();
  });
  const electron = fakeElectron(root);
  vi.doMock(ELECTRON, () => ({ ...electron.module, default: electron.module }));
  vi.resetModules();
  await import('../../apps/desktop/src/main/index.js');
  await eventually(() => electron.windows.length === 1);
  const sender = (from: FakeWindow) => ({
    sender: from.webContents,
    senderFrame: from.webContents.mainFrame,
  });
  const call = (from: FakeWindow, channel: string, ...args: unknown[]) =>
    electron.handlers.get(channel)!(sender(from), ...args);
  const send = (from: FakeWindow, channel: string, ...args: unknown[]) =>
    electron.ipcListeners.get(channel)!(sender(from), ...args);
  const voiceEvents = (window: FakeWindow) =>
    window.webContents.sent.flatMap(([channel, event]) =>
      channel === 'pantheon:voice' ? [event as VoiceEvent] : [],
    );
  return { ...electron, main: electron.windows[0]!, call, send, voiceEvents };
}

/** Puts an engine where a packaged app keeps its built-in one, on a system new enough to run it. */
function builtInEngine(root: string, body: string) {
  const resources = path.join(root, 'resources');
  mkdirSync(path.join(resources, 'voice'), { recursive: true });
  const engine = fakeEngine(path.join(resources, 'voice'), body, 'pantheon-voice');
  const real = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
  Object.defineProperty(process, 'getSystemVersion', { configurable: true, value: () => '26.0' });
  // A packaged app reads the login shell's PATH; these tests start no shell.
  vi.doMock('../../apps/desktop/src/main/shell-env.js', () => ({
    shellPath: async () => undefined,
  }));
  cleanups.push(() => {
    if (real) Object.defineProperty(process, 'resourcesPath', real);
    else Reflect.deleteProperty(process, 'resourcesPath');
    Reflect.deleteProperty(process, 'getSystemVersion');
    vi.doUnmock('../../apps/desktop/src/main/shell-env.js');
  });
  return engine;
}

describe('voice input in the main process', () => {
  it('starts nothing when its page cancels or closes while the microphone prompt is open', async () => {
    const root = tempRoot();
    const { log } = builtInEngine(root, dictation);
    const electron = await startMain('darwin', root);
    const { main, call, send, microphone } = electron;
    microphone.status = 'not-determined';
    expect(await call(main, 'pantheon:voiceAvailable')).toBe(true);
    for (const leave of ['cancel', 'close', 'stay'] as const) {
      await call(main, 'pantheon:openWindow', {
        kind: 'session',
        project_id: 'alpha',
        session_id: `alpha-${leave}`,
      });
      const session = electron.windows.at(-1)!;
      microphone.answer = undefined;
      send(session, 'pantheon:voiceStart', 'en');
      await eventually(() => microphone.answer !== undefined);
      if (leave === 'cancel') send(session, 'pantheon:voiceCancel');
      if (leave === 'close') session.close();
      microphone.answer!(true);
      await sleep(200);
      if (leave !== 'stay') expect(log()).toEqual([]);
    }
    await eventually(() => log().length > 0);
    expect(log()[0]).toMatch(/^start --locale en-US --record /);
    send(electron.windows.at(-1)!, 'pantheon:voiceCancel');
    await eventually(() => log().includes('terminated'));
  });

  it("ends the main window's recognition when the window closes into the background and closes its voice bar with no text", async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const { main, call, send, voiceEvents } = await startMain('linux', root);
    picked.engine = engine;
    await call(main, 'pantheon:chooseVoiceEngine');
    send(main, 'pantheon:voiceStart', 'en');
    await eventually(() => voiceEvents(main).some((event) => event.type === 'partial'));
    main.close();
    expect(main.hidden).toBe(1);
    await eventually(() => log().includes('terminated'));
    expect(voiceEvents(main).at(-1)).toEqual({ type: 'final', text: '' });
    expect(existsSync(recordOf(log()))).toBe(false);
  });

  it('is unavailable on Linux with no engine set, and while voice input is off', async () => {
    const root = tempRoot();
    const { engine } = fakeEngine(root, dictation);
    const { main, call } = await startMain('linux', root);
    expect(await call(main, 'pantheon:shellPrefs')).toMatchObject({
      value: { voice_input: true, voice_engine: null },
    });
    expect(await call(main, 'pantheon:voiceAvailable')).toBe(false);
    picked.engine = engine;
    await call(main, 'pantheon:chooseVoiceEngine');
    expect(await call(main, 'pantheon:voiceAvailable')).toBe(true);
    await call(main, 'pantheon:setShellPrefs', { voice_input: false });
    expect(await call(main, 'pantheon:voiceAvailable')).toBe(false);
  });

  it('refuses an engine path that a page sends', async () => {
    const root = tempRoot();
    const { main, call } = await startMain('linux', root);
    for (const voice_engine of ['/opt/engine', './bin/engine', 7])
      expect(await call(main, 'pantheon:setShellPrefs', { voice_engine })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
  });

  it('runs the engine set, sends its events only to the page that started it, and cancels when that page closes', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const electron = await startMain('darwin', root);
    const { main, call, send, voiceEvents } = electron;
    picked.engine = engine;
    await call(main, 'pantheon:chooseVoiceEngine');
    await call(main, 'pantheon:openWindow', {
      kind: 'session',
      project_id: 'alpha',
      session_id: 'alpha-login',
    });
    const session = electron.windows[1]!;
    send(session, 'pantheon:voiceStart', 'en');
    await eventually(() => voiceEvents(session).some((event) => event.type === 'partial'));
    expect(log()[0]).toMatch(/^start --locale en-US --record /);
    // Another page cannot end a recognition it did not start.
    send(main, 'pantheon:voiceCancel');
    await sleep(100);
    expect(log()).not.toContain('terminated');
    expect(voiceEvents(main)).toEqual([]);
    session.close();
    await eventually(() => log().includes('terminated'));
    expect(existsSync(recordOf(log()))).toBe(false);
  });

  it('closes the voice bar of the page whose recognition another page takes over', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const electron = await startMain('linux', root);
    const { main, call, send, voiceEvents } = electron;
    picked.engine = engine;
    await call(main, 'pantheon:chooseVoiceEngine');
    await call(main, 'pantheon:openWindow', {
      kind: 'session',
      project_id: 'alpha',
      session_id: 'alpha-takeover',
    });
    const session = electron.windows[1]!;
    send(main, 'pantheon:voiceStart', 'en');
    await eventually(() => voiceEvents(main).some((event) => event.type === 'partial'));
    send(session, 'pantheon:voiceStart', 'en');
    await eventually(() => voiceEvents(session).some((event) => event.type === 'partial'));
    expect(voiceEvents(main).at(-1)).toEqual({ type: 'final', text: '' });
    send(session, 'pantheon:voiceCancel');
    await eventually(() => log().filter((line) => line === 'terminated').length === 2);
  });

  it('ends a running recognition and closes its voice bar when voice input is turned off', async () => {
    const root = tempRoot();
    const { engine, log } = fakeEngine(root, dictation);
    const { main, call, send, voiceEvents } = await startMain('linux', root);
    picked.engine = engine;
    await call(main, 'pantheon:chooseVoiceEngine');
    send(main, 'pantheon:voiceStart', 'en');
    await eventually(() => voiceEvents(main).some((event) => event.type === 'partial'));
    await call(main, 'pantheon:setShellPrefs', { voice_input: false });
    await eventually(() => log().includes('terminated'));
    expect(voiceEvents(main).at(-1)).toEqual({ type: 'final', text: '' });
    expect(existsSync(recordOf(log()))).toBe(false);
  });

  it('starts nothing when voice input is turned off while the microphone prompt is open', async () => {
    const root = tempRoot();
    const { log } = builtInEngine(root, dictation);
    const { main, call, send, microphone, voiceEvents } = await startMain('darwin', root);
    microphone.status = 'not-determined';
    send(main, 'pantheon:voiceStart', 'en');
    await eventually(() => microphone.answer !== undefined);
    await call(main, 'pantheon:setShellPrefs', { voice_input: false });
    microphone.answer!(true);
    await sleep(200);
    expect(log()).toEqual([]);
    expect(voiceEvents(main).at(-1)).toEqual({ type: 'final', text: '' });
  });
});
