const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saves', {
  state: () => ipcRenderer.invoke('state'),
  chooseFolder: kind => ipcRenderer.invoke('choose-folder', kind),
  backup: note => ipcRenderer.invoke('backup', note),
  restore: name => ipcRenderer.invoke('restore', name),
  findSaves: () => ipcRenderer.invoke('find-saves'),
  useCandidate: index => ipcRenderer.invoke('use-candidate', index),
  useLocalBackups: () => ipcRenderer.invoke('use-local-backups'),
  scanArchive: () => ipcRenderer.invoke('scan-archive'),
  annotateSave: (id, annotation) => ipcRenderer.invoke('annotate-save', id, annotation),
  refreshSaveDetails: id => ipcRenderer.invoke('refresh-save-details', id),
  lotPreview: (id, lotId) => ipcRenderer.invoke('lot-preview', id, lotId),
  importSaves: ids => ipcRenderer.invoke('import-saves', ids),
  keepTrial: () => ipcRenderer.invoke('keep-trial'),
  trySave: id => ipcRenderer.invoke('try-save', id),
  returnSaves: () => ipcRenderer.invoke('return-saves'),
  protectionSettings: settings => ipcRenderer.invoke('protection-settings', settings),
  onProtection: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('protection-state', listener);
    return () => ipcRenderer.removeListener('protection-state', listener);
  },
  updateAction: action => ipcRenderer.invoke('update-action', action),
  onUpdate: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('update-state', listener);
    return () => ipcRenderer.removeListener('update-state', listener);
  }
});
