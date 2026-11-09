const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackup, listBackups, restoreBackup, loadConfig, saveConfig } = require('../src/save-manager');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-manager-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { save_folder: path.join(root, 'saves'), backup_folder: path.join(root, 'backups') };
  await fs.mkdir(config.save_folder);
  await fs.mkdir(config.backup_folder);
  return { root, config };
}

test('backup preserves save bytes, notes, and source files without copying subfolders', async t => {
  const { config } = await setup(t);
  const bytes = Buffer.from([0, 255, 12, 128]);
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000001.save'), bytes);
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000001.save.ver0'), 'older version');
  await fs.mkdir(path.join(config.save_folder, 'ignored'));
  const first = await createBackup(config, 'Before the wedding');
  const second = await createBackup(config, '');
  assert.notEqual(first, second);
  assert.deepEqual(await fs.readFile(path.join(first, 'Slot_00000001.save')), bytes);
  assert.deepEqual(await fs.readFile(path.join(config.save_folder, 'Slot_00000001.save')), bytes);
  const entries = await listBackups(config);
  assert.equal(entries.length, 2);
  assert.equal(entries.find(entry => entry.name === path.basename(first)).note, 'Before the wedding');
  assert.equal(entries[0].count, 2);
  assert.deepEqual((await fs.readdir(first)).sort(), ['Slot_00000001.save', 'Slot_00000001.save.ver0', 'backup-note.txt']);
});

test('restore reads Python V2 backups and keeps original saves in recovery', async t => {
  const { config } = await setup(t);
  const legacy = path.join(config.backup_folder, '2025-01-02_03-04-05');
  await fs.mkdir(legacy);
  await fs.writeFile(path.join(legacy, 'Slot_00000001.save'), 'legacy');
  await fs.writeFile(path.join(legacy, 'backup-note.txt'), 'Old note');
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000001.save'), 'current');
  await fs.writeFile(path.join(config.save_folder, 'extra.save'), 'extra');
  await fs.mkdir(path.join(config.save_folder, 'keep-folder'));
  await fs.writeFile(path.join(config.save_folder, 'keep-folder', 'untouched'), 'keep');
  const result = await restoreBackup(config, path.basename(legacy));
  assert.equal(await fs.readFile(path.join(config.save_folder, 'Slot_00000001.save'), 'utf8'), 'legacy');
  assert.equal(await fs.readFile(path.join(result.recovery, 'Slot_00000001.save'), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(result.recovery, 'extra.save'), 'utf8'), 'extra');
  assert.equal(await fs.readFile(path.join(config.save_folder, 'keep-folder', 'untouched'), 'utf8'), 'keep');
  assert.deepEqual((await fs.readdir(config.save_folder)).sort(), ['Slot_00000001.save', 'keep-folder']);
  assert.deepEqual(await listBackups(config), [{ name: path.basename(legacy), note: 'Old note', count: 1 }]);
});

test('restore works when the current save folder is empty', async t => {
  const { config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'Slot.save'), 'backup');
  const backup = await createBackup(config, '');
  await fs.unlink(path.join(config.save_folder, 'Slot.save'));
  assert.deepEqual(await restoreBackup(config, path.basename(backup)), { recovery: null });
  assert.equal(await fs.readFile(path.join(config.save_folder, 'Slot.save'), 'utf8'), 'backup');
});

test('overlapping folders and empty sources are rejected', async t => {
  const { config } = await setup(t);
  await assert.rejects(createBackup(config, ''), /no save files/);
  await assert.rejects(createBackup({ ...config, backup_folder: config.save_folder }, ''), /separate/);
  const nested = path.join(config.save_folder, 'nested');
  await fs.mkdir(nested);
  await assert.rejects(createBackup({ ...config, backup_folder: nested }, ''), /separate/);
  await assert.rejects(createBackup({ save_folder: nested, backup_folder: config.save_folder }, ''), /separate/);
  await assert.rejects(createBackup({ ...config, save_folder: 'relative' }, ''), /valid/);
});

test('restore rejects path traversal, empty backups, and directory collisions before touching saves', async t => {
  const { config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'current.save'), 'safe');
  for (const name of ['../saves', '..\\saves', '/saves', 'Restored Backups', '', 'C:bad']) {
    await assert.rejects(restoreBackup(config, name), /valid backup/);
  }
  await fs.mkdir(path.join(config.backup_folder, 'empty'));
  await assert.rejects(restoreBackup(config, 'empty'), /no save files/);
  await fs.writeFile(path.join(config.backup_folder, 'empty', 'collision'), 'replacement');
  await fs.mkdir(path.join(config.save_folder, 'collision'));
  await assert.rejects(restoreBackup(config, 'empty'), /blocks restoring/);
  assert.equal(await fs.readFile(path.join(config.save_folder, 'current.save'), 'utf8'), 'safe');
});

test('linked folders cannot disguise overlapping locations', { skip: process.platform === 'win32' }, async t => {
  const { root, config } = await setup(t);
  const link = path.join(root, 'alias');
  await fs.symlink(config.save_folder, link, 'dir');
  await assert.rejects(createBackup({ ...config, backup_folder: link }, ''), /separate/);
});

test('linked backups, files, notes, and recovery folders are rejected', { skip: process.platform === 'win32' }, async t => {
  const { root, config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'current.save'), 'safe');
  const backup = await createBackup(config, '');
  await fs.symlink(backup, path.join(config.backup_folder, 'linked'), 'dir');
  await assert.rejects(restoreBackup(config, 'linked'), /Linked backups/);
  await fs.symlink(path.join(config.save_folder, 'current.save'), path.join(backup, 'backup-note.txt'));
  await assert.rejects(listBackups(config), /Linked or special/);
  await fs.unlink(path.join(backup, 'backup-note.txt'));
  await fs.symlink(root, path.join(config.backup_folder, 'Restored Backups'), 'dir');
  await assert.rejects(restoreBackup(config, path.basename(backup)), /recovery folder/);
  await fs.symlink(path.join(config.save_folder, 'current.save'), path.join(config.save_folder, 'linked.save'));
  await assert.rejects(createBackup(config, ''), /Linked or special/);
});

test('failed backup removes staging and never appears as a completed backup', async t => {
  const { config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'current.save'), 'safe');
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Disk full'); });
  await assert.rejects(createBackup(config, ''), /Disk full/);
  assert.deepEqual(await fs.readdir(config.backup_folder), []);
  assert.equal(await fs.readFile(path.join(config.save_folder, 'current.save'), 'utf8'), 'safe');
});

test('failed restore rolls back partial writes and preserves recovery', async t => {
  const { config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'new.save'), 'backup');
  const backup = await createBackup(config, '');
  await fs.unlink(path.join(config.save_folder, 'new.save'));
  await fs.writeFile(path.join(config.save_folder, 'current.save'), 'original');
  const copyFile = fs.copyFile;
  const save = await fs.realpath(config.save_folder);
  t.mock.method(fs, 'copyFile', async (source, destination, ...args) => {
    if (path.dirname(destination) === save && path.basename(destination) === 'new.save') {
      await fs.writeFile(destination, 'partial');
      throw new Error('Disk full');
    }
    return copyFile(source, destination, ...args);
  });
  await assert.rejects(restoreBackup(config, path.basename(backup)), /original saves were recovered/);
  assert.deepEqual(await fs.readdir(config.save_folder), ['current.save']);
  assert.equal(await fs.readFile(path.join(config.save_folder, 'current.save'), 'utf8'), 'original');
  const recoveryRoot = path.join(config.backup_folder, 'Restored Backups');
  const [recovery] = await fs.readdir(recoveryRoot);
  assert.equal(await fs.readFile(path.join(recoveryRoot, recovery, 'current.save'), 'utf8'), 'original');
});

test('failure before restore staging completes leaves current saves untouched', async t => {
  const { config } = await setup(t);
  await fs.writeFile(path.join(config.save_folder, 'current.save'), 'original');
  const backup = await createBackup(config, '');
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Cannot read backup'); });
  await assert.rejects(restoreBackup(config, path.basename(backup)), /Cannot read backup/);
  assert.equal(await fs.readFile(path.join(config.save_folder, 'current.save'), 'utf8'), 'original');
});

test('configuration persists without overwriting corrupt settings on load', async t => {
  const { root, config } = await setup(t);
  const file = path.join(root, 'config.json');
  assert.deepEqual(await loadConfig(file, config.save_folder), { save_folder: config.save_folder, backup_folder: '' });
  await saveConfig(file, config);
  assert.deepEqual(await loadConfig(file, ''), config);
  await fs.writeFile(file, '{broken');
  await assert.rejects(loadConfig(file, ''), /Cannot read settings/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('a corrupt copy or changing source never becomes a completed backup', async t => {
  const { config } = await setup(t);
  const source = path.join(config.save_folder, 'Slot_00000002.save');
  await fs.writeFile(source, 'original');
  const copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from, to, flags) => {
    await copy(from, to, flags);
    await fs.writeFile(to, 'corrupt');
  });
  await assert.rejects(createBackup(config, ''), /verification failed/);
  assert.deepEqual(await fs.readdir(config.backup_folder), []);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
});

test('a source changed during copying is retried without publishing an inconsistent snapshot', async t => {
  const { config } = await setup(t);
  const source = path.join(config.save_folder, 'Slot_00000002.save');
  await fs.writeFile(source, 'first');
  const copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from, to, flags) => {
    await copy(from, to, flags);
    await fs.writeFile(from, 'second');
  });
  await assert.rejects(createBackup(config, ''), /changed during backup/);
  assert.deepEqual(await fs.readdir(config.backup_folder), []);
  assert.equal(await fs.readFile(source, 'utf8'), 'second');
});
