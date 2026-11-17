/**
 * Claude Code hook: appends one trimmed JSON line per session event to
 * ~/.claude-monitor/events.jsonl and exits.
 *
 * Rules: no dependencies beyond Node built-ins, nothing on stdout (stdout from
 * SessionStart and UserPromptSubmit hooks is added to Claude's context), and
 * never a non-zero exit. This file is copied to ~/.claude-monitor/hook.js by
 * the installer, so it must stay self-contained.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function main(): void {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!payload || typeof payload.session_id !== 'string' || typeof payload.hook_event_name !== 'string') return;

  // Only the fields the monitor uses. Tool inputs and responses are dropped so
  // the log stays small and holds no file contents.
  const event: Record<string, unknown> = {
    ts: Date.now(),
    event: payload.hook_event_name,
    session_id: payload.session_id,
    cwd: str(payload.cwd, 1024),
    transcript_path: str(payload.transcript_path, 1024),
    permission_mode: str(payload.permission_mode, 40),
    prompt: str(payload.prompt, 2000),
    source: str(payload.source, 40),
    notification_type: str(payload.notification_type, 60),
    message: str(payload.message, 300),
    reason: str(payload.reason, 60),
    tool_name: str(payload.tool_name, 120),
    agent_id: str(payload.agent_id, 80),
    error: str(payload.error, 80),
    bundle_id: str(process.env.__CFBundleIdentifier, 120),
    term_program: str(process.env.TERM_PROGRAM, 60),
    entrypoint: str(process.env.CLAUDE_CODE_ENTRYPOINT, 60),
  };

  const dir = process.env.CLAUDE_MONITOR_HOME || path.join(os.homedir(), '.claude-monitor');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
}

try {
  main();
} catch {
  // Never block or fail the session.
}
