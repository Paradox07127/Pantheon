import { afterEach, describe, expect, it, vi } from 'vitest';
import { find, HookHost, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { ContextBreakdown } from '@/screens/sessions/ContextBreakdown';
import { zh } from './i18n-setup.js';

const breakdown = {
  categories: [
    { id: 'system_prompt', tokens: 3_000, kind: 'used' },
    { id: 'system_tools', tokens: 14_000, kind: 'used' },
    { id: 'mcp_tools', tokens: 9_000, kind: 'used' },
    { id: 'custom_agents', tokens: 1_000, kind: 'used' },
    { id: 'memory_files', tokens: 4_000, kind: 'used' },
    { id: 'skills', tokens: 2_000, kind: 'used' },
    { id: 'messages', tokens: 150_000, kind: 'used' },
    { id: 'autocompact_buffer', tokens: 33_000, kind: 'buffer' },
    { id: 'free_space', tokens: 184_000, kind: 'free' },
    { id: 'mcp_tools_deferred', tokens: 41_000, kind: 'deferred' },
  ],
  memory_files: [
    { path: 'CLAUDE.md', tokens: 3_000 },
    { path: 'MEMORY.md', tokens: 1_000 },
  ],
  mcp_tools: [{ name: 'search', server: 'docs', tokens: 9_000, loaded: true }],
  agents: [],
};
const claude = {
  input_tokens: 1_200_000,
  output_tokens: 38_000,
  context_tokens: 183_000,
  context_window: 400_000,
  context_breakdown: breakdown,
};
const codex = {
  input_tokens: 64_000,
  cached_input_tokens: 22_000,
  output_tokens: 8_000,
  reasoning_output_tokens: 3_000,
  context_tokens: 72_000,
  context_window: 400_000,
};

afterEach(unmountAll);
const mount = (usage: unknown) => host(() => ContextBreakdown({ usage }));
const rows = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => n.type === 'tr')
    .map((row) => text(row));
const segments = (h: HookHost<any>) =>
  find(h.value, (n) => n.props.role === 'img')
    .props.children.flat()
    .filter(Boolean);

describe('context breakdown', () => {
  it('heads the breakdown with the share of the window used and the tokens used of it', () => {
    const h = mount(claude);
    expect(text(h.value)).toContain('已用 45.8%');
    expect(text(h.value)).toContain('183k / 400k');
  });

  it('lists the categories in use largest first, then the buffer and free space, then those out of the window without a share', () => {
    const h = mount(claude);
    expect(rows(h)).toEqual([
      '消息150k37.5%',
      '系统工具14k3.5%',
      'MCP 工具9k2.3%',
      'Memory 文件4k1%',
      '系统提示词3k0.8%',
      'Skills2k0.5%',
      '自定义 agent1k0.3%',
      '自动压缩预留33k8.3%',
      '空闲184k46%',
      'MCP 工具（延迟加载）41k—',
      'MCP 工具1',
      'Memory 文件2',
    ]);
  });

  it('opens the files of a category that has them', () => {
    const h = mount(claude);
    const memory = find(
      h.value,
      (n) => n.type === 'button' && text(n).startsWith(zh('sessions.compose.context.memoryFiles')),
    );
    expect(memory.props['aria-expanded']).toBe(false);
    memory.props.onClick();
    h.render();
    expect(rows(h)).toContain('CLAUDE.md3k');
    expect(rows(h)).toContain('MEMORY.md1k');
    expect(
      nodes(h.value).some(
        (n) =>
          n.type === 'button' && text(n).startsWith(zh('sessions.compose.context.customAgents')),
      ),
    ).toBe(false);
  });

  it('draws at most five segments for the rows in use, folding the rest into other, then the buffer and the free space', () => {
    const h = mount(claude);
    const label = find(h.value, (n) => n.props.role === 'img').props['aria-label'];
    expect(label).toContain(zh('sessions.compose.context.other'));
    expect(label).toContain('自动压缩预留 33k');
    // The same free space the table lists, not the window less the tokens in use.
    expect(label).toContain('空闲 184k');
    expect(segments(h)).toHaveLength(7);
  });

  it('lists the usage numbers a runtime without a breakdown reported, none with a share', () => {
    const h = mount(codex);
    expect(rows(h)).toEqual(['输入42k—', '缓存输入22k—', '输出5k—', '推理3k—']);
    const plain = { ...codex, cached_input_tokens: undefined, reasoning_output_tokens: undefined };
    expect(rows(mount(plain))).toEqual(['输入64k—', '输出8k—']);
  });

  it("fills the bar with the latest request's context, not the turn's summed token counts", () => {
    const h = mount({
      input_tokens: 1_000_000,
      output_tokens: 20_000,
      context_tokens: 72_000,
      context_window: 400_000,
    });
    expect(text(h.value)).toContain('18%');
    const label = find(h.value, (n) => n.props.role === 'img').props['aria-label'];
    expect(label).toContain('空闲 328k');
    expect(rows(h).every((row) => !row.includes('%'))).toBe(true);
  });

  it("splits the latest request's context by the turn's token kinds when there is no breakdown", () => {
    const h = mount(codex);
    const label = find(h.value, (n) => n.props.role === 'img').props['aria-label'];
    for (const part of ['输入 42k', '缓存输入 22k', '输出 5k', '推理 3k', '空闲 328k'])
      expect(label).toContain(part);
    expect(segments(h)).toHaveLength(5);
  });

  it('names the runtime and the model the session runs on', () => {
    const h = host(() =>
      ContextBreakdown({ usage: claude, runtime: 'claude', model: 'claude-opus-4-5' }),
    );
    const images = nodes(h.value).filter((n) => n.props.role === 'img');
    expect(images.map((n) => n.props['aria-label'])).toContain('Claude');
    expect(text(h.value)).toContain('claude-opus-4-5');
    const plain = host(() => ContextBreakdown({ usage: claude, runtime: 'codex', model: null }));
    expect(text(plain.value)).toContain('Codex');
  });

  it("meters each quota window of the session's runtime with when it resets", () => {
    const now = Date.parse('2026-11-14T10:00:00.000Z');
    vi.useFakeTimers({ now });
    const quota = {
      seen_at: now,
      windows: [
        { window: 'five_hour', used_percent: 38, resets_at: now + (2 * 60 + 14) * 60_000 },
        { window: 'seven_day', used_percent: 12 },
      ],
    };
    const h = host(() => ContextBreakdown({ usage: codex, runtime: 'codex', quota }));
    vi.useRealTimers();
    const meters = nodes(h.value).filter((n) => n.props.role === 'meter');
    expect(meters.map((m) => [m.props['aria-label'], m.props['aria-valuenow']])).toEqual([
      ['5 小时已用额度', 38],
      ['7 天已用额度', 12],
    ]);
    expect(text(h.value)).toContain('5 小时窗口，2 小时 14 分后重置');
    expect(text(h.value)).toContain('7 天窗口');
    const none = host(() =>
      ContextBreakdown({ usage: codex, runtime: 'codex', quota: { seen_at: now, windows: [] } }),
    );
    expect(nodes(none.value).some((n) => n.props.role === 'meter')).toBe(false);
  });
});
