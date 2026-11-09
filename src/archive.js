const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ARCHIVE_SAVE, inspectSave, digest } = require('./save-inspector');
const manager = require('./save-manager');

function createArchive({ file, getConfig, assertGameClosed, validateDestination }) {
  let data = { annotations: {}, session: null, imports: [] };
  let entries = [];
  let warnings = [];
  const persist = next => manager.saveConfig(file, next).then(() => { data = next; });
  async function load() {
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!value || typeof value.annotations !== 'object' || value.annotations === null || !Object.hasOwn(value, 'session')) throw new Error('Invalid archive journal.');
      if (value.session !== null && (!value.session || !['baseline', 'saveFolder', 'backupFolder'].every(key => typeof value.session[key] === 'string' && path.isAbsolute(value.session[key])))) throw new Error('Invalid trial return point.');
      const imports = value.imports || [];
      if (!Array.isArray(imports) || imports.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.file !== 'string' || !path.isAbsolute(entry.file) || !/^[a-f0-9]{64}$/.test(entry.hash))) throw new Error('Invalid imported saves catalog.');
      data = { ...value, imports };
    } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read archive journal. Keep ${file} for recovery. ${error.message}`); }
  }
  function state() {
    return { entries: entries.map(entry => ({ ...entry, annotation: data.annotations[entry.hash] || {} })), imports: data.imports.map(entry => ({ ...entry, annotation: data.annotations[entry.hash] || {} })), warnings: [...warnings], session: data.session };
  }
  async function scan(root) {
    root = await manager.directory(root);
    const found = [];
    warnings = [];
    let visited = 0;
    let limited = false;
    async function walk(folder, depth) {
      if (depth > 12 || visited > 10000 || found.length >= 1000) { limited = true; return; }
      let children;
      try { children = await fs.readdir(folder, { withFileTypes: true }); }
      catch (error) { warnings.push(`Could not read ${folder}: ${error.message}`); return; }
      for (const child of children) {
        if (++visited > 10000 || found.length >= 1000) { limited = true; break; }
        const target = path.join(folder, child.name);
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory() && !child.name.startsWith('.')) await walk(target, depth + 1);
        else if (child.isFile() && ARCHIVE_SAVE.test(child.name)) {
          try { found.push({ id: randomUUID(), ...await inspectSave(target), relative: path.relative(root, target) }); }
          catch (error) { warnings.push(`Could not inspect ${target}: ${error.message}`); }
        }
      }
    }
    await walk(root, 0);
    if (limited) warnings.push('Scan limit reached (1,000 saves, 10,000 entries, or 12 folder levels). Choose a smaller archive folder.');
    const counts = new Map();
    for (const entry of found) counts.set(entry.hash, (counts.get(entry.hash) || 0) + 1);
    entries = found.map(entry => ({ ...entry, duplicates: counts.get(entry.hash) - 1 })).sort((a, b) => b.modified.localeCompare(a.modified));
    return state();
  }
  async function annotate(id, annotation) {
    const entry = [...entries, ...data.imports].find(item => item.id === id);
    if (!entry) throw new Error('Scan the archive and select a save first.');
    if (typeof annotation?.label !== 'string' || annotation.label.length > 200 || typeof annotation.notes !== 'string' || annotation.notes.length > 10000 || typeof annotation.tried !== 'boolean') throw new Error('Invalid save label or notes.');
    const session = data.session?.currentHash === entry.hash ? { ...data.session, currentName: annotation.label || entry.saveName || entry.originalName || entry.name } : data.session;
    await persist({ ...data, session, annotations: { ...data.annotations, [entry.hash]: annotation } });
    return state();
  }
  async function refreshDetails(id) {
    const entry = typeof id === 'string' && data.imports.find(item => item.id === id);
    if (!entry) throw new Error('Select an imported save to refresh its details.');
    const inspected = await inspectSave(entry.file);
    if (inspected.hash !== entry.hash) throw new Error('The stored save changed. Its library details were not updated.');
    if (!inspected.metadataVersion) throw new Error(inspected.detail);
    const { file: storedFile, name, slot, recoveryVersion, size, modified, hash, ...details } = inspected;
    await persist({ ...data, imports: data.imports.map(item => item.id === id ? { ...item, ...details } : item) });
    return state();
  }
  async function trySave(id) {
    await assertGameClosed();
    const config = { ...getConfig() };
    await manager.folders(config);
    await validateDestination(config.backup_folder);
    const entry = [...entries, ...data.imports].find(item => item.id === id);
    if (!entry) throw new Error('Scan the archive and select a save first.');
    if (data.session && (data.session.saveFolder !== config.save_folder || data.session.backupFolder !== config.backup_folder)) throw new Error('Return to previous saves before changing folders.');
    const source = await fs.realpath(entry.file);
    if (manager.contains(await manager.directory(config.save_folder), source)) throw new Error('Choose an archive outside the active saves folder so originals cannot be overwritten.');
    if (!entry.size) throw new Error('An empty file cannot be tried as a save.');
    if (await digest(entry.file) !== entry.hash) throw new Error('The archive file changed since scanning. Scan again before trying it.');
    const stage = await fs.mkdtemp(path.join(config.backup_folder, '.trial-'));
    try {
      const name = `Slot_${entry.slot || '00000002'}.save`;
      const target = path.join(stage, name);
      await fs.copyFile(entry.file, target, require('node:fs').constants.COPYFILE_EXCL);
      if (await digest(target) !== entry.hash || await digest(entry.file) !== entry.hash) throw new Error('The archive file changed during copying. No saves were replaced.');
      if (!data.session) {
        const baseline = await manager.snapshot(config.save_folder, config.backup_folder, 'My game before trying another save', true);
        await persist({ ...data, session: { baseline, saveFolder: config.save_folder, backupFolder: config.backup_folder, started: new Date().toISOString() } });
      }
      await assertGameClosed();
      await manager.restoreDirectory(config, stage);
      const previous = data.annotations[entry.hash] || {};
      await persist({ ...data, session: { ...data.session, currentHash: entry.hash, currentName: previous.label || entry.saveName || entry.originalName || entry.name }, annotations: { ...data.annotations, [entry.hash]: { label: previous.label || '', notes: previous.notes || '', tried: true } } });
      return state();
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async function importSaves(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string')) throw new Error('Select the saves you want to import.');
    const selected = [...new Set(ids)].map(id => entries.find(entry => entry.id === id));
    if (selected.some(entry => !entry || !entry.size)) throw new Error('Scan again and select non-empty save files.');
    const config = getConfig();
    const backup = await manager.directory(config.backup_folder);
    await validateDestination(backup);
    if (config.save_folder) {
      let save;
      try { save = await manager.directory(config.save_folder); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      if (save && (manager.contains(save, backup) || manager.contains(backup, save))) throw new Error('Save location and Backup location must be separate folders.');
    }
    const root = path.join(backup, 'Imported saves');
    await fs.mkdir(root, { recursive: true });
    if ((await fs.lstat(root)).isSymbolicLink() || !manager.contains(backup, await manager.directory(root))) throw new Error('The imported saves folder must be inside the Backup location and cannot be a link.');
    const staging = await fs.mkdtemp(path.join(root, '.import-'));
    const target = path.join(root, randomUUID());
    const imported = [];
    const handled = new Set();
    let skipped = 0;
    let committed = false;
    try {
      for (const entry of selected) {
        if (handled.has(entry.hash)) { skipped++; continue; }
        handled.add(entry.hash);
        if (await digest(entry.file) !== entry.hash) throw new Error('A source save changed after scanning. Scan again before importing.');
        const existing = data.imports.find(item => item.hash === entry.hash);
        if (existing) {
          let intact = false;
          try { intact = await digest(existing.file) === entry.hash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (intact) { skipped++; continue; }
        }
        const name = `Slot_${entry.slot || '00000002'}.save${entry.recoveryVersion === null ? '' : '.ver' + entry.recoveryVersion}`;
        const folder = path.join(staging, entry.hash);
        await fs.mkdir(folder);
        const copy = path.join(folder, name);
        await fs.copyFile(entry.file, copy, require('node:fs').constants.COPYFILE_EXCL);
        if (await digest(copy) !== entry.hash || await digest(entry.file) !== entry.hash) throw new Error('An imported copy failed verification or its source changed. Nothing was added to your library.');
        imported.push({ ...entry, id: randomUUID(), file: path.join(target, entry.hash, name), name, originalFile: entry.file, originalName: entry.name, importedAt: new Date().toISOString() });
      }
      if (imported.length) {
        await fs.rename(staging, target);
        const hashes = new Set(imported.map(entry => entry.hash));
        await persist({ ...data, imports: [...data.imports.filter(entry => !hashes.has(entry.hash)), ...imported] });
      }
      committed = true;
      return { imported: imported.length, skipped };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
      if (!committed) await fs.rm(target, { recursive: true, force: true });
    }
  }

  async function keepTrial() {
    await assertGameClosed();
    if (!data.session) throw new Error('There is no trial game to keep.');
    const { saveFolder, backupFolder, currentName } = data.session;
    const config = { save_folder: saveFolder, backup_folder: backupFolder };
    await validateDestination(backupFolder);
    const location = await manager.createBackup(config, `Kept as my current game: ${currentName || 'trial save'}`);
    await persist({ ...data, session: null });
    return { location };
  }

  async function returnToPrevious() {
    await assertGameClosed();
    if (!data.session) throw new Error('There is no active trial to return from.');
    const { baseline, saveFolder, backupFolder } = data.session;
    const config = { save_folder: saveFolder, backup_folder: backupFolder };
    await validateDestination(backupFolder);
    await manager.restoreDirectory(config, baseline, true);
    await persist({ ...data, session: null });
    return state();
  }
  return { load, scan, state, annotate, refreshDetails, trySave, returnToPrevious, importSaves, keepTrial };
}
module.exports = { createArchive };
