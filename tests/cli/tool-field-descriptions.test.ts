import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { sessionTools } from '@pantheon/protocol';
import { createMcpServer } from '../../apps/cli/src/mcp.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.unstubAllGlobals();
});

/** Top-level input fields the MCP layer fills in or hides, so the model never sees them. */
const boundFields = [
  // Every tool: the session's own project.
  'project_id',
] as const;

type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
};

/** The path of every object property below schema that has no description. */
function undescribed(schema: JsonSchema, path: string): string[] {
  const missing: string[] = [];
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (!field.description?.trim()) missing.push(`${path}.${name}`);
    missing.push(...undescribed(field, `${path}.${name}`));
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const item of items) missing.push(...undescribed(item, `${path}[]`));
  if (typeof schema.additionalProperties === 'object')
    missing.push(...undescribed(schema.additionalProperties, `${path}{}`));
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf])
    branches?.forEach((branch, index) => missing.push(...undescribed(branch, `${path}|${index}`)));
  return missing;
}

async function listTools(role: keyof typeof sessionTools) {
  vi.stubGlobal('fetch', async () =>
    Response.json({
      principal: {
        id: `session:${role}`,
        role,
        session_id: role,
        project_id: 'project',
        expires_at: Date.now() + 60_000,
      },
    }),
  );
  const server = await createMcpServer('http://127.0.0.1:4321', 'session-token');
  const client = new Client({ name: 'field-description-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return (await client.listTools()).tools;
}

it.each(Object.keys(sessionTools) as (keyof typeof sessionTools)[])(
  'describes every input field of every %s tool',
  async (role) => {
    const tools = await listTools(role);
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(sessionTools[role]).sort());
    const missing = tools.flatMap((tool) => undescribed(tool.inputSchema as JsonSchema, tool.name));
    expect(missing).toEqual([]);
  },
);

it.each(['reviewer', 'planner', 'conductor'] as const)(
  'keeps the bound fields out of the %s tool inputs',
  async (role) => {
    for (const tool of await listTools(role))
      for (const field of boundFields) {
        const [name, owner] = field.split(' of ');
        if (!owner || owner === tool.name)
          expect(tool.inputSchema.properties ?? {}, `${tool.name} ${name}`).not.toHaveProperty(
            name!,
          );
      }
  },
);

it('lists the tools that read the project and manage spawned sessions to a conductor', async () => {
  const tools = Object.fromEntries((await listTools('conductor')).map((tool) => [tool.name, tool]));
  for (const name of [
    'project_read',
    'memory_context',
    'memory_search',
    'memory_related',
    'memory_get',
    'memory_propose',
    'read_needs_you',
    'message_session',
    'stop_session',
  ])
    expect(tools[name]?.description, name).toBeTruthy();
  expect(tools.message_session!.description).toContain('2 messages a minute');
  expect(
    (tools.spawn_session!.inputSchema.properties as Record<string, { enum?: string[] }>)
      .permission_mode?.enum,
  ).toEqual(['ask', 'auto_edit']);
});

it('offers a conductor to spawn one task on several runtimes with what done means and the paths it owns', async () => {
  const tools = Object.fromEntries((await listTools('conductor')).map((tool) => [tool.name, tool]));
  const spawn = tools.spawn_session!;
  const schema = spawn.inputSchema as {
    required?: string[];
    properties: Record<string, { minItems?: number; maxItems?: number }>;
  };

  expect(schema.required).toEqual(['input']);
  expect(schema.properties.runtimes).toMatchObject({ minItems: 2, maxItems: 3 });
  expect(schema.properties.acceptance).toMatchObject({ minItems: 1, maxItems: 12 });
  expect(schema.properties.owns).toMatchObject({ minItems: 1, maxItems: 50 });
  expect(spawn.description).toContain(
    'review them, land one with report_ready and close the others with stop_session close',
  );
  expect(tools.read_state!.description).toContain('outside_owns');
});
