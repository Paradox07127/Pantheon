import { describe, expect, it, vi } from 'vitest';
import {
  appModeOf,
  escapeFullscreen,
  placeApp,
  toggleDock,
  type AppPlaces,
} from '@/screens/sessions/app-display';
import { appAllow, appSrcdoc, frameGesture, inlineHeight } from '@/components/mcp-app/AppFrame';

describe('where an interface shows', () => {
  const none: AppPlaces = {};

  it('docks one interface per session; docking a second puts the first back inline', () => {
    const first = placeApp(none, 'session-main', 'call-a', 'pip');
    expect(appModeOf(first, 'session-main', 'call-a')).toBe('pip');
    const second = placeApp(first, 'session-main', 'call-b', 'pip');
    expect(appModeOf(second, 'session-main', 'call-a')).toBe('inline');
    expect(appModeOf(second, 'session-main', 'call-b')).toBe('pip');
    const other = placeApp(second, 'session-other', 'call-c', 'pip');
    expect(appModeOf(other, 'session-main', 'call-b')).toBe('pip');
  });

  it('puts a docked interface back inline when its panel closes or is hidden', () => {
    const docked = placeApp(none, 'session-main', 'call-a', 'pip');
    expect(
      appModeOf(placeApp(docked, 'session-main', 'call-a', 'inline'), 'session-main', 'call-a'),
    ).toBe('inline');
    const hidden = toggleDock(docked, 'session-main');
    expect(appModeOf(hidden, 'session-main', 'call-a')).toBe('inline');
    expect(appModeOf(toggleDock(hidden, 'session-main'), 'session-main', 'call-a')).toBe('pip');
  });

  it('leaves full screen on Escape for the place it was opened from', () => {
    const inline = placeApp(none, 'session-main', 'call-a', 'fullscreen');
    expect(appModeOf(inline, 'session-main', 'call-a')).toBe('fullscreen');
    expect(escapeFullscreen(inline, 'session-main', 'Enter')).toBe(inline);
    expect(
      appModeOf(escapeFullscreen(inline, 'session-main', 'Escape'), 'session-main', 'call-a'),
    ).toBe('inline');
    const docked = placeApp(
      placeApp(none, 'session-main', 'call-a', 'pip'),
      'session-main',
      'call-a',
      'fullscreen',
    );
    expect(
      appModeOf(escapeFullscreen(docked, 'session-main', 'Escape'), 'session-main', 'call-a'),
    ).toBe('pip');
    const docked2 = placeApp(none, 'session-main', 'call-a', 'pip');
    expect(escapeFullscreen(docked2, 'session-main', 'Escape')).toBe(docked2);
  });
});

describe('the interface frame', () => {
  it('allows clipboard writing when asked and never camera, microphone or location', () => {
    expect(appAllow()).toBe('');
    expect(appAllow({ camera: {}, clipboardWrite: {} })).toBe('clipboard-write');
    expect(appAllow({ microphone: {}, geolocation: {} })).toBe('');
  });

  it('counts a gesture only while the frame has focus and the page has fresh activation', () => {
    const frame = {} as Element;
    const other = {} as Element;
    const look = (focused: Element | null, isActive: boolean) => {
      vi.stubGlobal('document', { activeElement: focused });
      vi.stubGlobal('navigator', { userActivation: { isActive } });
      return frameGesture(frame);
    };
    try {
      expect(look(frame, true)).toBe(true);
      expect(look(frame, false)).toBe(false);
      expect(look(other, true)).toBe(false);
      expect(look(null, true)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('puts the policy in the page itself when no desktop app serves it', () => {
    const doc = appSrcdoc('<p>Weather</p>', { connectDomains: ['https://api.example.com'] });
    expect(doc).toMatch(
      /^<!doctype html><meta http-equiv="Content-Security-Policy" content="[^"]+">/,
    );
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('connect-src https://api.example.com');
    expect(doc.endsWith('<p>Weather</p>')).toBe(true);
    const plain = appSrcdoc('<p>Weather</p>');
    expect(plain).toContain("connect-src 'none'");
    // A domain that could close the attribute or add a directive stays out.
    expect(
      appSrcdoc('', {
        connectDomains: ['https://a.example.com" onload="x', 'https://b.example.com;'],
      }),
    ).toContain("connect-src 'none'");
  });

  it('keeps an inline interface between 120 and 800 px high', () => {
    expect(inlineHeight(40)).toBe(120);
    expect(inlineHeight(360)).toBe(360);
    expect(inlineHeight(2000)).toBe(800);
    expect(inlineHeight(undefined)).toBeNull();
  });
});
