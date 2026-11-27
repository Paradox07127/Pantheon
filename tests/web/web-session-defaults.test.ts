import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The dialog's portal draws nothing on the server; these tests read the markup inside it.
vi.mock('../../apps/web/node_modules/@base-ui/react/dialog/index.mjs', async () => {
  const { Fragment, createElement: element } = await import('react');
  const inline = ({ children }: { children?: unknown }) =>
    element(Fragment, null, children as never);
  return {
    Dialog: {
      Root: inline,
      Portal: inline,
      Backdrop: () => null,
      Popup: inline,
      Close: inline,
      Title: inline,
    },
  };
});
import {
  defaultPermissionMode,
  defaultRuntime,
  newSessionInput,
  permissionModes,
} from '@/screens/sessions/model';
import { NewSession } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const render = (defaults?: { runtime: string; permission_mode: 'ask' | 'auto_edit' | 'plan' }) =>
  renderToStaticMarkup(
    createElement(NewSession, {
      projectId: 'project',
      defaults,
      focus: 0,
      onCreated: () => {},
      recent: [],
      onOpen: () => {},
      onClose: () => {},
    }),
  );
const modelButton = (html: string) => html.match(/<button[^>]*aria-label="模型：([^"]*)"/)?.[1];

describe('new session defaults', () => {
  it("starts on the project's default runtime when offered, else claude", () => {
    expect(defaultRuntime(['claude', 'codex'], 'codex')).toBe('codex');
    expect(defaultRuntime([], 'codex')).toBe('codex');
    expect(defaultRuntime(['claude'], 'codex')).toBe('claude');
    expect(defaultRuntime(['claude', 'codex'])).toBe('claude');
  });

  it("starts in the project's default mode when the runtime offers it, else the first mode", () => {
    expect(defaultPermissionMode('claude', 'plan')).toBe('plan');
    expect(defaultPermissionMode('claude')).toBe('ask');
    expect(defaultPermissionMode('codex', 'ask')).toBe('auto_edit');
  });

  it('offers a grok session no permission mode and agy all three', () => {
    expect(permissionModes('grok')).toEqual([]);
    expect(defaultPermissionMode('grok', 'plan')).toBe('ask');
    expect(permissionModes('agy').map((m) => m.value)).toEqual(['ask', 'auto_edit', 'plan']);
    const html = render({ runtime: 'grok', permission_mode: 'plan' });
    expect(modelButton(html)).toBe(`grok，${zh('sessions.composer.defaultModel')}`);
    expect(html).not.toContain(`aria-label="${zh('sessions.composer.permissionMode')}"`);
  });

  it("selects the project's defaults in the new-session composer", () => {
    const html = render({ runtime: 'codex', permission_mode: 'plan' });
    expect(modelButton(html)).toBe(`codex，${zh('sessions.composer.defaultModel')}，只读`);
  });

  it('selects claude and ask without project defaults', () => {
    const html = render();
    expect(modelButton(html)).toBe(`claude，${zh('sessions.composer.defaultModel')}，逐条审批`);
  });
});
