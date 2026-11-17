/**
 * Popover UI. Runs sandboxed with no Node access; everything goes through the
 * `monitor` bridge from preload. Prompts and task titles are untrusted text,
 * so every string is set with textContent, never innerHTML.
 */
(() => {
  type Status = 'working' | 'waiting' | 'finished' | 'idle';
  interface Row {
    id: string;
    project: string;
    path: string;
    goal: string | null;
    goalEdited: boolean;
    prompted: boolean;
    ticket: string | null;
    client: string | null;
    taskId: string | null;
    status: Status;
    lastEventAt: number;
    waitingReason: string | null;
    error: string | null;
    surface: string | null;
    branch: string | null;
    canFocus: boolean;
    opensChat: boolean;
  }
  interface TaskRow {
    id: string;
    title: string;
    client: string | null;
    day: string;
    done_at: number | null;
    carried_over: boolean;
    status: Status | 'not started' | 'done';
    sessions: { session_id: string; project_name: string; status: Status }[];
  }
  interface Model {
    sessions: Row[];
    tasks: TaskRow[];
    clients: string[];
    hooksInstalled: boolean;
    idleMinutes: number;
  }

  const api = (window as any).monitor;
  const STATUS_LABEL = {
    waiting: 'Waiting for input',
    working: 'Working',
    finished: 'Finished',
    idle: 'Idle',
    'not started': 'Not started',
    done: 'Done',
  };

  const list = document.getElementById('list')!;
  const taskList = document.getElementById('tasks')!;
  const taskSummary = document.getElementById('task-summary')!;
  const taskForm = document.getElementById('task-form') as HTMLFormElement;
  const taskTitle = document.getElementById('task-title') as HTMLInputElement;
  const taskClient = document.getElementById('task-client') as HTMLInputElement;
  const clientOptions = document.getElementById('client-options')!;
  const summary = document.getElementById('summary')!;
  const setup = document.getElementById('setup')!;
  const setupMessage = document.getElementById('setup-message')!;
  const installButton = document.getElementById('install') as HTMLButtonElement;

  let current: Model = { sessions: [], tasks: [], clients: [], hooksInstalled: true, idleMinutes: 30 };
  let editing: string | null = null;
  /** Tasks shown per client before "Show more" is pressed. */
  const TASKS_SHOWN = 3;
  /** Clients showing their whole list. */
  const expanded = new Set<string>();
  /** Clients folded down to their heading. Remembered between launches. */
  const minimised = new Set<string>();
  try {
    for (const key of JSON.parse(localStorage.getItem('minimised-clients') ?? '[]')) minimised.add(String(key));
  } catch {
    // start with every group open
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function age(timestamp: number): string {
    const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  }

  function field(label: string, control: HTMLInputElement | HTMLSelectElement): HTMLLabelElement {
    const wrap = el('label', 'field');
    wrap.append(el('span', 'field-label', label), control);
    return wrap;
  }

  function textInput(value: string, maxLength: number, placeholder: string): HTMLInputElement {
    const input = el('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  }

  // --- Today's tasks ---------------------------------------------------------

  function taskRow(task: TaskRow): HTMLElement {
    const done = task.status === 'done';
    const item = el('li', `task ${task.status.replace(' ', '-')}`);

    const check = el('input');
    check.type = 'checkbox';
    check.checked = done;
    check.setAttribute('aria-label', `${done ? 'Reopen' : 'Complete'}: ${task.title}`);
    check.addEventListener('change', async () => update(await api.setTaskDone(task.id, check.checked), true));

    const body = el('div', 'task-body');
    body.append(el('div', 'task-title', task.title));

    if (!done) {
      const line = el('div', 'task-meta');
      line.append(el('span', 'dot'), el('span', 'task-status', STATUS_LABEL[task.status]));
      for (const session of task.sessions) {
        // Each session working on the task is a shortcut to it.
        const link = el('button', `session-link ${session.status}`, session.project_name);
        link.type = 'button';
        link.title = `${STATUS_LABEL[session.status]} · open this session`;
        link.addEventListener('click', () => api.focus(session.session_id));
        line.append(link);
      }
      if (task.carried_over) line.append(el('span', 'carried', 'carried over'));
      body.append(line);
    }

    const remove = el('button', 'icon-button task-remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove task: ${task.title}`);
    remove.addEventListener('click', async () => update(await api.removeTask(task.id), true));

    item.append(check, body, remove);
    return item;
  }

  function saveTaskLayout(): void {
    try {
      localStorage.setItem('minimised-clients', JSON.stringify([...minimised]));
    } catch {
      // the layout is a convenience; losing it only reopens the groups
    }
  }

  /** One client's tasks: a heading that minimises the group, the next few tasks, and a "show more". */
  function clientGroup(client: string | null, tasks: TaskRow[]): HTMLElement[] {
    const key = client ?? '';
    const open = tasks.filter((t) => t.status !== 'done');
    const isMinimised = minimised.has(key);

    const heading = el('li', 'client-heading');
    const toggle = el('button', 'client-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!isMinimised));
    toggle.append(
      el('span', 'chevron', isMinimised ? '▸' : '▾'),
      el('span', 'client-name', client ?? 'No client'),
      el('span', 'client-count', open.length ? `${open.length} open` : 'all done'),
    );
    toggle.addEventListener('click', () => {
      if (isMinimised) minimised.delete(key);
      else minimised.add(key);
      saveTaskLayout();
      render();
    });
    heading.append(toggle);
    if (isMinimised) return [heading];

    // The next few open tasks; done ones only fill a gap.
    const keep = new Set([...open, ...tasks.filter((t) => t.status === 'done')].slice(0, TASKS_SHOWN).map((t) => t.id));
    const showAll = expanded.has(key);
    const visible = showAll ? tasks : tasks.filter((t) => keep.has(t.id));
    const nodes: HTMLElement[] = [heading, ...visible.map(taskRow)];

    if (tasks.length > TASKS_SHOWN) {
      const item = el('li', 'more');
      const more = el('button', 'button quiet', showAll ? 'Show fewer' : `Show ${tasks.length - visible.length} more`);
      more.type = 'button';
      more.setAttribute('aria-expanded', String(showAll));
      more.addEventListener('click', () => {
        if (showAll) expanded.delete(key);
        else expanded.add(key);
        render();
      });
      item.append(more);
      nodes.push(item);
    }
    return nodes;
  }

  function renderTasks(): void {
    const { tasks, clients } = current;
    const open = tasks.filter((t) => t.status !== 'done').length;
    taskSummary.textContent = tasks.length ? `${tasks.length - open} of ${tasks.length} done` : '';

    // Tasks arrive sorted by client, so each run of one client is a group.
    const groups: { client: string | null; tasks: TaskRow[] }[] = [];
    for (const task of tasks) {
      const last = groups[groups.length - 1];
      if (last && last.client === task.client) last.tasks.push(task);
      else groups.push({ client: task.client, tasks: [task] });
    }
    taskList.replaceChildren(...groups.flatMap((group) => clientGroup(group.client, group.tasks)));

    clientOptions.replaceChildren(
      ...clients.map((name) => {
        const option = el('option');
        option.value = name;
        return option;
      }),
    );
  }

  taskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!taskTitle.value.trim()) return;
    const model = await api.addTask({ title: taskTitle.value, client: taskClient.value });
    taskTitle.value = '';
    // The client stays filled in: tasks for one client tend to be added together.
    update(model, true);
    taskTitle.focus();
  });

  // --- Sessions --------------------------------------------------------------

  function editForm(row: Row): HTMLFormElement {
    const form = el('form', 'edit');
    const goal = textInput(row.goal ?? '', 120, 'What this session is for');
    const ticket = textInput(row.ticket ?? '', 40, 'SHOP-123');
    const alias = textInput(row.project, 60, 'Shown instead of the folder name');
    const client = textInput(row.client ?? '', 60, 'Client for this project');
    client.setAttribute('list', 'client-options');

    const task = el('select');
    const none = el('option', undefined, 'None');
    none.value = '';
    task.append(none);
    for (const candidate of current.tasks.filter((t) => t.status !== 'done')) {
      const option = el('option', undefined, candidate.client ? `${candidate.client}: ${candidate.title}` : candidate.title);
      option.value = candidate.id;
      task.append(option);
    }
    task.value = row.taskId ?? '';

    const first = el('div', 'field-pair');
    first.append(field('Ticket', ticket), field('Project name', alias));
    const second = el('div', 'field-pair');
    second.append(field('Client', client), field('Task', task));

    const actions = el('div', 'edit-actions');
    actions.append(el('span', 'hint', 'Clear a field to go back to the detected value.'));
    const cancel = el('button', 'button', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'button primary', 'Save');
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(field('Goal', goal), first, second, actions);

    const close = () => {
      editing = null;
      render();
    };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      save.disabled = true;
      current = await api.edit({
        id: row.id,
        path: row.path,
        goal: goal.value,
        ticket: ticket.value,
        alias: alias.value,
        client: client.value,
        taskId: task.value,
      });
      close();
    });
    setTimeout(() => goal.focus(), 0);
    return form;
  }

  function sessionRow(row: Row): HTMLElement {
    const item = el('li', `row ${row.status}`);

    const main = el('button', 'row-main');
    main.type = 'button';
    main.title = row.canFocus
      ? `${row.opensChat ? 'Open this chat in the Claude desktop app' : `Bring ${row.surface ?? 'the app'} to the front`}\n${row.path}`
      : row.path;
    main.disabled = !row.canFocus;
    main.addEventListener('click', () => api.focus(row.id));

    const top = el('div', 'row-top');
    top.append(el('span', 'dot'), el('span', 'project', row.project));
    if (row.ticket) top.append(el('span', 'ticket', row.ticket));
    top.append(el('span', 'age', age(row.lastEventAt)));

    const goal = el('div', row.goal ? 'goal' : 'goal unknown', row.goal ?? (row.prompted ? 'Goal unknown' : 'No prompt yet'));

    const detail = [row.status === 'waiting' && row.waitingReason ? row.waitingReason : STATUS_LABEL[row.status]];
    if (row.error) detail.push(`stopped on an error (${row.error.replace(/_/g, ' ')})`);
    if (row.client) detail.push(row.client);
    if (row.surface) detail.push(row.surface);
    if (row.branch) detail.push(row.branch);
    const meta = el('div', 'meta', detail.join(' · '));

    main.append(top, goal, meta);

    const edit = el('button', 'icon-button', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', `Edit goal, ticket, client and task for ${row.project}`);
    edit.addEventListener('click', () => {
      editing = editing === row.id ? null : row.id;
      render();
    });

    item.append(main, edit);
    if (editing === row.id) item.append(editForm(row));
    return item;
  }

  function render(): void {
    const { sessions, hooksInstalled } = current;
    const waiting = sessions.filter((s) => s.status === 'waiting').length;
    summary.textContent = sessions.length ? `${sessions.length} open${waiting ? ` · ${waiting} waiting` : ''}` : '';

    setup.hidden = hooksInstalled;
    if (editing && !sessions.some((s) => s.id === editing)) editing = null;

    renderTasks();
    list.replaceChildren(...sessions.map(sessionRow));
    if (!sessions.length) {
      const empty = el('li', 'empty');
      empty.append(
        el('strong', undefined, 'No sessions running'),
        el(
          'span',
          undefined,
          hooksInstalled
            ? 'Sessions appear here when they start or get their next prompt.'
            : 'Install the hooks so sessions can report in.',
        ),
      );
      list.append(empty);
    }
    requestAnimationFrame(() => api.setHeight(document.body.scrollHeight));
  }

  function update(model: Model, force = false): void {
    current = model;
    // Rebuilding the list would wipe a half-typed edit; it catches up on save or cancel.
    if (!force && editing && model.sessions.some((s) => s.id === editing)) {
      renderTasks();
      return;
    }
    render();
  }

  installButton.addEventListener('click', async () => {
    installButton.disabled = true;
    const result = await api.installHooks();
    installButton.disabled = false;
    if (!result.ok) setupMessage.textContent = result.message;
    update(result.model);
  });
  document.getElementById('quit')!.addEventListener('click', () => api.quit());

  api.onModel((model: Model) => update(model));
  api.model().then((model: Model) => update(model));
  // Ages tick over even when no event arrives.
  setInterval(() => {
    if (!editing) render();
  }, 20_000);
})();
