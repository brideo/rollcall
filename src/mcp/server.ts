/**
 * Local MCP server over stdio: list_sessions and get_session.
 *
 * Read-only. It loads sessions.json and folds any events the app has not
 * processed yet, so the answer is current even when the menu bar app is
 * closed. No dependencies and no network: MCP's stdio transport is JSON-RPC,
 * one message per line.
 */
import * as readline from 'node:readline';
import { SessionView } from '../shared/fold';
import { Engine } from '../shared/store';
import { dayKey, readTasks, Task, taskForSession, todaysTasks } from '../shared/tasks';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const STATUSES = ['working', 'waiting', 'finished', 'idle'];

const SURFACES: Record<string, string> = {
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
  'com.microsoft.VSCode': 'VS Code',
  'com.microsoft.VSCodeInsiders': 'VS Code Insiders',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'dev.warp.Warp-Stable': 'Warp',
  'com.mitchellh.ghostty': 'Ghostty',
  'dev.zed.Zed': 'Zed',
  'com.anthropic.claudefordesktop': 'Claude desktop app',
};

export function surfaceName(view: Pick<SessionView, 'bundle_id' | 'term_program' | 'entrypoint'>): string | null {
  if (view.bundle_id) {
    if (SURFACES[view.bundle_id]) return SURFACES[view.bundle_id];
    if (view.bundle_id.startsWith('com.jetbrains.')) return 'JetBrains IDE';
  }
  return view.term_program || view.entrypoint || view.bundle_id || null;
}

function publicSession(view: SessionView, now: number, openTasks: Task[]) {
  return {
    session_id: view.session_id,
    project: view.project_name,
    project_path: view.project_path,
    goal: view.goal ?? 'goal unknown',
    ticket: view.ticket,
    client: view.client,
    task: taskForSession(view, openTasks)?.title ?? null,
    status: view.status === 'waiting' ? 'waiting for input' : view.status,
    waiting_reason: view.waiting_reason,
    error: view.error,
    last_event_at: new Date(view.last_event_at).toISOString(),
    minutes_since_last_event: Math.max(0, Math.round((now - view.last_event_at) / 60_000)),
    started_at: new Date(view.started_at).toISOString(),
    last_prompt: view.last_prompt,
    branch: view.branch,
    surface: surfaceName(view),
    transcript_path: view.transcript_path,
  };
}

function currentSessions(): SessionView[] {
  const engine = new Engine({ readOnly: true });
  engine.tick();
  return engine.views();
}

function openTasks(): Task[] {
  return readTasks().filter((t) => !t.done_at);
}

const TOOLS = [
  {
    name: 'list_tasks',
    description:
      "Lists today's to-do list from the session monitor: each task with its client, whether it is done, and the status of the Claude Code sessions working on it. Open tasks from earlier days carry over. Also returns the running sessions that are not linked to any task.",
    inputSchema: {
      type: 'object',
      properties: { client: { type: 'string', description: 'Only return tasks for this client (case-insensitive).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sessions',
    description:
      'Lists every Claude Code session running on this Mac (terminal, desktop app and IDE extensions): project, goal, ticket, status and time since last activity. Sessions waiting for input come first. Cloud sessions and other machines are not included.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'Only return sessions with this status.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'get_session',
    description: 'Returns one local Claude Code session by its id, or by the first characters of its id.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string', description: 'Session id or a unique prefix of it.' } },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function callTool(name: string, args: any): { text: string; isError?: boolean } {
  const now = Date.now();
  if (name === 'list_sessions') {
    const wanted = typeof args?.status === 'string' ? args.status : null;
    if (wanted && !STATUSES.includes(wanted)) {
      return { text: `Unknown status "${wanted}". Use one of: ${STATUSES.join(', ')}.`, isError: true };
    }
    const all = currentSessions();
    const open = openTasks();
    const sessions = all.filter((v) => !wanted || v.status === wanted).map((v) => publicSession(v, now, open));
    return {
      text: JSON.stringify(
        {
          generated_at: new Date(now).toISOString(),
          total: all.length,
          waiting_for_input: all.filter((v) => v.status === 'waiting').length,
          sessions,
        },
        null,
        2,
      ),
    };
  }
  if (name === 'list_tasks') {
    const wanted = typeof args?.client === 'string' ? args.client.trim().toLowerCase() : '';
    const views = currentSessions();
    const all = todaysTasks(readTasks(), views, now);
    const linked = new Set(all.flatMap((t) => t.sessions.map((s) => s.session_id)));
    const label = (status: string) => (status === 'waiting' ? 'waiting for input' : status);
    const tasks = all
      .filter((t) => !wanted || (t.client ?? '').toLowerCase() === wanted)
      .map((t) => ({
        id: t.id,
        title: t.title,
        client: t.client,
        status: label(t.status),
        done: Boolean(t.done_at),
        added_on: t.day,
        carried_over: t.carried_over,
        sessions: t.sessions.map((s) => ({ session_id: s.session_id, project: s.project_name, status: label(s.status) })),
      }));
    return {
      text: JSON.stringify(
        {
          date: dayKey(now),
          total: tasks.length,
          done: tasks.filter((t) => t.done).length,
          not_started: tasks.filter((t) => t.status === 'not started').length,
          tasks,
          sessions_without_a_task: views
            .filter((v) => !linked.has(v.session_id))
            .map((v) => ({ session_id: v.session_id, project: v.project_name, client: v.client, goal: v.goal ?? 'goal unknown', status: label(v.status) })),
        },
        null,
        2,
      ),
    };
  }
  if (name === 'get_session') {
    const id = typeof args?.session_id === 'string' ? args.session_id.trim() : '';
    if (!id) return { text: 'session_id is required.', isError: true };
    const matches = currentSessions().filter((v) => v.session_id === id || v.session_id.startsWith(id));
    if (matches.length === 0) return { text: `No running session matches "${id}". Call list_sessions for the current ids.`, isError: true };
    if (matches.length > 1 && !matches.some((v) => v.session_id === id)) {
      return { text: `"${id}" matches ${matches.length} sessions. Use more of the id.`, isError: true };
    }
    const view = matches.find((v) => v.session_id === id) ?? matches[0];
    return { text: JSON.stringify(publicSession(view, now, openTasks()), null, 2) };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

function handle(message: any): object | null {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  const result = (value: object) => (isRequest ? { jsonrpc: '2.0', id, result: value } : null);
  const error = (code: number, text: string) => (isRequest ? { jsonrpc: '2.0', id, error: { code, message: text } } : null);

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'rollcall', version: '0.1.0' },
        instructions:
          'Shows the Claude Code sessions running on this Mac. list_tasks returns the to-do list for today with the sessions working on each task; list_sessions returns every running session.',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      let outcome: { text: string; isError?: boolean };
      try {
        outcome = callTool(params?.name, params?.arguments);
      } catch (e: any) {
        outcome = { text: `Could not read the session data: ${e?.message ?? e}`, isError: true };
      }
      return result({ content: [{ type: 'text', text: outcome.text }], isError: outcome.isError ?? false });
    }
    case 'resources/list':
      return result({ resources: [] });
    case 'prompts/list':
      return result({ prompts: [] });
    default:
      return typeof method === 'string' && method.startsWith('notifications/') ? null : error(-32601, `Method not found: ${method}`);
  }
}

if (require.main === module) {
  const send = (message: object) => process.stdout.write(JSON.stringify(message) + '\n');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const reply = handle(message);
    if (reply) send(reply);
  });
  lines.on('close', () => process.exit(0));
}
