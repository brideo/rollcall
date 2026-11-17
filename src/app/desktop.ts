/**
 * Opens a session's chat in the Claude desktop app.
 *
 * Undocumented: the `claude://code/continue?session=` link and the session
 * files under Application Support were read out of the desktop app (checked
 * 18 Nov 2026) and can change in any release. Everything here fails soft and
 * returns null, and the caller falls back to bringing the app forward.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DESKTOP_BUNDLE_ID = 'com.anthropic.claudefordesktop';

const SESSIONS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const LOCAL_ID = /^local_[A-Za-z0-9_-]+$/;

/** Claude Code session id -> desktop app session id. */
const known = new Map<string, string>();
/** Session files already read, by path, with the mtime they were read at. */
const seen = new Map<string, number>();

function scan(): void {
  // Layout: claude-code-sessions/<account>/<workspace>/local_<id>.json
  for (const account of fs.readdirSync(SESSIONS_DIR)) {
    const accountDir = path.join(SESSIONS_DIR, account);
    if (!fs.statSync(accountDir).isDirectory()) continue;
    for (const workspace of fs.readdirSync(accountDir)) {
      const workspaceDir = path.join(accountDir, workspace);
      if (!fs.statSync(workspaceDir).isDirectory()) continue;
      for (const name of fs.readdirSync(workspaceDir)) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const file = path.join(workspaceDir, name);
        try {
          const mtime = fs.statSync(file).mtimeMs;
          if (seen.get(file) === mtime) continue;
          seen.set(file, mtime);
          const session = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (typeof session.sessionId !== 'string' || !LOCAL_ID.test(session.sessionId)) continue;
          // Resuming gives a session a new Claude Code id; both point at the same chat.
          for (const cliId of [session.cliSessionId, session.lastAssistantCliSessionId]) {
            if (typeof cliId === 'string' && cliId) known.set(cliId, session.sessionId);
          }
        } catch {
          // one unreadable file does not stop the rest
        }
      }
    }
  }
}

/** Link that opens this Claude Code session's chat in the desktop app, or null. */
export function desktopSessionUrl(cliSessionId: string): string | null {
  try {
    if (!known.has(cliSessionId)) scan();
    const localId = known.get(cliSessionId);
    return localId ? `claude://code/continue?session=${encodeURIComponent(localId)}` : null;
  } catch {
    return null;
  }
}
