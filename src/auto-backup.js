const fs = require('node:fs/promises');
const path = require('node:path');
const manager = require('./save-manager');
const { SAVE_NAME } = require('./save-inspector');

function createAutoBackup({ getConfig, validateDestination, withLock, onChange, onSuccess = async () => {}, now = Date.now, settleMs = 10000 }) {
  let timer;
  let running = false;
  let candidate;
  let since;
  let saved;
  let savedLocation;
  let savedSignature;
  let lastNames = Array.isArray(getConfig().last_auto_files) ? getConfig().last_auto_files : null;
  let state = { status: 'off', message: 'Automatic protection is off.', lastSuccess: getConfig().last_auto_success || null };
  const status = () => ({ ...state });
  function report(value, message) { state = { ...state, status: value, message }; onChange(status()); }
  async function tick() {
    if (running || !getConfig().auto_backup) return;
    running = true;
    try {
      const result = await withLock(async () => {
        const config = getConfig();
        await validateDestination(config.backup_folder);
        const before = await manager.changeSignature(config.save_folder);
        const key = JSON.stringify([config.save_folder, config.backup_folder, before.hash]);
        if (key === saved) {
          let intact = false;
          try { intact = (await manager.changeSignature(savedLocation)).hash === savedSignature; } catch { /* Recreate a missing or changed local snapshot. */ }
          if (intact) { report('watching', 'Protected. Watching for saved changes.'); return true; }
          saved = undefined;
        }
        if (candidate !== key) { candidate = key; since = now(); }
        if (now() - since < settleMs) { report('settling', 'Save changes detected. Waiting for files to settle…'); return true; }
        if (lastNames?.some(name => !before.names.includes(name))) throw new Error('Save files disappeared. Previous backups are safe. Review the game folder and cloud sync; switch protection off and on to accept an intentional deletion.');
        if (!before.names.some(name => SAVE_NAME.test(name))) throw new Error('No Sims save files found. Previous backups are safe; check the game folder and cloud sync.');
        for (const name of before.names.filter(name => SAVE_NAME.test(name))) {
          const file = await fs.open(path.join(config.save_folder, name), 'r');
          try {
            const header = Buffer.alloc(4);
            const { bytesRead } = await file.read(header, 0, 4, 0);
            if (bytesRead !== 4 || header.toString('ascii') !== 'DBPF') throw new Error(`Save ${name} is empty or unrecognized. Previous backups are safe.`);
          } finally { await file.close(); }
        }
        report('backing-up', 'Creating a verified automatic backup…');
        const location = await manager.createBackup(config, 'Automatic protective backup');
        const after = await manager.changeSignature(config.save_folder);
        if (after.hash === before.hash) {
          saved = key; savedLocation = location;
          savedSignature = (await manager.changeSignature(location)).hash;
        }
        state.lastSuccess = new Date(now()).toISOString();
        await onSuccess(state.lastSuccess, before.names);
        lastNames = before.names;
        report('watching', `Protected. Last automatic backup: ${location}`);
        return true;
      });
      if (!result) report('waiting', 'Waiting for the current save operation to finish.');
    } catch (error) {
      candidate = undefined;
      state.errorKey = error.code || error.message;
      report('error', `Automatic backup needs attention: ${error.message}`);
    } finally { running = false; }
  }
  return {
    status, tick,
    acceptChange() { candidate = undefined; saved = undefined; lastNames = null; },
    start() { clearInterval(timer); timer = setInterval(() => { void tick(); }, 5000); timer.unref(); void tick(); },
    stop() { clearInterval(timer); candidate = undefined; saved = undefined; lastNames = null; report('off', 'Automatic protection is off.'); }
  };
}
module.exports = { createAutoBackup };
