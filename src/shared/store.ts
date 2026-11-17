/**
 * Everything that touches ~/.claude-monitor: the event log, sessions.json,
 * user edits and config. Every read fails soft so a broken file never stops
 * the app.
 */
import * as fs from 'node:fs';
import {
  applyEvent,
  Config,
  DEFAULT_CONFIG,
  GOAL_MAX,
  isExpired,
  Overrides,
  parseEventLine,
  SessionRecord,
  SessionView,
  sortViews,
  toView,
  truncate,
} from './fold';
import { paths } from './paths';
import { detectTicket, readBranch } from './ticket';
import { firstUserPrompt } from './transcript';

const CHUNK = 1024 * 1024;
const TRANSCRIPT_TRIES = 3;
const OVERRIDE_KEEP_MS = 30 * 24 * 3_600_000;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readConfig(): Config {
  const raw = readJson(paths().config) ?? {};
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    idle_minutes: num(raw.idle_minutes, DEFAULT_CONFIG.idle_minutes),
    drop_after_hours: num(raw.drop_after_hours, DEFAULT_CONFIG.drop_after_hours),
    rotate_mb: num(raw.rotate_mb, DEFAULT_CONFIG.rotate_mb),
    ticket_prefixes: Array.isArray(raw.ticket_prefixes)
      ? raw.ticket_prefixes.filter((p: unknown): p is string => typeof p === 'string')
      : [],
  };
}

export function readOverrides(): Overrides {
  const raw = readJson(paths().overrides) ?? {};
  const isMap = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return {
    sessions: isMap(raw.sessions) ? raw.sessions : {},
    aliases: isMap(raw.aliases) ? raw.aliases : {},
    clients: isMap(raw.clients) ? raw.clients : {},
  };
}

function writeOverrides(overrides: Overrides): void {
  const cutoff = Date.now() - OVERRIDE_KEEP_MS;
  for (const [id, edit] of Object.entries(overrides.sessions)) {
    if (!edit || (edit.updated_at ?? 0) < cutoff || (!edit.goal && !edit.ticket && !edit.task_id)) delete overrides.sessions[id];
  }
  fs.mkdirSync(paths().dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(paths().overrides, overrides);
}

/** Saves a user edit. An empty string clears the edit and falls back to the detected value. */
export function saveSessionEdit(sessionId: string, edit: { goal?: string; ticket?: string; task_id?: string }): void {
  const overrides = readOverrides();
  const current = overrides.sessions[sessionId] ?? { updated_at: 0 };
  if (edit.goal !== undefined) current.goal = truncate(edit.goal, GOAL_MAX) || undefined;
  if (edit.ticket !== undefined) current.ticket = edit.ticket.trim().toUpperCase().slice(0, 40) || undefined;
  if (edit.task_id !== undefined) current.task_id = edit.task_id.slice(0, 80) || undefined;
  current.updated_at = Date.now();
  overrides.sessions[sessionId] = current;
  writeOverrides(overrides);
}

/** Sets the display name for a project path. An empty string removes it. */
export function saveAlias(projectPath: string, alias: string): void {
  if (!projectPath) return;
  const overrides = readOverrides();
  const name = alias.trim().slice(0, 60);
  if (name) overrides.aliases[projectPath] = name;
  else delete overrides.aliases[projectPath];
  writeOverrides(overrides);
}

/** Sets the client for a project path. An empty string removes it. */
export function saveClient(projectPath: string, client: string): void {
  if (!projectPath) return;
  const overrides = readOverrides();
  const name = client.trim().slice(0, 60);
  if (name) overrides.clients[projectPath] = name;
  else delete overrides.clients[projectPath];
  writeOverrides(overrides);
}

export interface EngineOptions {
  /** Fold in memory only: no sessions.json writes and no log rotation. Used by the MCP server. */
  readOnly?: boolean;
  now?: () => number;
}

export class Engine {
  private records = new Map<string, SessionRecord>();
  private offset = 0;
  private lastWritten = '';
  private config: Config = DEFAULT_CONFIG;
  private overrides: Overrides = { sessions: {}, aliases: {}, clients: {} };
  private readonly readOnly: boolean;
  private readonly now: () => number;

  constructor(opts: EngineOptions = {}) {
    this.readOnly = opts.readOnly ?? false;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  /** Picks up where the last run stopped. A missing or broken sessions.json means refolding the log. */
  private load(): void {
    const saved = readJson(paths().sessions);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.sessions)) return;
    for (const rec of saved.sessions) {
      if (rec && typeof rec.session_id === 'string' && typeof rec.last_event_at === 'number') {
        this.records.set(rec.session_id, rec);
      }
    }
    if (typeof saved.cursor?.offset === 'number' && saved.cursor.offset >= 0) this.offset = saved.cursor.offset;
  }

  /** Folds new events, applies the idle and drop rules, and saves. Returns true when anything changed. */
  tick(): boolean {
    try {
      return this.run();
    } catch {
      return false;
    }
  }

  private run(): boolean {
    const p = paths();
    this.config = readConfig();
    this.overrides = readOverrides();

    const touched = new Set<string>();
    this.offset = this.consume(p.events, this.offset, touched);

    if (!this.readOnly) {
      let size = 0;
      try {
        size = fs.statSync(p.events).size;
      } catch {
        // no log yet
      }
      if (size > this.config.rotate_mb * 1024 * 1024) {
        try {
          fs.renameSync(p.events, p.rotated);
          // Catch anything a hook appended between the last read and the rename.
          this.consume(p.rotated, this.offset, touched);
          this.offset = 0;
        } catch {
          // keep reading the same file
        }
      }
    }

    for (const id of touched) {
      const rec = this.records.get(id);
      if (rec) this.enrich(rec);
    }

    const now = this.now();
    for (const [id, rec] of this.records) {
      if (isExpired(rec, this.config, now)) this.records.delete(id);
    }

    return this.readOnly ? touched.size > 0 : this.persist();
  }

  /** Reads complete lines from `from` to the end of the file. Returns the new offset. */
  private consume(file: string, from: number, touched: Set<string>): number {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return 0;
    }
    try {
      const size = fs.fstatSync(fd).size;
      // A shorter file than last time was truncated or replaced: start again.
      let offset = from > size ? 0 : from;
      let carry: Buffer = Buffer.alloc(0);
      const chunk = Buffer.alloc(CHUNK);

      while (offset + carry.length < size) {
        const read = fs.readSync(fd, chunk, 0, CHUNK, offset + carry.length);
        if (read <= 0) break;
        const data = Buffer.concat([carry, chunk.subarray(0, read)]);
        const lastNewline = data.lastIndexOf(10);
        if (lastNewline === -1) {
          carry = data;
          // A "line" this long is junk; skip it rather than hold it in memory.
          if (carry.length > 8 * CHUNK) {
            offset += carry.length;
            carry = Buffer.alloc(0);
          }
          continue;
        }
        for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) {
          const ev = parseEventLine(line);
          if (!ev) continue;
          const id = applyEvent(this.records, ev);
          if (id) touched.add(id);
          else touched.delete(ev.session_id);
        }
        offset += lastNewline + 1;
        carry = Buffer.from(data.subarray(lastNewline + 1));
      }
      // A partial last line stays unread until the hook finishes writing it.
      return offset;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Fills in what the hooks do not carry: the branch, the ticket and the first prompt. */
  private enrich(rec: SessionRecord): void {
    rec.branch = readBranch(rec.project_path);

    if (rec.goal_source !== 'transcript' && rec.transcript_tries < TRANSCRIPT_TRIES) {
      rec.transcript_tries += 1;
      const prompt = firstUserPrompt(rec.transcript_path);
      if (prompt) {
        rec.first_prompt = prompt.slice(0, 2000);
        rec.goal_auto = truncate(prompt, GOAL_MAX);
        rec.goal_source = 'transcript';
      }
    }

    const prefixes = this.config.ticket_prefixes;
    rec.ticket_auto =
      detectTicket(rec.branch, { anyCase: true, prefixes }) ?? detectTicket(rec.first_prompt, { anyCase: false, prefixes });
  }

  private persist(): boolean {
    const body = { version: 1, cursor: { offset: this.offset }, sessions: this.views() };
    const serialised = JSON.stringify(body);
    if (serialised === this.lastWritten) return false;
    fs.mkdirSync(paths().dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(paths().sessions, { updated_at: new Date(this.now()).toISOString(), ...body });
    this.lastWritten = serialised;
    return true;
  }

  /** Current sessions, most urgent first. */
  views(): SessionView[] {
    const now = this.now();
    return sortViews([...this.records.values()].map((rec) => toView(rec, this.overrides, this.config, now)));
  }

  /** Size of the event log the engine has not read yet. Cheap enough to poll. */
  hasNewEvents(): boolean {
    try {
      return fs.statSync(paths().events).size !== this.offset;
    } catch {
      return this.offset !== 0;
    }
  }

  idleMinutes(): number {
    return this.config.idle_minutes;
  }
}
