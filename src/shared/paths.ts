import * as os from 'node:os';
import * as path from 'node:path';

/** Data directory. CLAUDE_MONITOR_HOME overrides it (used by the tests). */
export function dataDir(): string {
  return process.env.CLAUDE_MONITOR_HOME || path.join(os.homedir(), '.claude-monitor');
}

export function paths() {
  const dir = dataDir();
  return {
    dir,
    events: path.join(dir, 'events.jsonl'),
    rotated: path.join(dir, 'events.1.jsonl'),
    sessions: path.join(dir, 'sessions.json'),
    overrides: path.join(dir, 'overrides.json'),
    config: path.join(dir, 'config.json'),
    tasks: path.join(dir, 'tasks.json'),
    hookJs: path.join(dir, 'hook.js'),
    hookSh: path.join(dir, 'hook.sh'),
    installState: path.join(dir, 'install-state.json'),
    settingsBackup: path.join(dir, 'settings.backup.json'),
  };
}

/** Claude Code user settings. CLAUDE_MONITOR_SETTINGS overrides it (used by the tests). */
export function settingsPath(): string {
  if (process.env.CLAUDE_MONITOR_SETTINGS) return process.env.CLAUDE_MONITOR_SETTINGS;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'settings.json');
}
