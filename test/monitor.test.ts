import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, test } from 'node:test';
import { install, status, uninstall } from '../src/cli/install';
import { applyEvent, DEFAULT_CONFIG, HookEvent, SessionRecord, toView } from '../src/shared/fold';
import { paths } from '../src/shared/paths';
import { Engine, saveAlias, saveClient, saveSessionEdit } from '../src/shared/store';
import { addTask, readTasks, setTaskDone, todaysTasks } from '../src/shared/tasks';
import { detectTicket } from '../src/shared/ticket';
import { firstUserPrompt } from '../src/shared/transcript';

const DIST = path.join(__dirname, '..', 'src');
const NO_EDITS = { sessions: {}, aliases: {}, clients: {} };
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-monitor-test-'));
  process.env.CLAUDE_MONITOR_HOME = path.join(home, 'monitor');
  process.env.CLAUDE_MONITOR_SETTINGS = path.join(home, 'claude', 'settings.json');
  fs.mkdirSync(path.join(home, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(home, 'monitor'), { recursive: true });
});

function ev(event: string, extra: Partial<HookEvent> = {}): HookEvent {
  return { ts: 1_000_000, event, session_id: 's1', cwd: '/work/shop', ...extra };
}

function fold(events: HookEvent[]): Map<string, SessionRecord> {
  const records = new Map<string, SessionRecord>();
  for (const e of events) applyEvent(records, e);
  return records;
}

function appendEvents(events: object[]): void {
  fs.appendFileSync(paths().events, events.map((e) => JSON.stringify(e) + '\n').join(''));
}

// --- Milestone 2: status mapping -------------------------------------------

test('events map to the statuses in the scope', () => {
  const status = (events: HookEvent[]) => fold(events).get('s1')?.base_status;
  assert.equal(status([ev('SessionStart', { source: 'startup' })]), 'idle');
  assert.equal(status([ev('UserPromptSubmit', { prompt: 'Fix the cart' })]), 'working');
  assert.equal(status([ev('UserPromptSubmit'), ev('Notification', { notification_type: 'permission_prompt' })]), 'waiting');
  assert.equal(status([ev('UserPromptSubmit'), ev('PermissionRequest', { tool_name: 'Bash' })]), 'waiting');
  assert.equal(status([ev('UserPromptSubmit'), ev('PreToolUse', { tool_name: 'AskUserQuestion' })]), 'waiting');
  assert.equal(status([ev('UserPromptSubmit'), ev('Stop')]), 'finished');
  assert.equal(status([ev('UserPromptSubmit'), ev('Stop'), ev('Notification', { notification_type: 'idle_prompt' })]), 'finished');
  assert.equal(status([ev('UserPromptSubmit'), ev('Notification', { notification_type: 'auth_success' })]), 'working');
  assert.equal(fold([ev('UserPromptSubmit'), ev('SessionEnd')]).size, 0);
});

test('a permission prompt is one wait, cleared when the tool runs', () => {
  const records = fold([
    ev('UserPromptSubmit', { ts: 1000 }),
    ev('PermissionRequest', { ts: 2000, tool_name: 'Bash' }),
    ev('Notification', { ts: 8000, notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
  ]);
  assert.equal(records.get('s1')!.waiting_since, 2000, 'the follow-up notification is the same wait');

  applyEvent(records, ev('PostToolUse', { ts: 9000, tool_name: 'Read' }));
  assert.equal(records.get('s1')!.base_status, 'waiting', 'a parallel tool finishing does not clear the prompt');

  applyEvent(records, ev('PostToolUse', { ts: 9500, tool_name: 'Bash' }));
  assert.equal(records.get('s1')!.base_status, 'working');
  assert.equal(records.get('s1')!.waiting_since, null);
});

test('idle after 30 quiet minutes, except while waiting on the user', () => {
  const records = fold([ev('UserPromptSubmit', { ts: 0 }), ev('PermissionRequest', { ts: 0, session_id: 's2' })]);
  const at = (id: string, minutes: number) => toView(records.get(id)!, NO_EDITS, DEFAULT_CONFIG, minutes * 60_000).status;
  assert.equal(at('s1', 29), 'working');
  assert.equal(at('s1', 31), 'idle');
  assert.equal(at('s2', 31), 'waiting');
});

test('goal is the first prompt, 120 characters at most', () => {
  const records = fold([ev('UserPromptSubmit', { prompt: 'x'.repeat(300) }), ev('UserPromptSubmit', { prompt: 'second' })]);
  const rec = records.get('s1')!;
  assert.equal(rec.goal_auto!.length, 120);
  assert.equal(rec.last_prompt, 'second');
});

test('ticket keys: branches in any case, prompts only in capitals', () => {
  const opts = { prefixes: [] };
  assert.equal(detectTicket('feature/shop-123-cart-fix', { anyCase: true, ...opts }), 'SHOP-123');
  assert.equal(detectTicket('Pick up BLOG-45 and finish step-2', { anyCase: false, ...opts }), 'BLOG-45');
  assert.equal(detectTicket('Convert the file to UTF-8', { anyCase: false, ...opts }), null);
  assert.equal(detectTicket('fix-12-typo', { anyCase: true, ...opts }), null);
  assert.equal(detectTicket('ABC-1 and SHOP-9', { anyCase: false, prefixes: ['shop'] }), 'SHOP-9');
});

// --- Milestone 1: hook and installer ---------------------------------------

test('hook appends one trimmed line, prints nothing and exits 0', () => {
  const payload = {
    session_id: 'abc',
    hook_event_name: 'PostToolUse',
    cwd: '/work/shop',
    transcript_path: '/t/abc.jsonl',
    tool_name: 'Write',
    tool_input: { content: 'secret file body' },
    tool_response: { big: 'y'.repeat(100_000) },
  };
  const run = spawnSync(process.execPath, [path.join(DIST, 'hook', 'hook.js')], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  const lines = fs.readFileSync(paths().events, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.event, 'PostToolUse');
  assert.equal(line.session_id, 'abc');
  assert.equal(line.tool_name, 'Write');
  assert.ok(lines[0].length < 1000, 'tool input and response are not logged');
  assert.ok(!lines[0].includes('secret'));
});

test('hook survives junk input', () => {
  for (const input of ['', 'not json', '{"no":"session"}']) {
    const run = spawnSync(process.execPath, [path.join(DIST, 'hook', 'hook.js')], { input, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
  assert.equal(fs.existsSync(paths().events), false);
});

test('install keeps other hooks; uninstall restores the file byte for byte', () => {
  const file = process.env.CLAUDE_MONITOR_SETTINGS!;
  const original =
    JSON.stringify(
      {
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
        },
      },
      null,
      4,
    ) + '\n';
  fs.writeFileSync(file, original);

  install();
  install(); // a second install must not double the entries
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(installed.model, 'opus');
  assert.equal(installed.hooks.Stop.length, 2);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'afplay /System/Library/Sounds/Glass.aiff');
  assert.equal(installed.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.equal(status().installed, true);

  // The installed wrapper works end to end.
  execFileSync(paths().hookSh, { input: JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }) });
  assert.equal(fs.readFileSync(paths().events, 'utf8').trim().split('\n').length, 1);

  uninstall();
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(status().installed, false);
});

test('uninstall keeps hooks added after install, and removes a file it created', () => {
  const file = process.env.CLAUDE_MONITOR_SETTINGS!;
  install();
  const withOurs = JSON.parse(fs.readFileSync(file, 'utf8'));
  withOurs.hooks.Stop.push({ hooks: [{ type: 'command', command: 'say done' }] });
  fs.writeFileSync(file, JSON.stringify(withOurs, null, 2));
  uninstall();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });

  fs.rmSync(file);
  install();
  uninstall();
  assert.equal(fs.existsSync(file), false);
});

test('install refuses to touch settings that are not valid JSON', () => {
  const file = process.env.CLAUDE_MONITOR_SETTINGS!;
  fs.writeFileSync(file, '{ "model": ');
  assert.throws(() => install(), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": ');
});

// --- Milestones 2, 3 and 6: engine -----------------------------------------

test('engine folds the log into sessions.json and resumes from its cursor', () => {
  const now = Date.now();
  appendEvents([
    { ts: now, event: 'UserPromptSubmit', session_id: 'a', cwd: '/work/shop', prompt: 'Fix SHOP-12 checkout' },
    { ts: now, event: 'UserPromptSubmit', session_id: 'b', cwd: '/work/blog', prompt: 'Write the post' },
    { ts: now, event: 'Stop', session_id: 'b' },
  ]);
  assert.equal(new Engine().tick(), true);
  const saved = JSON.parse(fs.readFileSync(paths().sessions, 'utf8'));
  assert.deepEqual(saved.sessions.map((s: any) => [s.project_name, s.status, s.ticket]), [
    ['shop', 'working', 'SHOP-12'],
    ['blog', 'finished', null],
  ]);

  appendEvents([{ ts: now, event: 'SessionEnd', session_id: 'b' }]);
  const second = new Engine(); // a restart
  second.tick();
  assert.deepEqual(second.views().map((v) => v.session_id), ['a']);
});

test('goal and ticket edits and project aliases persist across a restart', () => {
  appendEvents([{ ts: Date.now(), event: 'UserPromptSubmit', session_id: 'a', cwd: '/work/shop', prompt: 'do the thing' }]);
  new Engine().tick();
  saveSessionEdit('a', { goal: 'Ship the checkout fix', ticket: 'shop-99' });
  saveAlias('/work/shop', 'Acme Parts');

  const restarted = new Engine();
  restarted.tick();
  const [view] = restarted.views();
  assert.equal(view.goal, 'Ship the checkout fix');
  assert.equal(view.ticket, 'SHOP-99');
  assert.equal(view.project_name, 'Acme Parts');

  saveSessionEdit('a', { goal: '' });
  restarted.tick();
  assert.equal(restarted.views()[0].goal, 'do the thing', 'clearing an edit falls back to the first prompt');
});

test('a killed session goes idle, then is dropped', () => {
  let now = Date.now();
  appendEvents([{ ts: now, event: 'UserPromptSubmit', session_id: 'a', cwd: '/work/shop', prompt: 'go' }]);
  const engine = new Engine({ now: () => now });
  engine.tick();
  assert.equal(engine.views()[0].status, 'working');
  now += 31 * 60_000;
  engine.tick();
  assert.equal(engine.views()[0].status, 'idle');
  now += 13 * 3_600_000;
  engine.tick();
  assert.equal(engine.views().length, 0);
});

test('goal comes from the transcript when the session was already running', () => {
  const transcript = path.join(home, 'session.jsonl');
  fs.writeFileSync(
    transcript,
    [
      'garbage line',
      JSON.stringify({ type: 'summary', summary: 'x' }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Rebuild the   search page' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'later prompt' } }),
    ].join('\n'),
  );
  assert.equal(firstUserPrompt(transcript), 'Rebuild the   search page');

  appendEvents([{ ts: Date.now(), event: 'UserPromptSubmit', session_id: 'a', cwd: '/w', transcript_path: transcript, prompt: 'later prompt' }]);
  const engine = new Engine();
  engine.tick();
  assert.equal(engine.views()[0].goal, 'Rebuild the search page');
});

test('hardening: malformed transcript, missing log and junk lines leave it running', () => {
  const bad = path.join(home, 'bad.jsonl');
  fs.writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x0a, 0x7b, 0x22]));
  assert.equal(firstUserPrompt(bad), null);
  assert.equal(firstUserPrompt(path.join(home, 'missing.jsonl')), null);
  assert.equal(firstUserPrompt('/etc/passwd'), null);

  const engine = new Engine();
  assert.equal(engine.tick(), true, 'no events.jsonl: writes an empty sessions.json');
  assert.deepEqual(engine.views(), []);

  fs.writeFileSync(paths().sessions, '{ broken');
  fs.writeFileSync(paths().overrides, '[1,2');
  fs.writeFileSync(paths().config, 'nope');
  fs.writeFileSync(paths().events, 'junk\n{"ts":"x"}\n\n{"half":');
  appendEvents([]);
  const recovered = new Engine();
  recovered.tick();
  assert.deepEqual(recovered.views(), []);

  fs.appendFileSync(paths().events, `1}\n${JSON.stringify({ ts: Date.now(), event: 'Stop', session_id: 'a', cwd: '/w', transcript_path: bad })}\n`);
  recovered.tick();
  assert.equal(recovered.views()[0].goal, null, 'goal unknown, session still listed');
});

test('hardening: a 50 MB log is folded and rotated', () => {
  const now = Date.now();
  const filler = JSON.stringify({ ts: now, event: 'PostToolUse', session_id: 'bulk', cwd: '/work/bulk', pad: 'p'.repeat(400) }) + '\n';
  const block = filler.repeat(2000);
  const fd = fs.openSync(paths().events, 'a');
  for (let written = 0; written < 50 * 1024 * 1024; written += block.length) fs.writeSync(fd, block);
  fs.closeSync(fd);
  appendEvents([{ ts: now, event: 'Stop', session_id: 'bulk' }]);

  const started = Date.now();
  const engine = new Engine();
  engine.tick();
  assert.equal(engine.views()[0].status, 'finished');
  assert.ok(Date.now() - started < 5000, 'folds 50 MB in a few seconds');
  assert.equal(fs.existsSync(paths().events), false, 'log rotated away');
  assert.ok(fs.statSync(paths().rotated).size > 50 * 1024 * 1024);

  appendEvents([{ ts: now, event: 'UserPromptSubmit', session_id: 'bulk', prompt: 'next' }]);
  engine.tick();
  assert.equal(engine.views()[0].status, 'working', 'keeps reading the fresh log after rotating');
});

// --- Milestone 5: MCP server ------------------------------------------------

test('MCP server lists the same sessions over stdio', () => {
  const now = Date.now();
  appendEvents([
    { ts: now, event: 'UserPromptSubmit', session_id: 'aaa-111', cwd: '/work/shop', prompt: 'Fix SHOP-12 checkout' },
    { ts: now, event: 'UserPromptSubmit', session_id: 'bbb-222', cwd: '/work/blog', prompt: 'Write the post' },
  ]);
  new Engine().tick();
  // Arrives after the app last folded: the server must still see it.
  appendEvents([{ ts: now, event: 'PermissionRequest', session_id: 'bbb-222', tool_name: 'Bash' }]);

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_sessions', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_session', arguments: { session_id: 'aaa' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_session', arguments: { session_id: 'zzz' } } },
  ];
  const run = spawnSync(process.execPath, [path.join(DIST, 'mcp', 'server.js')], {
    input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf8',
  });
  const replies = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 5, 'one reply per request, none for the notification');
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(replies[1].result.tools.map((t: any) => t.name), ['list_tasks', 'list_sessions', 'get_session']);

  const list = JSON.parse(replies[2].result.content[0].text);
  assert.equal(list.waiting_for_input, 1);
  assert.deepEqual(list.sessions.map((s: any) => [s.project, s.status, s.ticket]), [
    ['blog', 'waiting for input', null],
    ['shop', 'working', 'SHOP-12'],
  ]);
  assert.equal(JSON.parse(replies[3].result.content[0].text).session_id, 'aaa-111');
  assert.equal(replies[4].result.isError, true);
});

// --- Today's tasks -----------------------------------------------------------

test('tasks link to sessions by ticket or by hand, and take the most urgent status', () => {
  const now = Date.now();
  appendEvents([
    { ts: now, event: 'UserPromptSubmit', session_id: 'a', cwd: '/work/shop', prompt: 'Start on SHOP-12' },
    { ts: now, event: 'UserPromptSubmit', session_id: 'b', cwd: '/work/shop', prompt: 'Also SHOP-12, the tests' },
    { ts: now, event: 'PermissionRequest', session_id: 'b', tool_name: 'Bash' },
    { ts: now, event: 'UserPromptSubmit', session_id: 'c', cwd: '/work/blog', prompt: 'Write the post' },
    { ts: now, event: 'Stop', session_id: 'c' },
  ]);
  const byTicket = addTask('SHOP-12 checkout fix', 'Acme Parts', now)!;
  const byHand = addTask('Publish the hooks post', '', now + 1)!;
  const untouched = addTask('Invoice run', 'Acme Parts', now + 2)!;
  assert.equal(addTask('   ', 'x'), null);
  saveSessionEdit('c', { task_id: byHand.id });
  saveClient('/work/shop', 'Acme Parts');

  const engine = new Engine();
  engine.tick();
  assert.equal(engine.views().find((v) => v.session_id === 'a')!.client, 'Acme Parts');

  const tasks = todaysTasks(readTasks(), engine.views(), now);
  assert.deepEqual(tasks.map((t) => [t.client, t.title, t.status, t.sessions.length]), [
    ['Acme Parts', 'SHOP-12 checkout fix', 'waiting', 2],
    ['Acme Parts', 'Invoice run', 'not started', 0],
    [null, 'Publish the hooks post', 'finished', 1],
  ]);

  setTaskDone(byTicket.id, true, now);
  const tomorrow = now + 24 * 3_600_000;
  const next = todaysTasks(readTasks(), engine.views(), tomorrow);
  assert.deepEqual(next.map((t) => [t.title, t.carried_over]), [
    ['Invoice run', true],
    ['Publish the hooks post', true],
  ], 'open tasks carry over; yesterday\'s done task drops off');
  assert.ok(untouched.id);
});
