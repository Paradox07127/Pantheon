import { readFileSync } from 'node:fs';
import { Server } from '../../../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from '../../../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '../../../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const resourceUri = 'ui://pantheon-fixture/counter.html';
const mimeType = 'text/html;profile=mcp-app';
const page = readFileSync(new URL('./counter.html', import.meta.url), 'utf8');

const tools = [
  {
    name: 'show_counter',
    description: 'Show a counter widget that starts at the given number.',
    inputSchema: { type: 'object', properties: { start: { type: 'number' } } },
    _meta: {
      ui: { resourceUri, visibility: ['model', 'app'] },
      'ui/resourceUri': resourceUri,
    },
  },
  {
    name: 'bump',
    description: 'Bump the counter by the given amount. Called by the counter widget.',
    inputSchema: { type: 'object', properties: { by: { type: 'number' } }, required: ['by'] },
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'secret',
    description: 'Return a fixed secret. Only the model may call this tool.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { visibility: ['model'] } },
  },
];

const server = new Server(
  { name: 'pantheon-mcp-app-fixture', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'show_counter': {
      const start = typeof args.start === 'number' ? args.start : 0;
      return {
        content: [{ type: 'text', text: `Counter starts at ${start}` }],
        structuredContent: { start },
      };
    }
    case 'bump': {
      if (typeof args.by !== 'number') {
        throw new McpError(ErrorCode.InvalidParams, 'bump needs a number "by"');
      }
      return {
        content: [{ type: 'text', text: `Bumped by ${args.by}` }],
        structuredContent: { bumped: args.by },
      };
    }
    case 'secret':
      return { content: [{ type: 'text', text: 'The secret is 42' }] };
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${params.name}`);
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: resourceUri, name: 'Counter', mimeType }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
  if (params.uri !== resourceUri) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${params.uri}`);
  }
  return {
    contents: [
      {
        uri: resourceUri,
        mimeType,
        text: page,
        _meta: {
          ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
        },
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
