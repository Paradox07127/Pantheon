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
  // Board and dispatch tools: only the user names another lead's plan.
  'lead_session_id',
  // merge_task: a lead names the task, not the session.
  'session_id of merge_task',
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

async function listTools(role: 'lead' | 'worker') {
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

it.each(['lead', 'worker'] as const)(
  'describes every input field of every %s tool',
  async (role) => {
    const tools = await listTools(role);
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(sessionTools[role]).sort());
    const missing = tools.flatMap((tool) => undescribed(tool.inputSchema as JsonSchema, tool.name));
    expect(missing).toEqual([]);
  },
);

it.each(['lead', 'worker'] as const)(
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
