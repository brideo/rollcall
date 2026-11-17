/**
 * Installs and removes the monitor's hook entries in Claude Code's user
 * settings. Other hooks are left alone, and uninstall removes only what this
 * installer added.
 *
 *   node dist/src/cli/install.js install | uninstall | status
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { paths, settingsPath } from '../shared/paths';

interface HookSpec {
  event: string;
  matcher?: string;
  async?: boolean;
}

/** Event names checked against the Claude Code hooks reference on 17 Nov 2026. */
export const HOOK_SPECS: HookSpec[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'Notification' },
  { event: 'PermissionRequest' },
  // The two tools that stop and wait for the user without a permission prompt.
  { event: 'PreToolUse', matcher: 'AskUserQuestion|ExitPlanMode' },
  // After every tool call, so these run in the background and never slow a turn.
  { event: 'PostToolUse', async: true },
  { event: 'PostToolUseFailure', async: true },
  { event: 'Stop' },
  { event: 'StopFailure' },
  { event: 'SessionEnd' },
];

function hookCommand(): string {
  return `"${paths().hookSh}"`;
}

function isOurs(handler: any): boolean {
  return Boolean(handler) && typeof handler.command === 'string' && handler.command.includes(paths().hookSh);
}

function readSettings(file: string): { raw: string | null; json: any } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error: any) {
    if (error.code === 'ENOENT') return { raw: null, json: {} };
    throw error;
  }
  if (!raw.trim()) return { raw, json: {} };
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON. Nothing was changed; fix the file and try again.`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(`${file} does not hold a JSON object. Nothing was changed.`);
  }
  return { raw, json };
}

/** Writes in the file's own indentation so the diff is only the hook entries. */
function writeSettings(file: string, json: any, previousRaw: string | null): void {
  const indent = previousRaw?.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const newline = previousRaw === null || previousRaw.endsWith('\n') ? '\n' : '';
  let target = file;
  try {
    target = fs.realpathSync(file); // keep a symlinked dotfile a symlink
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${target}.claude-monitor.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(json, null, indent) + newline);
  try {
    fs.chmodSync(tmp, fs.statSync(target).mode);
  } catch {
    // new file: default mode
  }
  fs.renameSync(tmp, target);
}

function removeOurEntries(json: any): boolean {
  if (!json.hooks || typeof json.hooks !== 'object') return false;
  let removed = false;
  for (const event of Object.keys(json.hooks)) {
    const groups = json.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks) || !group.hooks.some(isOurs)) {
        kept.push(group);
        continue;
      }
      removed = true;
      const others = group.hooks.filter((handler: any) => !isOurs(handler));
      if (others.length) kept.push({ ...group, hooks: others });
    }
    if (kept.length) json.hooks[event] = kept;
    else if (removed) delete json.hooks[event];
  }
  return removed;
}

function writeHookFiles(): void {
  const p = paths();
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, '..', 'hook', 'hook.js'), p.hookJs);
  // The wrapper exits 0 whatever happens, so a missing Node can never fail a session.
  const wrapper = [
    '#!/bin/sh',
    '# Claude Code Session Monitor hook. Appends one line to events.jsonl.',
    `NODE="${process.execPath}"`,
    '[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null)"',
    '[ -n "$NODE" ] || exit 0',
    `"$NODE" "${p.hookJs}" >/dev/null 2>&1`,
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(p.hookSh, wrapper, { mode: 0o755 });
  fs.chmodSync(p.hookSh, 0o755);
}

export function install(): string {
  const file = settingsPath();
  const p = paths();
  const { raw, json } = readSettings(file);
  writeHookFiles();

  // Keep the pre-install file once, so uninstall can put it back byte for byte.
  if (!status().installed) {
    if (raw !== null) fs.writeFileSync(p.settingsBackup, raw, { mode: 0o600 });
    fs.writeFileSync(p.installState, JSON.stringify({ settings_existed: raw !== null, hooks_key_existed: 'hooks' in json }));
  }

  removeOurEntries(json); // reinstalling refreshes the entries rather than doubling them
  if (!json.hooks || typeof json.hooks !== 'object' || Array.isArray(json.hooks)) json.hooks = {};
  for (const spec of HOOK_SPECS) {
    const handler: Record<string, unknown> = { type: 'command', command: hookCommand(), timeout: 5 };
    if (spec.async) handler.async = true;
    const group: Record<string, unknown> = spec.matcher ? { matcher: spec.matcher, hooks: [handler] } : { hooks: [handler] };
    if (!Array.isArray(json.hooks[spec.event])) json.hooks[spec.event] = [];
    json.hooks[spec.event].push(group);
  }
  writeSettings(file, json, raw);
  return `Installed ${HOOK_SPECS.length} hook entries in ${file}. New sessions pick them up; restart running ones.`;
}

export function uninstall(): string {
  const file = settingsPath();
  const p = paths();
  const { raw, json } = readSettings(file);
  if (raw === null) return `Nothing to remove: ${file} does not exist.`;

  let state: any = {};
  try {
    state = JSON.parse(fs.readFileSync(p.installState, 'utf8'));
  } catch {
    // installed by an older copy, or state lost: fall back to removing entries only
  }

  if (!removeOurEntries(json)) return `Nothing to remove: no monitor hooks in ${file}.`;
  if (state.hooks_key_existed === false && json.hooks && Object.keys(json.hooks).length === 0) delete json.hooks;

  let backupRaw: string | null = null;
  try {
    backupRaw = fs.readFileSync(p.settingsBackup, 'utf8');
  } catch {
    // no backup
  }

  if (state.settings_existed === false && Object.keys(json).length === 0) {
    fs.unlinkSync(file);
  } else if (backupRaw !== null && backupRaw.trim() && isDeepStrictEqual(JSON.parse(backupRaw), json)) {
    // Nothing else changed since install: restore the original bytes exactly.
    fs.writeFileSync(fs.realpathSync(file), backupRaw);
  } else {
    writeSettings(file, json, raw);
  }

  for (const leftover of [p.hookJs, p.hookSh, p.installState, p.settingsBackup]) {
    fs.rmSync(leftover, { force: true });
  }
  return `Removed the monitor hooks from ${file}. Session data in ${p.dir} was kept.`;
}

export function status(): { installed: boolean; events: string[]; settings: string } {
  const file = settingsPath();
  let json: any = {};
  try {
    json = readSettings(file).json;
  } catch {
    // unreadable settings count as not installed
  }
  const events: string[] = [];
  for (const [event, groups] of Object.entries(json.hooks ?? {})) {
    if (Array.isArray(groups) && groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isOurs))) events.push(event);
  }
  const installed = HOOK_SPECS.every((spec) => events.includes(spec.event)) && fs.existsSync(paths().hookSh);
  return { installed, events, settings: file };
}

if (require.main === module) {
  const command = process.argv[2];
  try {
    if (command === 'install') console.log(install());
    else if (command === 'uninstall') console.log(uninstall());
    else if (command === 'status') {
      const s = status();
      console.log(s.installed ? `Installed in ${s.settings} (${s.events.join(', ')}).` : `Not installed in ${s.settings}.`);
    } else {
      console.error('Usage: install.js install | uninstall | status');
      process.exitCode = 2;
    }
  } catch (error: any) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
