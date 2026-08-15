const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorAPI', {
  getSnapshot: () => ipcRenderer.invoke('monitor:get-snapshot'),
  refresh: () => ipcRenderer.invoke('monitor:refresh'),
  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreference: (key, value) => ipcRenderer.invoke('preferences:set', key, value),
  toggleCompact: () => ipcRenderer.invoke('window:toggle-compact'),
  setCompact: (compact) => ipcRenderer.invoke('window:set-compact', compact),
  resizeView: (view, runningSessions, contentHeight, visibleHeight) => ipcRenderer.invoke('window:resize-view', view, runningSessions, contentHeight, visibleHeight),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  openCCSwitchProvider: (provider) => ipcRenderer.invoke('ccswitch:open-provider', provider),
  onCompactChanged: (callback) => ipcRenderer.on('window:compact-changed', (_, value) => callback(value))
});
