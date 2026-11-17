/**
 * Menu bar app: owns the fold loop, the tray icon, the popover window and
 * notifications. Read-only towards Claude Code; it makes no network calls.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, Tray } from 'electron';
import { DESKTOP_BUNDLE_ID, desktopSessionUrl } from './desktop';
import { install, status as hookStatus } from '../cli/install';
import { surfaceName } from '../mcp/server';
import { SessionView } from '../shared/fold';
import { Engine, readOverrides, saveAlias, saveClient, saveSessionEdit } from '../shared/store';
import { addTask, readTasks, removeTask, setTaskDone, taskForSession, todaysTasks } from '../shared/tasks';

const WIDTH = 400;
const MAX_HEIGHT = 680;
/** Dev aid: write a PNG of the popover to this path, then quit. */
const SCREENSHOT = process.env.CLAUDE_MONITOR_SCREENSHOT;

let engine: Engine;
let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
/** waiting_since of the wait already announced, per session. */
const announced = new Map<string, number>();
const liveNotifications = new Set<Notification>();

function trayIcon(): Electron.NativeImage {
  // A ring with a dot, drawn here so the project ships no binary assets.
  const size = 36;
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const coverage = (edge: number) => Math.max(0, Math.min(1, edge + 0.5));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - centre, y - centre);
      const ring = Math.min(coverage(14.5 - d), coverage(d - 11));
      const dot = coverage(5.5 - d);
      pixels[(y * size + x) * 4 + 3] = Math.round(255 * Math.max(ring, dot));
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

function model() {
  const views = engine.views();
  const tasks = todaysTasks(readTasks(), views, Date.now());
  const open = tasks.filter((t) => !t.done_at);
  const sessions = views.map((v: SessionView) => ({
    id: v.session_id,
    project: v.project_name,
    path: v.project_path,
    goal: v.goal,
    goalEdited: v.goal_edited,
    prompted: v.last_prompt !== null || v.goal_source !== null,
    ticket: v.ticket,
    client: v.client,
    taskId: taskForSession(v, open)?.id ?? null,
    status: v.status,
    lastEventAt: v.last_event_at,
    waitingReason: v.waiting_reason,
    error: v.error,
    surface: surfaceName(v),
    branch: v.branch,
    canFocus: Boolean(v.bundle_id),
    opensChat: v.bundle_id === DESKTOP_BUNDLE_ID,
  }));
  let hooksInstalled = false;
  try {
    hooksInstalled = hookStatus().installed;
  } catch {
    // treat as not installed
  }
  // Every client name in use, for the pickers.
  const clients = [...new Set([...tasks.map((t) => t.client), ...Object.values(readOverrides().clients)])]
    .filter((c): c is string => Boolean(c))
    .sort((a, b) => a.localeCompare(b));
  return { sessions, tasks, clients, hooksInstalled, idleMinutes: engine.idleMinutes() };
}

function refresh(): void {
  const views = engine.views();
  const waiting = views.filter((v) => v.status === 'waiting').length;
  tray?.setTitle(waiting ? ` ${waiting}` : '');
  tray?.setToolTip(
    views.length
      ? `${views.length} Claude Code session${views.length === 1 ? '' : 's'}${waiting ? `, ${waiting} waiting for input` : ''}`
      : 'No Claude Code sessions running',
  );
  if (popover && !popover.isDestroyed()) popover.webContents.send('model', model());
  void notifyWaiting(views);
}

function frontmostBundleId(): Promise<string | null> {
  // lsappinfo needs no Accessibility or Automation permission.
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', ['front'], { timeout: 1000 }, (frontError, asn) => {
      if (frontError || !asn.trim()) return resolve(null);
      execFile('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', asn.trim()], { timeout: 1000 }, (infoError, out) => {
        resolve(infoError ? null : (out.match(/="([^"]+)"/)?.[1] ?? null));
      });
    });
  });
}

function focusSession(view: SessionView | undefined): void {
  if (!view?.bundle_id || !/^[A-Za-z0-9.-]+$/.test(view.bundle_id)) return;
  // A desktop app session opens its own chat. Everything else brings the
  // owning app forward; picking the exact window or tab differs per terminal.
  const url = view.bundle_id === DESKTOP_BUNDLE_ID ? desktopSessionUrl(view.session_id) : null;
  execFile('/usr/bin/open', url ? [url] : ['-b', view.bundle_id], () => undefined);
}

async function notifyWaiting(views: SessionView[]): Promise<void> {
  const fresh = views.filter((v) => v.status === 'waiting' && v.waiting_since !== null && announced.get(v.session_id) !== v.waiting_since);
  for (const id of [...announced.keys()]) {
    if (!views.some((v) => v.session_id === id && v.status === 'waiting')) announced.delete(id);
  }
  if (!fresh.length) return;
  // Mark first so a second refresh during the focus check cannot repeat the notification.
  for (const v of fresh) announced.set(v.session_id, v.waiting_since!);
  if (!Notification.isSupported()) return;

  const front = await frontmostBundleId();
  for (const v of fresh) {
    if (front && v.bundle_id === front) continue; // already looking at it
    const notification = new Notification({
      title: `${v.project_name} needs input`,
      subtitle: v.ticket ?? undefined,
      body: [v.goal ?? 'Goal unknown', v.waiting_reason].filter(Boolean).join('\n'),
    });
    liveNotifications.add(notification); // keep a reference or the click handler is collected
    notification.on('click', () => focusSession(engine.views().find((s) => s.session_id === v.session_id) ?? v));
    notification.on('close', () => liveNotifications.delete(notification));
    notification.show();
  }
}

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // The screenshot needs a solid background; the real popover uses menu vibrancy.
    ...(SCREENSHOT
      ? { backgroundColor: nativeTheme.shouldUseDarkColors ? '#262626' : '#f4f4f4' }
      : { vibrancy: 'menu' as const, visualEffectState: 'active' as const, transparent: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
  win.on('blur', () => {
    if (!SCREENSHOT && !win.webContents.isDevToolsOpened()) win.hide();
  });
  // Nothing in the UI links anywhere; refuse any navigation or new window.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function placePopover(): void {
  if (!popover || !tray) return;
  const icon = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea;
  const [width] = popover.getSize();
  const x = Math.round(Math.min(Math.max(icon.x + icon.width / 2 - width / 2, area.x + 8), area.x + area.width - width - 8));
  popover.setPosition(x, Math.round(icon.y + icon.height + 4), false);
}

function togglePopover(): void {
  if (!popover) return;
  if (popover.isVisible()) return popover.hide();
  engine.tick();
  refresh();
  placePopover();
  popover.show();
  popover.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (popover && !popover.isVisible()) togglePopover();
  });
  app.on('window-all-closed', () => undefined); // a menu bar app outlives its window

  app.whenReady().then(() => {
    app.dock?.hide();
    engine = new Engine();
    engine.tick();
    // Sessions already waiting when the app starts are shown, not announced.
    for (const v of engine.views()) {
      if (v.status === 'waiting' && v.waiting_since !== null) announced.set(v.session_id, v.waiting_since);
    }

    tray = new Tray(trayIcon());
    tray.on('click', togglePopover);
    tray.on('right-click', () => {
      tray?.popUpContextMenu(Menu.buildFromTemplate([{ label: 'Quit Rollcall', click: () => app.quit() }]));
    });
    popover = createPopover();

    ipcMain.handle('model', () => model());
    ipcMain.handle('edit', (_event, edit: { id: string; path: string; goal: string; ticket: string; alias: string; client: string; taskId: string }) => {
      if (!edit || typeof edit.id !== 'string') return model();
      saveSessionEdit(edit.id, { goal: String(edit.goal ?? ''), ticket: String(edit.ticket ?? ''), task_id: String(edit.taskId ?? '') });
      if (typeof edit.path === 'string' && typeof edit.client === 'string') saveClient(edit.path, edit.client);
      if (typeof edit.path === 'string' && typeof edit.alias === 'string') {
        // An alias equal to the folder name is no alias.
        saveAlias(edit.path, edit.alias.trim() === path.basename(edit.path) ? '' : edit.alias);
      }
      engine.tick();
      refresh();
      return model();
    });
    ipcMain.handle('task-add', (_event, task: { title: string; client: string }) => {
      addTask(String(task?.title ?? ''), String(task?.client ?? ''));
      return model();
    });
    ipcMain.handle('task-done', (_event, change: { id: string; done: boolean }) => {
      if (typeof change?.id === 'string') setTaskDone(change.id, Boolean(change.done));
      return model();
    });
    ipcMain.handle('task-remove', (_event, id: string) => {
      if (typeof id === 'string') removeTask(id);
      return model();
    });
    ipcMain.handle('focus', (_event, id: string) => {
      focusSession(engine.views().find((v) => v.session_id === id));
      popover?.hide();
    });
    ipcMain.handle('install-hooks', () => {
      try {
        return { ok: true, message: install(), model: model() };
      } catch (error: any) {
        return { ok: false, message: String(error?.message ?? error), model: model() };
      }
    });
    ipcMain.on('height', (_event, height: number) => {
      if (!popover || typeof height !== 'number') return;
      popover.setSize(WIDTH, Math.round(Math.min(Math.max(height, 120), MAX_HEIGHT)), false);
      placePopover();
    });
    ipcMain.on('quit', () => app.quit());

    refresh();
    let ticks = 0;
    setInterval(() => {
      ticks += 1;
      // Fold as soon as the hook writes; every 15 seconds anyway for the idle rule.
      if (engine.hasNewEvents() || ticks % 30 === 0) {
        engine.tick();
        refresh();
      }
    }, 500);

    if (SCREENSHOT) {
      popover.webContents.once('did-finish-load', () => {
        popover!.showInactive();
        setTimeout(async () => {
          const image = await popover!.webContents.capturePage();
          fs.writeFileSync(SCREENSHOT, image.toPNG());
          app.quit();
        }, 1200);
      });
    }
  });
}
