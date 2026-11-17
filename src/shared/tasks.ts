/**
 * Today's to-do list: tasks with an optional client, stored in tasks.json,
 * and the rule that links running sessions to them.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { SessionView, Status } from './fold';
import { paths } from './paths';
import { writeJsonAtomic } from './store';

export interface Task {
  id: string;
  title: string;
  client: string | null;
  /** Local date the task was added, YYYY-MM-DD. */
  day: string;
  created_at: number;
  done_at: number | null;
}

export type TaskStatus = Status | 'not started' | 'done';

export interface TaskView extends Task {
  /** Added on an earlier day and still open. */
  carried_over: boolean;
  /** Done, or the most urgent status among its sessions. */
  status: TaskStatus;
  sessions: { session_id: string; project_name: string; status: Status }[];
}

const TITLE_MAX = 160;
const CLIENT_MAX = 60;
const KEEP_DONE_MS = 30 * 24 * 3_600_000;
const URGENCY: Status[] = ['waiting', 'working', 'finished', 'idle'];

export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function readTasks(): Task[] {
  try {
    const raw = JSON.parse(fs.readFileSync(paths().tasks, 'utf8'));
    if (!Array.isArray(raw?.tasks)) return [];
    return raw.tasks.filter(
      (t: any) => t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.created_at === 'number',
    );
  } catch {
    return [];
  }
}

function writeTasks(tasks: Task[], now: number): void {
  const kept = tasks.filter((t) => !t.done_at || now - t.done_at < KEEP_DONE_MS);
  fs.mkdirSync(paths().dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(paths().tasks, { tasks: kept });
}

export function addTask(title: string, client: string, now = Date.now()): Task | null {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  if (!clean) return null;
  const task: Task = {
    id: randomUUID(),
    title: clean,
    client: client.replace(/\s+/g, ' ').trim().slice(0, CLIENT_MAX) || null,
    day: dayKey(now),
    created_at: now,
    done_at: null,
  };
  writeTasks([...readTasks(), task], now);
  return task;
}

export function setTaskDone(id: string, done: boolean, now = Date.now()): void {
  const tasks = readTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.done_at = done ? now : null;
  writeTasks(tasks, now);
}

export function removeTask(id: string, now = Date.now()): void {
  writeTasks(readTasks().filter((t) => t.id !== id), now);
}

/** The task a session is working on: the one picked by hand, else one whose title names the session's ticket. */
export function taskForSession(view: SessionView, open: Task[]): Task | null {
  if (view.task_id) {
    const picked = open.find((t) => t.id === view.task_id);
    if (picked) return picked;
  }
  if (!view.ticket) return null;
  const key = new RegExp(`(?<![A-Za-z0-9])${view.ticket.replace(/[^A-Za-z0-9-]/g, '')}(?![A-Za-z0-9])`, 'i');
  return open.find((t) => key.test(t.title)) ?? null;
}

/**
 * Today's list: every open task (older ones carry over) plus the ones ticked
 * off today, grouped by client, each with the sessions working on it.
 */
export function todaysTasks(tasks: Task[], views: SessionView[], now: number): TaskView[] {
  const today = dayKey(now);
  const shown = tasks.filter((t) => !t.done_at || dayKey(t.done_at) === today);
  const open = shown.filter((t) => !t.done_at);

  const linked = new Map<string, TaskView['sessions']>();
  for (const view of views) {
    const task = taskForSession(view, open);
    if (!task) continue;
    const list = linked.get(task.id) ?? [];
    list.push({ session_id: view.session_id, project_name: view.project_name, status: view.status });
    linked.set(task.id, list);
  }

  const result = shown.map((task): TaskView => {
    const sessions = linked.get(task.id) ?? [];
    const status: TaskStatus = task.done_at
      ? 'done'
      : (URGENCY.find((s) => sessions.some((session) => session.status === s)) ?? 'not started');
    return { ...task, carried_over: !task.done_at && task.day !== today, status, sessions };
  });

  return result.sort(
    (a, b) =>
      Number(!a.client) - Number(!b.client) ||
      (a.client ?? '').localeCompare(b.client ?? '') ||
      Number(Boolean(a.done_at)) - Number(Boolean(b.done_at)) ||
      a.created_at - b.created_at,
  );
}
