import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { PANTHEON_VERSION } from '@pantheon/domain/version';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  command,
  commandSchema,
  inputSchemas,
  visualDrawInputSchema,
  prettifyError,
  sessionTools,
  coordinationTools,
  BROWSER_TEXT_LIMIT,
  type BrowserPage,
  type Principal,
  type Command,
  type CommandType,
} from '@pantheon/protocol';

export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly daemonMessage?: string,
  ) {
    super(code);
  }
}

type Identity = {
  principal: Principal;
  review_id?: string;
  baseline_id?: string;
  story_id?: string;
  extension_runtimes?: string[];
  allowed_tool_names?: string[];
};

type ToolCommand =
  | {
      [
        Role in keyof typeof sessionTools
      ]: (typeof sessionTools)[Role][keyof (typeof sessionTools)[Role]];
    }[keyof typeof sessionTools]
  | (typeof coordinationTools)[keyof typeof coordinationTools];

const descriptions: Record<ToolCommand, string> = {
  'trace.evidence':
    'Read the isolated analysis snapshot. Start with summary. Read findings by kind and offset, at most six per call. Workflow returns a bounded policy and task snapshot. Each response is size-limited. Cite the finding IDs and evidence IDs.',
  'trace.report':
    'Save one proposed experiment, targeted measurement, or no-action conclusion for this analysis. Cite finding IDs from trace_evidence. An experiment includes change, matched baseline, metric and rollback. This records a report only.',
  'memory.context':
    "Read the current project memory: the user's decisions, notes and reports, and your task's own entries. Pantheon already adds this packet to your turn when it changes, so call it only when you need it again, for example before you accept work or when the packet said entries were omitted. Returns signature (pass it as based_on to memory_propose), the entries and the omitted count. max_bytes caps the entry payload (default 12000 bytes).",
  'memory.related':
    'Show what is connected to one current memory entry: what it depends on, what depends on it, its earlier versions, or entries sharing a tag. Use it before you replace or contradict an entry, to see what else rests on it. depth is 1 or 2, limit at most 30. A shared tag only means a shared topic, not a dependency. Read full entries with memory_get.',
  'memory.search':
    'Find current memory entries on a topic by q (English full-text and literal matching in any language). Use it before you plan in an area, and before memory_propose to find an entry to update instead of adding a duplicate. Filter by kind, tag, task_id or lead_session_id. Returns short summaries with memory ids and why each matched; read one in full with memory_get before you rely on it. Old, expired and replaced entries are not returned.',
  'memory.get':
    "Read one current memory entry in full by memory_id, with its evidence and reference_status. When a reference is changed or unavailable, read the original file or URL before you act on the entry. Not found means the entry was replaced, expired or is outside your task's scope: search again with memory_search rather than using an older copy.",
  'memory.propose':
    'Write a memory entry: kind note for a fact, preference, constraint or a record you keep across reviews; kind report for an analysis of the current state with its evidence, which stops being current when task states change; kind decision only for a rule the user stated, with no dependencies. Use it in the same turn the user corrects you, states a preference or asks you to remember something. Do not store code structure, fixes already in git, task progress or secrets. Reuse the key of an entry to replace it. Notes and reports are current at once; a decision stays a draft until the user confirms it. From a task session the entry applies to your task only. Refused "A dependency is no longer current": read the current version with memory_search and retry.',

  'visual.draw':
    'Show a chart or diagram in the conversation when a result is easier to see than to read, or when the user asks for one. Give title, kind and spec; the spec shape depends on kind (see its field description). Prefer vega-lite, graph, mermaid or table; use html only when none of these fits. All data must be inline. For a graph, give each node a kind, mark the main path with style main, put nodes into groups by layer or subsystem, and keep labels short with detail in sublabel. A node may also take an icon from the fixed list, a color (blue, teal, orange, violet, gray or green) whose meaning goes in colors for the legend, a status (waiting, running, done, failed or blocked, which wins over color) and up to 3 detail lines of at most 48 characters; in a mermaid flowchart or stateDiagram a class with a status or color name does the same. Give direction LR only for a pipeline of up to about 6 steps and TB for longer flows, hierarchies, call stacks and state lifecycles, and leave it out when unsure; a written direction that would draw below two thirds of its size in the card is turned or wrapped into rows or columns. Keep one diagram to about 12-15 nodes and one question, put the main path first, and split a node with more than 5 edges or move its neighbours into a group. In a mermaid flowchart or stateDiagram, give each node a kind as a class: write A:::store or class A,B service with client, service, store, queue, external or policy; Pantheon defines these classes, so write no classDef for them. Use timeline for events over time and for durations such as a request or trace waterfall: { lanes?, groups?, items: [{ id, label, detail?, lane?, group?, at, end?, parent? }] }, where an item with end is a span and parent nests it; use vega-lite only for numeric charts. Returns visual_id and revision. Use replaces to redraw an earlier chart in place, and pin only when the user asks for it on the board. When a spec is invalid the error names the part; fix it and call again.',
  'review.finding':
    'Record one problem in the artifact under review, including code it deletes. location: file and line, or the task id for a plan. quote: text copied exactly from your first message. evidence: what you saw. impact: what goes wrong, for whom. blocking true only for what must be fixed before merge, and then reproduction is required. Call once per problem; when you find none, do not call it. Refused "quote_not_in_artifact": copy the quote again from your first message, once. Rejected with artifact_unavailable: retrying will not help; say what you could not record.',
  'review.verdict':
    'End your review with one call: verdict pass when nothing you found must be fixed before merge, otherwise fail, and a summary of what you checked and found. Call it after your review_finding calls. A later call replaces your verdict. Refused invalid_state once the review has ended.',
  'project.read':
    "Read the project: details, brief, and every lead's board plan with each task's state and sessions. A lead also gets a lead section: workflow policy (paths), devices, and recent retrospectives and runtime reviews. Call it before you plan or decide, and after a board update when you need the current state; a task session calls it to see the tasks around its own. It returns plan_version, which update_board needs as base_version. To rewrite the plan from the repository, use sync_board instead.",
  'project.intro.submit':
    'Write the project introduction. summary: 1–280 characters; sources: 1–16 file:<relative path>, file:<relative path>:<line> or commit:<7–40 hex digits> references, with at least one resolving in a project root. features: at most 12 { title: 1–80 characters, text: 1–400 characters, sources: same rules }. modules: at most 40 { path: unique root-relative directory inside a project root, role: 1–400 characters, entry?: a file inside that directory, relative to the same root }; if several roots match path, the first is used. architecture?: graph { nodes: [{ id, label, group? }], edges: [{ from, to, label? }], direction?: "LR" | "TB" }, 1–200 nodes with unique ids, at most 400 edges naming existing nodes; one node for each module, grouped by layer, with labelled edges. body?: Markdown, at most 20000 characters. Pantheon measures all numbers: do not send lines, commits_30d, languages, weeks or heads. The project is bound to your session. Returns { written: true }; correct named fields if refused.',
  'project.baseline.submit_folder':
    'Submit the assessment of one project folder. Call once for each folder in the brief.',
  'project.baseline.submit':
    'Submit the project-wide assessment: workstreams (each with its modules, depends_on, risks and the items, sections and commits that show its progress), contradictions, questions, and tasks (next tasks with scope, acceptance and dependencies). Each question has id, header (at most 12 characters), question, 2–4 options { label, description, preview? }, multiSelect, and optional recommended and kind; preview is { kind: "graph", spec } with at most 40 nodes or { kind: "mermaid", spec: { source } }. The first round has exactly one question with kind "direction": 2–3 options, each with a preview. The last round has empty questions. Call it once after every folder and project_intro_submit are submitted, and again in each later round with the complete revised assessment; after each call end the turn.',
  'change_story.submit':
    'Submit your interpretation of the landed diff as change cards. Call once; if it returns errors, fix them and submit again, then end the turn.',
  'browser.open':
    "Open an http or https url in this session's browser panel in the Pantheon desktop app; the user sees it, and it shares the user's cookies and logins. Use it to check a page your work changes or read documentation the user pointed to. Returns the final url and title once the page loads. Fails with browser_busy when the user is not viewing this session (ask them to open it, or go on without the browser), and fails when no desktop window is connected.",
  'browser.read':
    "Read the page open in this session's browser panel: url, title and visible text, at most 50000 characters, noting when the text was cut. Open a page with browser_open first, or read the one the user opened. Fails when no page is open.",
  'browser.screenshot':
    "Take a PNG screenshot of the page open in this session's browser panel, with its url and title, to check layout or show the user what you see. Open a page with browser_open first, or capture the one the user opened. Fails when no page is open.",
  'conductor.review':
    'Ask one or two other runtimes to review your committed changes (or those of a session you spawned). The result comes back to you as a message when the review ends.',
  'conductor.ready':
    "Declare committed changes ready: Pantheon runs the project's gate on them and lands them on the target branch. Without session_id it is your own work, and the gate starts when this turn ends; with session_id it is an idle session you spawned. The result comes back to you as a message. Refused while the latest review of that work has open blocking findings.",
  'conductor.spawn':
    'Start another session in a new worktree cut from your current commit, with the given first message. Use it for work that needs another runtime; use your own subagents otherwise. You get a message when its turn ends. At most 4 unfinished spawned sessions at a time.',
  'conductor.state':
    "Read this project's changes, their checks (gate, reviews), the landing queue and the items waiting for the user.",
};

const INVENTORY_TOOL = 'project_extensions_inventory';
const inventoryDescription =
  'List the MCP servers, plugins and skills that are on for each coding runtime. Call once before project_baseline_submit.';

type InventoryView = {
  runtime: string;
  mcp_servers: { name: string; enabled: boolean; plugin?: string }[];
  plugins: { id: string; enabled: boolean }[];
  skills: { id: string; name: string; enabled: boolean }[];
};

function inventoryText(inventories: InventoryView[]): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`) : ['- none']);
  if (!inventories.length) return 'No runtime reports its extensions.';
  return inventories
    .map((inventory) =>
      [
        `# Runtime ${inventory.runtime}`,
        'MCP servers:',
        ...list(
          inventory.mcp_servers
            .filter((server) => server.enabled)
            .map((server) => server.name + (server.plugin ? ` (plugin ${server.plugin})` : '')),
        ),
        'Plugins:',
        ...list(inventory.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.id)),
        'Skills:',
        ...list(
          inventory.skills
            .filter((skill) => skill.enabled)
            .map((skill) => skill.id + (skill.name === skill.id ? '' : ` (${skill.name})`)),
        ),
      ].join('\n'),
    )
    .join('\n\n');
}

/** The session supplies these tools' baseline and revision; the model never sees them. */
const baselineBound = (type: CommandType) =>
  type === 'project.baseline.submit_folder' || type === 'project.baseline.submit';
/** The session supplies these tools' story and revision; the model never sees them. */
const storyBound = (type: CommandType) => type === 'change_story.submit';

const browserTool = (type: CommandType) =>
  type === 'browser.open' || type === 'browser.read' || type === 'browser.screenshot';
// The daemon waits 30 s for the desktop window and answers before this.
const BROWSER_WAIT_MS = 35_000;

function browserContent(type: CommandType, answer: unknown) {
  const page = answer as BrowserPage;
  const heading = `URL: ${page.url}\nTitle: ${page.title}`;
  if (type === 'browser.screenshot')
    return [
      { type: 'image' as const, data: page.png ?? '', mimeType: 'image/png' },
      { type: 'text' as const, text: heading },
    ];
  if (type === 'browser.open') return [{ type: 'text' as const, text: heading }];
  const cut = page.truncated ? `\n\n[Text truncated at ${BROWSER_TEXT_LIMIT} characters]` : '';
  return [{ type: 'text' as const, text: `${heading}\n\n${page.text ?? ''}${cut}` }];
}

/** Input fields the session identity fills in when it has them; the model never sees them. */
const boundFields = ['project_id'] as const;

/** Leaves out of a tool's input schema the retired keys the tool accepts and ignores. */
function hideRetired({ jsonSchema }: { jsonSchema: { properties?: Record<string, unknown> } }) {
  for (const [key, field] of Object.entries(jsonSchema.properties ?? {}))
    if ((field as { retired?: boolean }).retired) delete jsonSchema.properties![key];
}

/** The expected revision a session sends for a tool, when the session rather than the model decides it. */
const boundRevision = (type: CommandType) =>
  type.startsWith('memory.') ||
  baselineBound(type) ||
  storyBound(type) ||
  type === 'visual.draw' ||
  type === 'project.intro.submit' ||
  type === 'trace.evidence' ||
  type === 'trace.report' ||
  type === 'review.verdict' ||
  type.startsWith('conductor.') ||
  browserTool(type);

// Submits after which the session ends its turn; other write receipts carry ids the next call needs.
const terminalSubmits = new Set<CommandType>([
  'project.baseline.submit_folder',
  'project.baseline.submit',
  'change_story.submit',
]);

const accepted = (type: CommandType, receipt: unknown) => {
  const fields = (['id', 'revision', 'state', 'board', 'board_problem', 'plan_version'] as const)
    .map((key) => [key, (receipt as Record<string, unknown> | null)?.[key]] as const)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  const next = (receipt as { next?: unknown } | null)?.next;
  return `Accepted ${type}${fields.length ? `: ${fields.join(', ')}` : ''}${typeof next === 'string' ? `. ${next}` : ''}`;
};

export const refused = (type: string, code: string, message?: string) =>
  `Refused ${type}: ${code}${message === undefined ? '' : ` — ${message}`}`;

/** The runtime's id of one tool call: Claude Code sends claudecode/toolUseId, Codex callId. */
const toolCallId = (meta: Record<string, unknown> | undefined) => {
  const id = meta?.['claudecode/toolUseId'] ?? meta?.callId;
  return typeof id === 'string' && id ? id : undefined;
};

// Pauses before each resend of a daemon request whose reply did not arrive.
const RESEND_DELAYS = [100, 300, 900];

/** Requests to the local daemon with token, resending those whose reply did not arrive. */
export function daemonClient(daemonUrl: string, token: string) {
  const address = new URL(daemonUrl);
  if (
    address.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new CommandError('invalid_daemon_address');
  if (!token) throw new CommandError('permission_denied');
  const request = async (
    route: string,
    body?: unknown,
    timeout = 5000,
  ): Promise<Record<string, unknown>> => {
    let response: Response, result: Record<string, unknown>;
    try {
      response = await fetch(new URL(route, address), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
      // The timeout also covers reading the body, which can break off like the request.
      result = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new CommandError('daemon_unavailable');
    }
    if (!response.ok || result.error)
      throw new CommandError(
        typeof result.error === 'string' ? result.error : 'command_refused',
        typeof result.message === 'string' ? result.message : undefined,
      );
    return result;
  };
  const retried = async (
    call: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> => {
    for (const delay of RESEND_DELAYS) {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof CommandError) || error.code !== 'daemon_unavailable') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return call();
  };
  // The daemon answers a resent command with the receipt it kept for the command's idempotency key.
  const send = (sent: Command) => retried(() => request('/v1/commands', sent));
  return { request, retried, send };
}

export async function createMcpServer(daemonUrl: string, token: string): Promise<Server> {
  const { request, retried, send } = daemonClient(daemonUrl, token);
  const authenticate = async (): Promise<Identity> => {
    const identity = (await retried(() => request('/v1/session-principal'))) as Identity;
    const principal = identity.principal;
    if (
      !principal?.session_id ||
      !principal.id ||
      !principal.project_id ||
      !principal.expires_at ||
      !Object.hasOwn(sessionTools, principal.role)
    )
      throw new CommandError('permission_denied');
    return identity;
  };
  const identity = await authenticate();
  const tools = Object.fromEntries(
    Object.entries({
      ...sessionTools[identity.principal.role as keyof typeof sessionTools],
      ...(identity.allowed_tool_names ? coordinationTools : {}),
    }).filter(
      ([, type]) => !identity.allowed_tool_names || identity.allowed_tool_names.includes(type),
    ),
  ) as Record<string, CommandType>;
  const boundInputs: Record<string, (typeof boundFields)[number][]> = {};
  const revisions = Object.fromEntries(
    Object.entries(tools).map(([name, type]) => [name, boundRevision(type)]),
  );
  const schemas = Object.fromEntries(
    Object.entries(tools).map(([name, type]) => {
      const unbound =
        type === 'project.baseline.submit_folder'
          ? inputSchemas[type].omit({ baseline_id: true })
          : type === 'project.baseline.submit'
            ? inputSchemas[type].omit({ baseline_id: true })
            : type === 'change_story.submit'
              ? inputSchemas[type].omit({ story_id: true })
              : type === 'visual.draw'
                ? visualDrawInputSchema
                : inputSchemas[type];
      boundInputs[name] = boundFields.filter(
        (field) => 'shape' in unbound && field in unbound.shape,
      );
      if (type === 'review.finding')
        return [
          name,
          inputSchemas[type].safeExtend({
            expected_revision: commandSchema.shape.expected_revision
              .default(null)
              .describe('Leave it out; this tool changes nothing that has a revision.'),
          }),
        ];
      // Shapes differ per command, so their omit signatures do not unify; the mask lists only own keys.
      // Only the user names a lead; a session's tool acts on the session's own plan.
      const hidden =
        'shape' in unbound && 'lead_session_id' in unbound.shape
          ? ['lead_session_id']
          : type === 'session.merge'
            ? ['session_id']
            : [];
      const schema = (unbound as (typeof inputSchemas)['project.read']).omit(
        Object.fromEntries([...boundInputs[name], ...hidden].map((field) => [field, true])) as {
          project_id: true;
        },
      );
      if (revisions[name]) return [name, schema];
      const withRevision = schema.extend({
        expected_revision: commandSchema.shape.expected_revision
          .default(null)
          .describe('Leave it out; this tool changes nothing that has a revision.'),
      });
      return [name, withRevision];
    }),
  );
  const server = new Server(
    { name: 'pantheon', version: PANTHEON_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      await authenticate();
      return {
        tools: [
          ...Object.entries(tools).map(([name, type]) => ({
            name,
            description: descriptions[type as ToolCommand],
            inputSchema: schemas[name]!.toJSONSchema({
              override: hideRetired,
            }) as Tool['inputSchema'],
          })),
          ...(identity.baseline_id === undefined
            ? []
            : [
                {
                  name: INVENTORY_TOOL,
                  description: inventoryDescription,
                  inputSchema: { type: 'object' as const, properties: {} },
                },
              ]),
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        error instanceof CommandError ? error.code : 'invalid_request',
      );
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const current = await authenticate();
      if (params.name === INVENTORY_TOOL && current.baseline_id !== undefined) {
        // Claude discovery may take ten seconds; the daemon gives up after twelve.
        const runtimes = current.extension_runtimes ?? [];
        const inventories = await Promise.allSettled(
          runtimes.map(
            (runtime) =>
              request(
                `/v1/extensions.inventory?${new URLSearchParams({ project_id: current.principal.project_id!, runtime })}`,
                undefined,
                15_000,
              ) as Promise<unknown> as Promise<InventoryView>,
          ),
        );
        const text = inventories.length
          ? inventories
              .map((inventory, index) => {
                if (inventory.status === 'fulfilled') return inventoryText([inventory.value]);
                const error = inventory.reason;
                return `# Runtime ${runtimes[index]}\n${refused(
                  INVENTORY_TOOL,
                  error instanceof CommandError ? error.code : 'invalid_request',
                  error instanceof CommandError ? error.daemonMessage : undefined,
                )}`;
              })
              .join('\n\n')
          : inventoryText([]);
        const none =
          runtimes.length > 0 && !inventories.some((inventory) => inventory.status === 'fulfilled');
        return { content: [{ type: 'text', text }], ...(none ? { isError: true } : {}) };
      }
      if (!Object.hasOwn(tools, params.name)) throw new CommandError('permission_denied');
      const args = Object.fromEntries(
        Object.entries(params.arguments ?? {}).filter(
          ([key]) =>
            !(boundInputs[params.name]! as string[]).includes(key) &&
            !(key === 'expected_revision' && revisions[params.name]),
        ),
      );
      const parsed =
        tools[params.name] === 'visual.draw' || tools[params.name] === 'project.intro.submit'
          ? { success: true as const, data: args }
          : schemas[params.name]!.safeParse(args);
      if (!parsed.success) throw new CommandError('invalid_request', prettifyError(parsed.error));
      const { expected_revision = null, ...fields } = parsed.data as Record<string, unknown> & {
        expected_revision?: number | null;
      };
      const input: Record<string, unknown> = fields;
      const type = tools[params.name as keyof typeof tools] as CommandType;
      if (current.allowed_tool_names && !current.allowed_tool_names.includes(type))
        throw new CommandError('permission_denied');
      if (baselineBound(type)) input.baseline_id = current.baseline_id;
      if (storyBound(type)) input.story_id = current.story_id;
      for (const field of boundInputs[params.name]!) input[field] = current.principal.project_id;
      const revision = revisions[params.name];
      const callId = toolCallId(params._meta);
      // A resent browser call would open or capture the page again.
      if (browserTool(type)) {
        const answer = await request(
          '/v1/commands',
          command(current.principal.id, type, input, null),
          BROWSER_WAIT_MS,
        );
        return { content: browserContent(type, answer.receipt) };
      }
      const result = await send(
        command(
          current.principal.id,
          type,
          input,
          revision ? null : expected_revision,
          callId === undefined
            ? undefined
            : createHash('sha256')
                .update(`tool-call:${current.principal.session_id}:${callId}`)
                .digest('hex'),
        ),
      );
      const receipt = result.receipt as Record<string, unknown> | undefined;
      if (receipt && typeof receipt === 'object' && 'error' in receipt)
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: refused(
                params.name,
                String(receipt.error),
                receipt.message === undefined ? undefined : String(receipt.message),
              ),
            },
          ],
        };
      const text =
        type === 'project.intro.submit' || type === 'trace.evidence' || type === 'trace.report'
          ? JSON.stringify(receipt)
          : terminalSubmits.has(type)
            ? accepted(type, receipt)
            : JSON.stringify(result);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: refused(
              params.name,
              error instanceof CommandError ? error.code : 'invalid_request',
              error instanceof CommandError ? error.daemonMessage : undefined,
            ),
          },
        ],
      };
    }
  });
  return server;
}
