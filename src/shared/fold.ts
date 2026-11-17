/**
 * Pure state folding: hook events in, one record per session out.
 * No file or clock access here, so every rule is unit-testable.
 */
import * as path from 'node:path';

export type Status = 'working' | 'waiting' | 'finished' | 'idle';

export interface HookEvent {
  ts: number;
  event: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  prompt?: string;
  source?: string;
  notification_type?: string;
  message?: string;
  reason?: string;
  tool_name?: string;
  agent_id?: string;
  error?: string;
  bundle_id?: string;
  term_program?: string;
  entrypoint?: string;
}

export interface SessionRecord {
  session_id: string;
  project_path: string;
  transcript_path: string | null;
  /** Status from the latest event, before the idle rule is applied. */
  base_status: Status;
  started_at: number;
  last_event_at: number;
  last_event: string;
  last_prompt: string | null;
  /** First prompt seen through hooks. The transcript wins when it can be read. */
  first_prompt: string | null;
  goal_auto: string | null;
  goal_source: 'transcript' | 'prompt' | null;
  transcript_tries: number;
  ticket_auto: string | null;
  branch: string | null;
  waiting_since: number | null;
  waiting_reason: string | null;
  waiting_tool: string | null;
  error: string | null;
  bundle_id: string | null;
  term_program: string | null;
  entrypoint: string | null;
  permission_mode: string | null;
}

export interface SessionView extends SessionRecord {
  project_name: string;
  goal: string | null;
  goal_edited: boolean;
  ticket: string | null;
  /** Client this project belongs to, set per project path. */
  client: string | null;
  /** Task the user linked this session to by hand. */
  task_id: string | null;
  status: Status;
}

export interface Overrides {
  sessions: Record<string, { goal?: string; ticket?: string; task_id?: string; updated_at: number }>;
  aliases: Record<string, string>;
  /** Project path -> client name. */
  clients: Record<string, string>;
}

export interface Config {
  idle_minutes: number;
  drop_after_hours: number;
  rotate_mb: number;
  /** When set, only these ticket prefixes are detected, e.g. ["SHOP", "BLOG"]. */
  ticket_prefixes: string[];
}

export const DEFAULT_CONFIG: Config = {
  idle_minutes: 30,
  drop_after_hours: 12,
  rotate_mb: 5,
  ticket_prefixes: [],
};

export const GOAL_MAX = 120;
export const PROMPT_MAX = 200;

/** A sibling tool finishing this soon after a permission prompt does not clear it. */
const PARALLEL_TOOL_GRACE_MS = 10_000;

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);
const RESUMED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

export function parseEventLine(line: string): HookEvent | null {
  if (!line || line.length > 64 * 1024) return null;
  try {
    const ev = JSON.parse(line);
    if (!ev || typeof ev !== 'object') return null;
    if (typeof ev.session_id !== 'string' || !ev.session_id) return null;
    if (typeof ev.event !== 'string' || typeof ev.ts !== 'number' || !Number.isFinite(ev.ts)) return null;
    return ev as HookEvent;
  } catch {
    return null;
  }
}

function setWaiting(rec: SessionRecord, ts: number, reason: string, tool: string | null): void {
  if (rec.base_status !== 'waiting') rec.waiting_since = ts;
  rec.base_status = 'waiting';
  rec.waiting_reason = reason;
  rec.waiting_tool = tool ?? rec.waiting_tool;
}

function setStatus(rec: SessionRecord, status: Exclude<Status, 'waiting'>): void {
  rec.base_status = status;
  rec.waiting_since = null;
  rec.waiting_reason = null;
  rec.waiting_tool = null;
}

/**
 * Applies one event. Returns the session id it touched, or null when the
 * event was ignored or removed the session.
 */
export function applyEvent(records: Map<string, SessionRecord>, ev: HookEvent): string | null {
  if (ev.event === 'SessionEnd') {
    records.delete(ev.session_id);
    return null;
  }

  let rec = records.get(ev.session_id);
  const isNew = !rec;
  if (!rec) {
    rec = {
      session_id: ev.session_id,
      project_path: ev.cwd ?? '',
      transcript_path: null,
      // A session that has not been given a prompt yet is not working on anything.
      base_status: 'idle',
      started_at: ev.ts,
      last_event_at: ev.ts,
      last_event: ev.event,
      last_prompt: null,
      first_prompt: null,
      goal_auto: null,
      goal_source: null,
      transcript_tries: 0,
      ticket_auto: null,
      branch: null,
      waiting_since: null,
      waiting_reason: null,
      waiting_tool: null,
      error: null,
      bundle_id: null,
      term_program: null,
      entrypoint: null,
      permission_mode: null,
    };
    records.set(ev.session_id, rec);
  }

  rec.last_event_at = ev.ts;
  rec.last_event = ev.event;
  if (ev.transcript_path) rec.transcript_path = ev.transcript_path;
  if (ev.bundle_id) rec.bundle_id = ev.bundle_id;
  if (ev.term_program) rec.term_program = ev.term_program;
  if (ev.entrypoint) rec.entrypoint = ev.entrypoint;
  if (ev.permission_mode) rec.permission_mode = ev.permission_mode;
  if (!rec.project_path && ev.cwd) rec.project_path = ev.cwd;

  switch (ev.event) {
    case 'SessionStart':
      if (ev.cwd) rec.project_path = ev.cwd;
      // Compaction happens mid-turn; every other start leaves the status alone.
      if (isNew && ev.source === 'compact') setStatus(rec, 'working');
      break;

    case 'UserPromptSubmit':
      setStatus(rec, 'working');
      rec.error = null;
      if (ev.prompt) {
        rec.last_prompt = truncate(ev.prompt, PROMPT_MAX);
        if (!rec.first_prompt) rec.first_prompt = ev.prompt;
        if (!rec.goal_auto) {
          rec.goal_auto = truncate(ev.prompt, GOAL_MAX);
          rec.goal_source = 'prompt';
        }
      }
      break;

    case 'Notification': {
      const type = ev.notification_type;
      if (!type || WAITING_NOTIFICATIONS.has(type)) {
        setWaiting(rec, ev.ts, ev.message || 'Waiting for input', null);
      } else if (RESUMED_NOTIFICATIONS.has(type)) {
        setStatus(rec, 'working');
      } else if (type === 'idle_prompt' && rec.base_status === 'working') {
        // Claude finished a minute ago and the Stop event was missed.
        setStatus(rec, 'finished');
      }
      break;
    }

    case 'PermissionRequest':
      setWaiting(rec, ev.ts, ev.tool_name ? `Permission needed: ${ev.tool_name}` : 'Permission needed', ev.tool_name ?? null);
      break;

    case 'PreToolUse':
      // Only registered for the tools that stop and ask the user something.
      if (ev.tool_name === 'AskUserQuestion') setWaiting(rec, ev.ts, 'Asked you a question', ev.tool_name);
      else if (ev.tool_name === 'ExitPlanMode') setWaiting(rec, ev.ts, 'Plan ready for approval', ev.tool_name);
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const parallelSibling =
        rec.base_status === 'waiting' &&
        rec.waiting_tool !== null &&
        ev.tool_name !== rec.waiting_tool &&
        rec.waiting_since !== null &&
        ev.ts - rec.waiting_since < PARALLEL_TOOL_GRACE_MS;
      if (!parallelSibling) setStatus(rec, 'working');
      break;
    }

    case 'Stop':
      setStatus(rec, 'finished');
      break;

    case 'StopFailure':
      setStatus(rec, 'finished');
      rec.error = ev.error ?? 'unknown';
      break;

    default:
      break;
  }

  return rec.session_id;
}

export function isExpired(rec: SessionRecord, config: Config, now: number): boolean {
  return now - rec.last_event_at > config.drop_after_hours * 3_600_000;
}

/** Applies user edits, the project alias and the idle rule. */
export function toView(rec: SessionRecord, overrides: Overrides, config: Config, now: number): SessionView {
  const edit = overrides.sessions[rec.session_id];
  const quiet = now - rec.last_event_at > config.idle_minutes * 60_000;
  // A session still waiting on the user keeps saying so, however long it has been.
  const status: Status = quiet && rec.base_status !== 'waiting' ? 'idle' : rec.base_status;
  return {
    ...rec,
    project_name: overrides.aliases[rec.project_path] || path.basename(rec.project_path) || 'Unknown project',
    goal: edit?.goal || rec.goal_auto,
    goal_edited: Boolean(edit?.goal),
    ticket: edit?.ticket || rec.ticket_auto,
    client: overrides.clients[rec.project_path] || null,
    task_id: edit?.task_id || null,
    status,
  };
}

const STATUS_ORDER: Record<Status, number> = { waiting: 0, working: 1, finished: 2, idle: 3 };

export function sortViews(views: SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.last_event_at - a.last_event_at,
  );
}
