import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('monitor', {
  model: () => ipcRenderer.invoke('model'),
  edit: (edit: unknown) => ipcRenderer.invoke('edit', edit),
  addTask: (task: unknown) => ipcRenderer.invoke('task-add', task),
  setTaskDone: (id: string, done: boolean) => ipcRenderer.invoke('task-done', { id, done }),
  removeTask: (id: string) => ipcRenderer.invoke('task-remove', id),
  focus: (id: string) => ipcRenderer.invoke('focus', id),
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  setHeight: (height: number) => ipcRenderer.send('height', height),
  quit: () => ipcRenderer.send('quit'),
  onModel: (listener: (model: unknown) => void) => {
    ipcRenderer.on('model', (_event, model) => listener(model));
  },
});
