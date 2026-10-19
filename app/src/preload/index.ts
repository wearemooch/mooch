import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { FreeCodeApi } from '../shared/ipc';

// Callbacks get only the payload, never the IPC event (which would expose ipcRenderer).
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: FreeCodeApi = {
  workspace: {
    open: () => ipcRenderer.invoke('workspace:open'),
    current: () => ipcRenderer.invoke('workspace:current'),
    list: (dir) => ipcRenderer.invoke('workspace:list', dir),
    read: (file) => ipcRenderer.invoke('workspace:read', file),
    write: (file, content) => ipcRenderer.invoke('workspace:write', file, content),
    onChanged: (cb) => subscribe('workspace:changed', cb),
  },
  fcc: {
    status: () => ipcRenderer.invoke('fcc:status'),
    restart: () => ipcRenderer.invoke('fcc:restart'),
    models: () => ipcRenderer.invoke('fcc:models'),
    openAdmin: () => ipcRenderer.invoke('fcc:openAdmin'),
    providers: () => ipcRenderer.invoke('fcc:providers'),
    saveKey: (providerId, apiKey) => ipcRenderer.invoke('fcc:saveKey', providerId, apiKey),
    onStatus: (cb) => subscribe('fcc:status', cb),
  },
  app: {
    about: () => ipcRenderer.invoke('app:about'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
    removeRuntime: () => ipcRenderer.invoke('app:removeRuntime'),
  },
  agent: {
    newThread: (options) => ipcRenderer.invoke('agent:newThread', options),
    send: (text, options) => ipcRenderer.invoke('agent:send', text, options),
    interrupt: () => ipcRenderer.invoke('agent:interrupt'),
    respond: (requestId, decision, content) => ipcRenderer.invoke('agent:respond', requestId, decision, content),
    racePlan: () => ipcRenderer.invoke('agent:racePlan'),
    applyRace: (raceId, contestantId) => ipcRenderer.invoke('agent:applyRace', raceId, contestantId),
    discardRace: (raceId) => ipcRenderer.invoke('agent:discardRace', raceId),
    previewRestore: (pointId) => ipcRenderer.invoke('agent:previewRestore', pointId),
    restore: (pointId, rewind) => ipcRenderer.invoke('agent:restore', pointId, rewind),
    history: () => ipcRenderer.invoke('agent:history'),
    update: (update) => ipcRenderer.invoke('agent:update', update),
    compact: () => ipcRenderer.invoke('agent:compact'),
    review: () => ipcRenderer.invoke('agent:review'),
    onEvent: (cb) => subscribe('agent:event', cb),
  },
  commands: {
    list: () => ipcRenderer.invoke('commands:list'),
    openFolder: () => ipcRenderer.invoke('commands:openFolder'),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    save: (servers) => ipcRenderer.invoke('mcp:save', servers),
    parse: (text) => ipcRenderer.invoke('mcp:parse', text),
    importable: () => ipcRenderer.invoke('mcp:importable'),
    login: (name) => ipcRenderer.invoke('mcp:login', name),
    openFile: () => ipcRenderer.invoke('mcp:openFile'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    prepare: (source) => ipcRenderer.invoke('skills:prepare', source),
    install: (token, names, replace) => ipcRenderer.invoke('skills:install', token, names, replace),
    discard: (token) => ipcRenderer.invoke('skills:discard', token),
    remove: (name) => ipcRenderer.invoke('skills:remove', name),
    openFolder: () => ipcRenderer.invoke('skills:openFolder'),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    search: (query) => ipcRenderer.invoke('sessions:search', query),
    read: (id) => ipcRenderer.invoke('sessions:read', id),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    resume: (id, model) => ipcRenderer.invoke('sessions:resume', id, model),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    team: (executor) => ipcRenderer.invoke('settings:team', executor),
  },
};

contextBridge.exposeInMainWorld('freeCode', api);
