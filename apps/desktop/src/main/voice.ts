import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DesktopBridge } from '@pantheon/protocol';

export type VoiceEvent = Parameters<Parameters<DesktopBridge['voiceStart']>[1]>[0];
type VoiceListener = (event: VoiceEvent) => void;
type ErrorCode = Extract<VoiceEvent, { type: 'error' }>['code'];

const ERROR_CODES: readonly ErrorCode[] = [
  'microphone_denied',
  'speech_denied',
  'unavailable',
  'failed',
];
const ENGINE_LOCALES: Record<string, string> = { en: 'en-US', 'zh-CN': 'zh-CN' };

/** The engine's locale for the interface language the page sent; null for anything else. */
export function readVoiceLocale(value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(ENGINE_LOCALES, value)
    ? ENGINE_LOCALES[value]!
    : null;
}

const fraction = (value: unknown): value is number =>
  typeof value === 'number' && value >= 0 && value <= 1;

/** One line of an engine's output as an event; null for a line the engine contract does not allow. */
export function readVoiceLine(line: string): VoiceEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'preparing':
      if (event.progress === undefined) return { type: 'preparing' };
      return fraction(event.progress) ? { type: 'preparing', progress: event.progress } : null;
    case 'ready':
      return { type: 'ready' };
    case 'level':
      return fraction(event.value) ? { type: 'level', value: event.value } : null;
    case 'partial':
    case 'final':
      return typeof event.text === 'string' ? { type: event.type, text: event.text } : null;
    case 'error':
      return ERROR_CODES.includes(event.code as ErrorCode) && typeof event.message === 'string'
        ? { type: 'error', code: event.code as ErrorCode, message: event.message }
        : null;
    default:
      return null;
  }
}

interface Run {
  child: ChildProcess;
  /** The engine gave final or error. */
  ended: boolean;
}

/** Runs one voice engine at a time and hands its events to the listener of the recognition. */
export class VoiceRecognizer {
  private run: Run | undefined;
  private last: { engine: string; locale: string; listener: VoiceListener } | undefined;
  /** The --record file of the last start, kept for a retry until a final or a cancel. */
  private recording: string | undefined;

  /** Starts engine recording to a new file in the system temp directory, cancelling the recognition before. */
  start(engine: string, locale: string, listener: VoiceListener): void {
    this.cancel();
    this.recording = path.join(os.tmpdir(), `pantheon-voice-${randomUUID()}.caf`);
    this.last = { engine, locale, listener };
    this.launch(['--locale', locale, '--record', this.recording]);
  }

  /** Asks the engine to end the recording and give its final text. */
  stop(): void {
    this.run?.child.stdin!.write('stop\n');
  }

  /** Ends the engine with no result and deletes the recording. */
  cancel(): void {
    this.end();
    this.removeRecording();
  }

  /** Recognizes the last recording again with --file. */
  retry(): void {
    if (!this.last || !this.recording) return;
    this.end();
    this.launch(['--locale', this.last.locale, '--file', this.recording]);
  }

  private end(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    if (process.platform === 'win32' || run.child.pid === undefined) run.child.kill();
    else
      try {
        // A wrapper script's children share its process group.
        process.kill(-run.child.pid);
      } catch {}
  }

  private removeRecording(): void {
    if (this.recording) rmSync(this.recording, { force: true });
    this.recording = undefined;
  }

  private launch(args: string[]): void {
    const { engine, listener } = this.last!;
    const child = spawn(engine, args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: process.platform !== 'win32',
    });
    const run: Run = { child, ended: false };
    this.run = run;
    // An engine that has exited fails the write of a later stop.
    child.stdin!.on('error', () => {});
    // A failed spawn reports itself here and then closes.
    child.on('error', () => {});
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const event = readVoiceLine(line);
      if (!event || this.run !== run || run.ended) return;
      if (event.type === 'final' || event.type === 'error') run.ended = true;
      if (event.type === 'final') this.removeRecording();
      listener(event);
    });
    child.on('close', () => {
      if (this.run !== run) return;
      this.run = undefined;
      if (!run.ended)
        listener({
          type: 'error',
          code: 'failed',
          message: 'The voice engine exited without a result',
        });
    });
  }
}
