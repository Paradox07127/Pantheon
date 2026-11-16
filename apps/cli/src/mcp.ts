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
  boardPlanInputSchema,
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

class CommandError extends Error {
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
    'Read current project decisions, scoped task memory and applicable improvement procedures. Call at task start, after compaction and before accepting work. Returns signature, authority, source dependencies and omitted count. An omitted or archived entry is not current; use memory_search for targeted reading. max_bytes bounds entry payload (default 12000 UTF-8 bytes), not model tokens.',
  'memory.related':
    'Read bounded dependencies, reverse references, version relations or shared-tag matches around a current memory_id. depth is 1–2 and limit at most 30. Shared tags indicate a topic, never proof or a dependency. Uses the same task and current-state gate as memory_search; historical states require a user credential. Use memory_get for complete evidence.',
  'memory.search':
    'Search current project and your task memory by q (English FTS and literal multilingual matching). Old, expired and stale derived records are excluded. Returns compact summaries, version ids and match reasons without loading full artifacts. Filter by kind, tag, task_id or lead_session_id; state other than active requires a user credential. Use memory_get for complete evidence. Never recover archived rules from a transcript.',
  'memory.get':
    'Read one CURRENT memory version by memory_id. Not-found can mean replaced, expired or outside your task scope. Refresh memory_context rather than using an old copy.',
  'memory.propose':
    'Propose a durable decision, report or note for user review. Use a stable key, concise text, kind, optional title/summary/tags and references, based_on from memory_context and current dependency ids. Task sessions are scoped to their current task generation. This creates a draft only: your claims remain agent_reported, not verified evidence or user authorization. Use the existing propose_improvement tool for improvement procedures.',

  'visual.draw':
    'Show an inline chart or diagram in the conversation when it clarifies the answer or the user asks for one. Give title (1–120 characters), kind and spec. Use a transparent chart background and label units. Kinds: vega-lite: a Vega-Lite JSON object, at most 512 KB; data must be inline, with no data.url at any depth. kline: { candles: [{ time, open, high, low, close, volume? }], lines?: [{ name, points: [{ time, value }] }] }; 1–5000 candles, at most 8 lines, finite prices; time is an ISO date, ISO date-time or Unix seconds number, the same form throughout, strictly increasing within candles and each line. mermaid: { source: string } (1–20000 characters). graph: { nodes: [{ id, label, group? }], edges: [{ from, to, label? }], direction?: "LR" | "TB" }; 1–200 nodes with unique ids, at most 400 edges naming existing nodes. table: { columns: [{ key, title, type: "text" | "number" | "date" }], rows: [{ [key]: string | number | null }], sort?: { key, direction: "asc" | "desc" } }; use for rows of values that the reader wants to sort or scan. html: { html: string } (1–524288 characters); use only for what the other five kinds cannot express, as one self-contained document with scripts, styles and data inline. All data must be inline; nothing is loaded from the network. HTML renders in a sandboxed frame with no network access by default. Optional source is a single line of at most 500 characters naming the data file, command, URL or query. Optional size ("S", "M" or "L") chooses the conversation card height; omit it for the screen default. Optional replaces is the visual_id of an earlier chart from this session to redraw in place; its id and pin stay and revision increases. Optional pin ("S", "M" or "L") puts it on the project board; use pin only when the user asks for that. Returns visual_id and revision.',
  'review.finding':
    'Record one evidence-bound finding about the artifact under review, including deleted code. Call once for each concrete problem, quoting the artifact exactly. Set blocking to true when it must be fixed before merge, false for report-only. Blocking findings require reproduction steps or failing test evidence in reproduction.',
  'review.request':
    'Request an independent read-only cross-review of a committed worker session in your own current board plan. Read project_read to obtain its session_id; runtimes names the reviewing runtimes and must differ from the writer runtime when another runtime is available. Pantheon starts the existing reviewer sessions with isolated artifacts. Completion or failure and evidence-checked findings return as a board update; use message_task to ask the worker to fix findings. A review is evidence for your decision, not automatic task acceptance or permission to merge.',
  'project.read':
    "Read the project details, brief, milestones, event cursor, and every lead's board plan with each task's sessions and state. Call before deciding what to do. A lead also gets a lead section: the workflow policy, the first runtime, model and effort for each task kind, the experiences on trial or in force, its plan's latest retrospectives, and the signals the project's retrospectives show with the retrospective ids behind each.",
  'board.plan.update':
    "Write your whole board plan: headline, lanes, tasks with their dependencies, milestones, risks and assumptions. Each task needs source (1-4 verbatim excerpts copied from the user's messages to a lead; a quote not found there is refused; a task from an external request may quote what other people wrote in that request in external_source instead, and then source may be empty), scope (1-16 repository-relative paths or directories the task may change) and acceptance (1-8 shell commands that must pass before it is done). A task is done when its session merges; give a task without commits, such as research or a document reply, done_when report, which allows empty scope and acceptance and makes it done when you accept its done report with accept_task. Optionally give a task the runtime, model and effort of the session that works on it. Send the full plan every time; Pantheon computes task state and which sessions work on each task. The headline, lane and task titles are at most 80 characters. base_version is the plan_version of your current plan, 0 before your first plan.",
  'board.plan.edit':
    "Change your board plan by task id instead of sending it whole: 1-32 ops that add a task, remove a task, set a task's runtime, model, effort, title, lane or priority, set a task's depends_on, or resolve a pending user edit by edit_id with apply or reject and a reason. base_version is the plan_version your last project_read showed.",
  'board.plan.propose':
    "Use instead of edit_board when the change is the user's to decide: split or remove a requested task, or change its deliverable after repeated failures. Give base_version, a reason under 280 characters and 1-32 patch ops; wait for the user's decision.",
  'theme.set':
    "Make and apply a colour theme for the Pantheon app. Call only when the user asks to change how the app looks. Give label (1–40 characters) and light, dark or both; prefer both, with dark a second version of the idea rather than an inversion. Each mode has anchors, colours written #rrggbb: surface-0 is the page background and the darkest surface; surface-1, surface-2 and surface-3 are optional and each no darker than the one before; text-primary is the strongest text; text-secondary and text-muted are optional. Tint the grays with the theme's hue and keep neighbouring surfaces close. roles (accent, danger, success, warning, review) go at the top level for both modes or inside one mode; danger stays a red, success a green and warning an amber. text-primary needs 4.5:1 on surface-0, surface-1 and surface-2 (aim for 7:1), text-muted 3:1 (aim for 4.5:1) and each role 3:1 on surface-1. When contrast is too low the call fails and lists each pair with its ratio; change those colours and call again. Optional backdrop is { svg, glass? }: svg is one SVG drawn behind the app, at most 131072 characters, starting with <svg, that animates only with its own <style>; it may not contain script, foreignObject, iframe or image elements, event attributes such as onload=, href or url() other than #fragments, @import, backslash escapes or &# character references. glass is { blur (0–40), tint (#rrggbb), opacity (0–1) } for the panels over it, or false. The theme is saved and applied at once, and the user can undo it. Returns theme_id and warnings: contrast below the aim or surfaces out of order.",
  'board.plan.proposal.withdraw':
    'Take back one of your pending plan proposals by proposal_id before the user decides.',
  'milestone.accept':
    'Accept one of your milestones. Call only after project_read shows it ready_for_acceptance and you have checked its criteria; milestone_id is the id you gave it in update_board.',
  'task.start':
    "Ask Pantheon to open a session for each of 1-16 tasks of your plan, by task id; you can give every task at once. Pantheon opens a task session once all its upstream tasks are done, its scope does not overlap the scope of a running task session and a task session slot is free in the project, using the task's runtime, model and effort or the project defaults. A task that already has a session is refused. A task whose path is direct opens no session: give it alone, and you work on it yourself in your worktree until you report it done; a second direct task, or one whose scope overlaps a running task, is refused.",
  'task.message':
    'Send a message to the latest open session of one task of your plan, by task id: answer its requirement report, ask it to fix something, or add to its instructions. The session reads it with the prefix [Lead]. An idle task session starts a turn at once; a running one reads it after its current turn. A task without an open session is refused. Keep text under 2000 characters.',
  'task.accept':
    'Accept a task of your plan with done_when report, by task id, after its session sent a done report: evidence says what in the report shows the task is done. The task is then done and its milestone can be accepted. A task that is done when merged, or that has no done report, is refused.',
  'lead.note.read':
    'Read one note of your board updates in full, by the note id the update names. Use it when an update was cut short or listed by id only.',
  'lead.ask':
    'Post a question card in needs-you and return immediately; keep working on independent tasks. Supply question, 2-4 options, recommended (one of those options), assumption (how you proceed before an answer), and blocks (only the task ids that must wait for the answer; use [] when none wait). The user answers later; their answer reaches you as a lead note and wakes you. A recommendation is never submitted automatically.',
  'task.stop':
    "Stop one task of your plan, by task id, with the reason in under 400 characters: Pantheon drops its start request and discards its open sessions. The receipt lists each session's step: discarded, or stopping while Pantheon waits for its process to stop and then discards it. Once no session is left the task is todo and start_task can start it again. A task without a start request or an open session is refused. Stopping the direct task you work on gives it up and leaves your worktree as it is.",
  'session.merge':
    'Merge the session of one task of your plan, by task id, whose merge stopped because it changes files outside the task scope: give allow_out_of_scope true and the reason in under 400 characters. Pantheon refuses it when one of those files lies in the scope of another unfinished task, which it names, or changes agent configuration.',
  'task.interrupt':
    'Interrupt the running turn of the session working on one task of your plan, by task id, so a change to its runtime, model or effort takes effect now instead of when the session is next idle.',
  'task.background.stop':
    'Stop one background command or agent of the session working on one task of your plan, by task id and the background_id your board update named.',
  'improvement.propose':
    'Propose one change to the project workflow, resting on 2-20 retrospective ids from lead.retrospectives in project_read that show the same problem. change is either a policy_change (param, the tier for path, and the target value to) or an experience (procedure in at most 600 bytes, an optional countercondition, and the domain, tier and runtime it applies to, each absent for all).',
  'board.sync':
    "Use when the user asks to sync, refresh or update the board (for example 更新看板, 同步看板, 看板不对了) or says the board no longer matches the project. Returns your plan with each task's state and sessions and the recent commits of each git folder, with the rules for rewriting the plan; then send the new plan with update_board and implement nothing. To only look at the board, use project_read instead.",
  'project.baseline.start':
    'Use only when the user asks to assess the project again (for example 重新摸底, 再摸一遍底, rerun the baseline). Starts a separate read-only session that assesses the project; it costs a model run, so the user approves every call. The user confirms the result on the board, and the confirmed result comes back to you as a message to rewrite your plan. A baseline that is already running is refused. To read the current assessment, use project_read instead.',
  'task.report':
    'Tell your lead about a risk, a suggested task or dependency, or a requirement conflict. For kind done, set status to done or done_with_concerns (omitting it means done) and explain any concerns in text. If you cannot proceed, use kind blocked with reason missing_context, missing_permission, environment_problem or conflicting_requirements, and explain what is missing in text. A blocked report reaches the lead at once and your task waits for instructions, without a gate failure or a handback; if the lead is closed it appears in needs-you. Requirement reports and done reports of report tasks also wake the lead; other reports arrive with its next message. Keep text under 400 characters. A lead reports only its started direct task with kind done once its commits are in its worktree; Pantheon records that commit and report status.',
  'project.intro.submit':
    'Write the project introduction. summary: 1–280 characters; sources: 1–16 file:<relative path>, file:<relative path>:<line> or commit:<7–40 hex digits> references, with at least one resolving in a project root. features: at most 12 { title: 1–80 characters, text: 1–400 characters, sources: same rules }. modules: at most 40 { path: unique root-relative directory inside a project root, role: 1–400 characters, entry?: a file inside that directory, relative to the same root }; if several roots match path, the first is used. architecture?: graph { nodes: [{ id, label, group? }], edges: [{ from, to, label? }], direction?: "LR" | "TB" }, 1–200 nodes with unique ids, at most 400 edges naming existing nodes; one node for each module, grouped by layer, with labelled edges. body?: Markdown, at most 20000 characters. Pantheon measures all numbers: do not send lines, commits_30d, languages, weeks or heads. The project is bound to your session. Returns { written: true }; correct named fields if refused.',
  'project.baseline.submit_folder':
    'Submit the assessment of one project folder. Call once for each folder in the brief.',
  'project.baseline.submit':
    'Submit the project-wide assessment: workstreams (each with its modules, depends_on, risks and the items, sections and commits that show its progress), contradictions, questions, and tasks (next tasks with scope, acceptance and dependencies). Each question has id, header (at most 12 characters), question, 2–4 options { label, description, preview? }, multiSelect, and optional recommended and kind; preview is { kind: "graph", spec } with at most 40 nodes or { kind: "mermaid", spec: { source } }. The first round has exactly one question with kind "direction": 2–3 options, each with a preview. The last round has empty questions. Call it once after every folder and project_intro_submit are submitted, and again in each later round with the complete revised assessment; after each call end the turn.',
  'change_story.submit':
    'Submit your interpretation of the landed diff as change cards. Call once; if it returns errors, fix them and submit again, then end the turn.',
  'range_story.submit':
    'Submit what was merged in the range as lines: 1–6 lines of 1–280 characters each. Call once; if it returns errors, fix them and submit again, then end the turn.',
  'browser.open':
    "Open an http or https url in this session's browser panel in the Pantheon desktop app, which the user sees and which shares the user's cookies and logins. Works only while the user is viewing this session; otherwise fails with browser_busy. Shows the panel and waits for the page to load; returns the final url and title. Fails when no desktop window is connected.",
  'browser.read':
    "Read the page open in this session's browser panel: its url, title and visible text, at most 50000 characters, noting when the text was cut. Open a page with browser_open first, or read the one the user opened.",
  'browser.screenshot':
    "Take a PNG screenshot of the page open in this session's browser panel, with its url and title. Open a page with browser_open first, or capture the one the user opened.",
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
const storyBound = (type: CommandType) =>
  type === 'change_story.submit' || type === 'range_story.submit';

const browserTool = (type: CommandType) =>
  type === 'browser.open' || type === 'browser.read' || type === 'browser.screenshot';
// The daemon waits 30 s for the desktop window and answers before this.
const BROWSER_WAIT_MS = 35_000;

function browserContent(type: CommandType, page: BrowserPage) {
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

/** The expected revision a session sends for a tool, when the session rather than the model decides it. */
const boundRevision = (type: CommandType) =>
  type.startsWith('memory.') ||
  baselineBound(type) ||
  storyBound(type) ||
  type === 'board.plan.update' ||
  type === 'board.plan.edit' ||
  type === 'board.plan.propose' ||
  type === 'board.plan.proposal.withdraw' ||
  type === 'milestone.accept' ||
  type === 'task.start' ||
  type === 'task.message' ||
  type === 'task.accept' ||
  type === 'task.stop' ||
  type === 'task.interrupt' ||
  type === 'task.background.stop' ||
  type === 'session.merge' ||
  type === 'task.report' ||
  type === 'visual.draw' ||
  type === 'theme.set' ||
  type === 'project.intro.submit' ||
  type === 'review.request' ||
  type === 'trace.evidence' ||
  type === 'trace.report' ||
  type === 'lead.note.read' ||
  type === 'lead.ask' ||
  type === 'board.sync' ||
  type === 'project.baseline.start' ||
  browserTool(type);

// Submits after which the session ends its turn; other write receipts carry ids the next call needs.
const terminalSubmits = new Set<CommandType>([
  'project.baseline.submit_folder',
  'project.baseline.submit',
  'change_story.submit',
  'range_story.submit',
]);

const accepted = (type: CommandType, receipt: unknown) => {
  const fields = (['id', 'revision', 'state', 'board', 'board_problem', 'plan_version'] as const)
    .map((key) => [key, (receipt as Record<string, unknown> | null)?.[key]] as const)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return `Accepted ${type}${fields.length ? `: ${fields.join(', ')}` : ''}`;
};

const refused = (type: string, code: string, message?: string) =>
  `Refused ${type}: ${code}${message === undefined ? '' : ` — ${message}`}`;

/** The runtime's id of one tool call: Claude Code sends claudecode/toolUseId, Codex callId. */
const toolCallId = (meta: Record<string, unknown> | undefined) => {
  const id = meta?.['claudecode/toolUseId'] ?? meta?.callId;
  return typeof id === 'string' && id ? id : undefined;
};

// Pauses before each resend of a command whose reply did not arrive.
const RESEND_DELAYS = [100, 300, 900];

export async function createMcpServer(daemonUrl: string, token: string): Promise<Server> {
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
  // The daemon answers a resent command with the receipt it kept for the command's idempotency key.
  const send = async (sent: Command): Promise<Record<string, unknown>> => {
    for (const delay of RESEND_DELAYS) {
      try {
        return await request('/v1/commands', sent);
      } catch (error) {
        if (!(error instanceof CommandError) || error.code !== 'daemon_unavailable') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return request('/v1/commands', sent);
  };
  const authenticate = async (): Promise<Identity> => {
    const identity = (await request('/v1/session-principal')) as Identity;
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
              : type === 'range_story.submit'
                ? inputSchemas[type].omit({ story_id: true })
                : type === 'board.plan.update'
                  ? boardPlanInputSchema
                  : type === 'visual.draw'
                    ? visualDrawInputSchema
                    : inputSchemas[type];
      boundInputs[name] = boundFields.filter(
        (field) => 'shape' in unbound && field in unbound.shape,
      );
      // The theme schema carries a refinement, which omit refuses; it has no bound fields.
      if (type === 'theme.set') return [name, unbound];
      if (type === 'review.finding')
        return [
          name,
          inputSchemas[type].safeExtend({
            expected_revision: commandSchema.shape.expected_revision.default(null),
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
        expected_revision: commandSchema.shape.expected_revision.default(null),
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
            inputSchema: schemas[name]!.toJSONSchema() as Tool['inputSchema'],
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
    const label = Object.hasOwn(tools, params.name) ? tools[params.name]! : params.name;
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
        return { content: browserContent(type, answer.receipt as BrowserPage) };
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
                type,
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
              label,
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
