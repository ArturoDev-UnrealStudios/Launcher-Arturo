import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EventChannels, InvokeChannels, type LauncherApi } from '../shared/api';

/**
 * Puente mínimo y explícito: solo se exponen los canales listados en InvokeChannels.
 * La interfaz no tiene acceso a Node, al sistema de archivos ni a ipcRenderer.
 */
const api: Record<string, unknown> = {};
for (const [ns, methods] of Object.entries(InvokeChannels)) {
  const obj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of methods as readonly string[]) {
    obj[m] = (...args: unknown[]) => ipcRenderer.invoke(`${ns}:${m}`, ...args);
  }
  api[ns] = Object.freeze(obj);
}

const subscribe = (channel: string) => (cb: (...args: unknown[]) => void) => {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

api.on = Object.freeze({
  progress: subscribe(EventChannels.progress),
  instances: subscribe(EventChannels.instances),
  accounts: subscribe(EventChannels.accounts),
  social: subscribe(EventChannels.social),
  update: subscribe(EventChannels.update),
  notification: subscribe(EventChannels.notification),
  gameLog: subscribe(EventChannels.gameLog),
});

contextBridge.exposeInMainWorld('launcher', Object.freeze(api) as unknown as LauncherApi);
contextBridge.exposeInMainWorld('platform', Object.freeze({ os: process.platform }));
