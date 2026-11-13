const fs = require('node:fs/promises');
const path = require('node:path');
const manager = require('./save-manager');
const { ARCHIVE_SAVE, inspectSave, readLotPreview } = require('./save-inspector');

function createBackupLibrary() {
  const cache = new Map();
  async function selected(config, id, root) {
    let parts;
    try { parts = JSON.parse(id); } catch { throw new Error('Select a backed-up save first.'); }
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(part => typeof part !== 'string' || !part || part.startsWith('.') || /[\\/:]/.test(part)) || parts[0] === 'Restored Backups' || parts[1] === 'backup-note.txt') throw new Error('Select a valid backed-up save.');
    root = root || await manager.directory(config.backup_folder);
    const [backupName, name] = parts;
    const folder = path.join(root, backupName);
    if (!(await fs.lstat(folder)).isDirectory() || !manager.contains(root, await fs.realpath(folder))) throw new Error('Linked backups are not supported.');
    const file = path.join(folder, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || !manager.contains(folder, await fs.realpath(file))) throw new Error('Linked or special backup files are not supported.');
    const key = JSON.stringify([root, id]);
    const signature = JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);
    if (cache.get(key)?.signature !== signature) cache.delete(key);
    return { ...cache.get(key)?.details, id, file, name, size: stat.size, modified: stat.mtime.toISOString(), backupName, kind: 'backup', annotation: {}, inspectable: ARCHIVE_SAVE.test(name), key, signature };
  }
  async function list(config) {
    const root = await manager.directory(config.backup_folder);
    const backups = await manager.listBackups(config);
    const saves = [];
    const live = new Set();
    for (const backup of backups) {
      const saveNames = backup.files.filter(name => ARCHIVE_SAVE.test(name));
      for (const name of saveNames.length ? saveNames : backup.files) {
        const entry = await selected(config, JSON.stringify([backup.name, name]), root);
        live.add(entry.key);
        saves.push({ ...entry, note: backup.note, count: backup.count });
      }
    }
    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
    return { backups, saves };
  }
  async function refresh(config, id) {
    const entry = await selected(config, id);
    if (!entry.inspectable) return;
    const details = await inspectSave(entry.file);
    const after = await selected(config, id);
    if (after.signature !== entry.signature) throw new Error('The backed-up save changed while reading it. Refresh again.');
    cache.set(entry.key, { signature: entry.signature, details });
  }
  async function preview(config, id, lotId) {
    const entry = await selected(config, id);
    if (!entry.hash || !entry.lots?.some(lot => lot.id === lotId)) throw new Error('Refresh this backed-up save and select a recorded lot first.');
    return readLotPreview(entry.file, lotId, entry.hash);
  }
  return { list, refresh, preview };
}
module.exports = { createBackupLibrary };
