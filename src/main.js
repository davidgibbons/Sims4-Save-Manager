const { app, BrowserWindow, dialog, ipcMain, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const manager = require('./save-manager');
const { autoUpdater } = require('electron-updater');
const { createUpdates } = require('./updates');
const { discoverSaves, cloudRoots, assertLocalFolder, assertGameClosed } = require('./game-paths');
const { createArchive } = require('./archive');
const { createAutoBackup } = require('./auto-backup');
const { SAVE_NAME } = require('./save-inspector');
const { createBackupLibrary } = require('./backup-library');
const backupLibrary = createBackupLibrary();

app.setName('Sims 4 Save Manager');
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

let window;
let tray;
let config;
let configFile;
let localBackupFolder;
let roots;
let busy = false;
let quitting = false;
let updates;
let archive;
let protection;
let candidates = [];
let lastNotice;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const validateDestination = folder => assertLocalFolder(folder, roots);

async function persist(next) {
  await manager.saveConfig(configFile, next);
  config = next;
}

async function state() {
  let backups = [];
  let warning = '';
  let backupSaves = [];
  if (config.backup_folder) {
    try { ({ backups, saves: backupSaves } = await backupLibrary.list(config)); }
    catch (error) { warning = error.message; }
  }
  let backupWarning = '';
  try { await validateDestination(config.backup_folder); } catch (error) { backupWarning = error.message; }
  let saveStatus = { available: false, count: 0 };
  try {
    const folder = await manager.directory(config.save_folder);
    saveStatus = { available: true, count: (await fs.readdir(folder, { withFileTypes: true })).filter(entry => entry.isFile() && SAVE_NAME.test(entry.name)).length };
  } catch { /* Settings shows the chosen path so the user can reconnect it. */ }
  return { config, backups, backupSaves, warning, backupWarning, saveStatus, localBackupFolder, candidates, archive: archive.state(), protection: protection.status(), updates: updates.snapshot(), canStartAtLogin: app.isPackaged };
}

async function withLock(action) {
  if (busy || updates.snapshot().status === 'installing') return null;
  busy = true;
  try { return await action(); }
  finally { busy = false; }
}

function handle(channel, action, locksFiles = true) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) return { error: 'Untrusted window.' };
    if ((busy && channel !== 'state') || updates.snapshot().status === 'installing') return { error: 'Wait for the current operation to finish.' };
    try { return { value: locksFiles ? await withLock(() => action(...args)) : await action(...args) }; }
    catch (error) { return { error: error.message }; }
  });
}

function send(channel, value) {
  if (window && !window.webContents.isDestroyed()) window.webContents.send(channel, value);
}

function showWindow() {
  if (!window) createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1140, height: 900, minWidth: 760, minHeight: 640,
    title: 'Sims 4 Save Manager', icon: APP_ICON, backgroundColor: '#f6f7f4', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (updates.snapshot().status === 'installing') return;
    if (busy) event.preventDefault();
    else if (config.auto_backup && !quitting) { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'index.html'));
}

function configureProtection() {
  if (config.auto_backup && !tray) {
    const bitmap = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      if (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 7) bitmap.set([131, 237, 163, 255], (y * 16 + x) * 4);
    }
    const icon = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Sims 4 Save Manager — automatic protection');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Save Manager', click: showWindow }, { label: 'Quit (stops automatic backups)', click: () => app.quit() }]));
    tray.on('click', showWindow);
  }
  if (!config.auto_backup && tray) { tray.destroy(); tray = null; }
  if (config.auto_backup) protection.start(); else protection.stop();
}

async function confirmSwap(message, detail = 'Your current game will be copied to backups before it is replaced. The original imported file stays unchanged.') {
  await assertGameClosed();
  const choice = await dialog.showMessageBox(window, {
    type: 'warning', title: message, message,
    detail,
    buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (choice.response !== 1) return false;
  await assertGameClosed();
  return true;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(APP_ICON);
    const home = app.getPath('home');
    const documents = app.getPath('documents');
    roots = await cloudRoots(home);
    localBackupFolder = path.join(process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local') : app.getPath('appData'), 'Sims 4 Save Manager', 'Backups');
    configFile = path.join(app.getPath('userData'), 'config.json');
    config = { auto_backup: false, start_at_login: false, archive_folder: '', ...await manager.loadConfig(configFile, '') };
    config.auto_backup = config.auto_backup === true;
    config.start_at_login = config.start_at_login === true;
    candidates = await discoverSaves({ home, documents });
    if (!config.save_folder && candidates.length === 1) config.save_folder = candidates[0].folder;
    if (!config.backup_folder) {
      await fs.mkdir(localBackupFolder, { recursive: true });
      config.backup_folder = localBackupFolder;
    }
    updates = createUpdates({ updater: autoUpdater, version: app.getVersion(), enabled: app.isPackaged && ['darwin', 'win32'].includes(process.platform), isBusy: () => busy, onChange: value => send('update-state', value) });
    archive = createArchive({ file: path.join(app.getPath('userData'), 'archive.json'), getConfig: () => config, assertGameClosed, validateDestination });
    await archive.load();
    protection = createAutoBackup({
      getConfig: () => config, validateDestination, withLock,
      onSuccess: (value, names) => persist({ ...config, last_auto_success: value, last_auto_files: names }),
      onChange: value => {
        send('protection-state', value);
        if (value.status === 'watching') lastNotice = null;
        tray?.setToolTip(`Sims 4 Save Manager — ${value.message.slice(0, 100)}`);
        if (value.status === 'error' && (value.errorKey || value.message) !== lastNotice && Notification.isSupported()) {
          lastNotice = value.errorKey || value.message;
          new Notification({ title: 'Automatic backup needs attention', body: value.message }).show();
        }
      }
    });
    handle('update-action', action => {
      if (!['check', 'download', 'install'].includes(action)) throw new Error('Unknown update action.');
      return updates[action]();
    }, false);
    handle('state', state, false);
    handle('find-saves', async () => { candidates = await discoverSaves({ home, documents }); return state(); }, false);
    handle('use-candidate', async index => {
      if (!Number.isInteger(index) || !candidates[index]) throw new Error('Choose a detected folder.');
      if (archive.state().session) throw new Error('Return to your game or choose Keep this save before changing locations.');
      await persist({ ...config, save_folder: await manager.directory(candidates[index].folder), last_auto_files: null });
      protection.acceptChange();
      return state();
    });
    handle('use-local-backups', async () => {
      if (archive.state().session) throw new Error('Return to your game or choose Keep this save before changing locations.');
      await fs.mkdir(localBackupFolder, { recursive: true });
      await validateDestination(localBackupFolder);
      await persist({ ...config, backup_folder: localBackupFolder });
      return state();
    });
    handle('choose-folder', async kind => {
      if (!['save_folder', 'backup_folder', 'archive_folder'].includes(kind)) throw new Error('Unknown folder type.');
      if (kind !== 'archive_folder' && archive.state().session) throw new Error('Return to your game or choose Keep this save before changing locations.');
      const selection = await dialog.showOpenDialog(window, { title: kind === 'archive_folder' ? 'Import saves from a folder or drive' : kind === 'save_folder' ? 'Choose the folder The Sims 4 uses' : 'Choose where to keep backups', defaultPath: config[kind] || documents, properties: ['openDirectory', 'createDirectory'] });
      if (!selection.canceled && selection.filePaths.length) {
        const selected = await manager.directory(selection.filePaths[0]);
        if (kind === 'backup_folder' && config.auto_backup) await validateDestination(selected);
        await persist({ ...config, [kind]: selected, ...(kind === 'save_folder' ? { last_auto_files: null } : {}) });
        if (kind === 'save_folder') protection.acceptChange();
      }
      return { ...await state(), selectionCanceled: selection.canceled };
    });
    handle('scan-archive', async () => { await archive.scan(config.archive_folder); return state(); }, false);
    handle('import-saves', async ids => { const result = await archive.importSaves(ids); return { ...await state(), importResult: result }; });
    handle('keep-trial', async () => {
      if (!await confirmSwap('Keep this as my current game?', 'The game you are trying will be backed up and become your current game. Your previous game stays in Backups.')) return { canceled: true };
      const result = await archive.keepTrial();
      await persist({ ...config, last_auto_files: null }); protection.acceptChange();
      return { ...result, ...await state() };
    });
    handle('annotate-save', async (id, annotation) => { await archive.annotate(id, annotation); return state(); });
    handle('refresh-save-details', async id => { await archive.refreshDetails(id); return state(); });
    handle('refresh-backup-details', id => backupLibrary.refresh(config, id));
    handle('backup-lot-preview', (id, lotId) => backupLibrary.preview(config, id, lotId));
    handle('lot-preview', (id, lotId) => archive.lotPreview(id, lotId));
    handle('try-save', async id => {
      if (!await confirmSwap('Try this save in The Sims 4?')) return { canceled: true };
      await archive.trySave(id);
      await persist({ ...config, last_auto_files: null }); protection.acceptChange();
      return state();
    });
    handle('return-saves', async () => {
      if (!await confirmSwap('Return to my previous game?')) return { canceled: true };
      await archive.returnToPrevious();
      await persist({ ...config, last_auto_files: null }); protection.acceptChange();
      return state();
    });
    handle('protection-settings', async settings => {
      if (typeof settings?.enabled !== 'boolean' || typeof settings.startAtLogin !== 'boolean') throw new Error('Invalid protection settings.');
      if (settings.enabled) {
        await manager.folders(config);
        await validateDestination(config.backup_folder);
      }
      if (settings.startAtLogin && !app.isPackaged) throw new Error('Start at login is available in the installed app.');
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.enabled && settings.startAtLogin });
      try { await persist({ ...config, auto_backup: settings.enabled, start_at_login: settings.enabled && settings.startAtLogin, last_auto_files: settings.enabled && !config.auto_backup ? null : config.last_auto_files }); }
      catch (error) {
        if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.start_at_login });
        throw error;
      }
      configureProtection(); return state();
    });
    handle('backup', async note => ({ location: await manager.createBackup(config, note), ...await state() }));
    handle('restore', async name => {
      if (archive.state().session) throw new Error('Return to your game or choose Keep this save before restoring a backup.');
      if (!await confirmSwap('Restore this entire backup?', 'All save files in this backup set will replace the current set. Your current game will be copied to recovery backups first.')) return { canceled: true };
      const result = await manager.restoreBackup(config, name);
      await persist({ ...config, last_auto_files: null }); protection.acceptChange();
      return { ...result, ...await state() };
    });
    createWindow();
    configureProtection();
    updates.check();
    app.on('activate', showWindow);
  }).catch(error => { dialog.showErrorBox('Could not start Sims 4 Save Manager', error.message); app.quit(); });
  app.on('before-quit', event => {
    if (busy) event.preventDefault();
    else { quitting = true; protection?.stop(); }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !config?.auto_backup) app.quit(); });
}
