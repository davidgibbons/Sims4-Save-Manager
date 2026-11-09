const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { digest } = require('./save-inspector');

const NOTE = 'backup-note.txt';
const RECOVERY = 'Restored Backups';

async function directory(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new Error('Choose valid save and backup folders first.');
  }
  const resolved = await fs.realpath(folder);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Select a folder, not a file.');
  return resolved;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function folders(config) {
  const save = await directory(config.save_folder);
  const backup = await directory(config.backup_folder);
  if (contains(save, backup) || contains(backup, save)) {
    throw new Error('Save and backup folders must be separate, with neither inside the other.');
  }
  return { save, backup };
}

async function files(folder) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))) {
    throw new Error('Linked or special files are not supported. Choose a folder containing regular save files.');
  }
  return entries.filter(entry => entry.isFile() && entry.name !== NOTE).map(entry => entry.name);
}

async function copyFiles(source, destination, names) {
  for (const name of names) {
    await fs.copyFile(path.join(source, name), path.join(destination, name), constants.COPYFILE_EXCL);
  }
}

async function changeSignature(folder) {
  const names = (await files(folder)).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    const stat = await fs.lstat(path.join(folder, name));
    if (!stat.isFile()) throw new Error('Files changed while checking the save folder.');
    hash.update(JSON.stringify([name, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]));
  }
  return { names, hash: hash.digest('hex') };
}

async function fingerprint(folder) {
  const names = (await files(folder)).sort();
  const hash = createHash('sha256');
  for (const name of names) hash.update(JSON.stringify([name, await digest(path.join(folder, name))]));
  return { names, hash: hash.digest('hex') };
}

async function snapshot(source, destination, note = '', allowEmpty = false) {
  const before = await fingerprint(source);
  if (!before.names.length && !allowEmpty) throw new Error('This folder has no save files to back up.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = await fs.mkdtemp(path.join(destination, '.pending-'));
  const target = path.join(destination, `${stamp}-${path.basename(staging).slice(-6)}`);
  try {
    await copyFiles(source, staging, before.names);
    if ((await fingerprint(staging)).hash !== before.hash || (await fingerprint(source)).hash !== before.hash) {
      throw new Error('Files changed during backup or copy verification failed. Previous backups were kept.');
    }
    if (note.trim()) await fs.writeFile(path.join(staging, NOTE), note.trim(), 'utf8');
    await fs.rename(staging, target);
    return target;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function createBackup(config, note) {
  if (typeof note !== 'string' || note.length > 10000) throw new Error('Keep backup notes under 10,000 characters.');
  const { save, backup } = await folders(config);
  return snapshot(save, backup, note);
}

async function listBackups(config) {
  const backup = await directory(config.backup_folder);
  const result = [];
  const entries = await fs.readdir(backup, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === RECOVERY) continue;
    const folder = path.join(backup, entry.name);
    const names = await files(folder);
    if (!names.length) continue;
    let note = '';
    try {
      const notePath = path.join(folder, NOTE);
      if (!(await fs.lstat(notePath)).isFile()) throw new Error(`Invalid note in ${entry.name}.`);
      note = await fs.readFile(notePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    result.push({ name: entry.name, note, count: names.length });
  }
  return result.sort((a, b) => b.name.localeCompare(a.name));
}

async function restoreBackup(config, name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || name === RECOVERY || /[\\/:]/.test(name)) {
    throw new Error('Select a valid backup.');
  }
  const { save, backup } = await folders(config);
  const source = path.join(backup, name);
  if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Linked backups are not supported.');
  await directory(source);
  return restoreDirectory(config, source);
}

async function restoreDirectory(config, selected, allowEmpty = false) {
  const { save, backup } = await folders(config);
  if ((await fs.lstat(selected)).isSymbolicLink()) throw new Error('Linked backups are not supported.');
  const source = await directory(selected);
  if (!contains(backup, source) || source === backup) throw new Error('The restore source must be inside the backup folder.');
  const original = await fingerprint(source);
  const replacement = original.names;
  if (!replacement.length && !allowEmpty) throw new Error('The selected backup contains no save files.');
  const current = await files(save);
  for (const file of replacement) {
    try {
      if (!(await fs.lstat(path.join(save, file))).isFile()) throw new Error(`A folder blocks restoring ${file}.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const recoveryRoot = path.join(backup, RECOVERY);
  await fs.mkdir(recoveryRoot, { recursive: true });
  if ((await fs.lstat(recoveryRoot)).isSymbolicLink()) throw new Error('The recovery folder must not be a link.');
  const staging = await fs.mkdtemp(path.join(path.dirname(save), '.sims-restore-'));
  let recovery;
  const installed = [];
  try {
    await copyFiles(source, staging, replacement);
    if ((await fingerprint(staging)).hash !== original.hash || (await fingerprint(source)).hash !== original.hash) {
      throw new Error('The selected backup changed during restore preparation. No saves were replaced.');
    }
    if (current.length) recovery = await snapshot(save, recoveryRoot);
    // Keep the recovery copy intact even if installing or rolling back fails.
    try {
      for (const file of current) await fs.unlink(path.join(save, file));
      for (const file of replacement) {
        installed.push(file);
        await fs.copyFile(path.join(staging, file), path.join(save, file), constants.COPYFILE_EXCL);
      }
      if ((await fingerprint(save)).hash !== original.hash) throw new Error('Restored files failed verification or were changed by another program.');
    } catch (error) {
      try {
        for (const file of installed) await fs.rm(path.join(save, file), { force: true });
        if (recovery) {
          for (const file of current) await fs.copyFile(path.join(recovery, file), path.join(save, file));
        }
      } catch (rollbackError) {
        throw new Error(`Restore and rollback failed. Recover your original saves from ${recovery}. ${rollbackError.message}`);
      }
      throw new Error(`Restore failed; original saves were recovered. ${error.message}`);
    }
    return { recovery: recovery || null };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function loadConfig(file, defaultSave) {
  try {
    const config = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!config || typeof config.save_folder !== 'string' || typeof config.backup_folder !== 'string') {
      throw new Error('Invalid folder settings.');
    }
    return config;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read settings at ${file}: ${error.message}`);
    return { save_folder: defaultSave, backup_folder: '' };
  }
}

async function saveConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

module.exports = { createBackup, listBackups, restoreBackup, restoreDirectory, fingerprint, changeSignature, snapshot, directory, contains, folders, loadConfig, saveConfig };
