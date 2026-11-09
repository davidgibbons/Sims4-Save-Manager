const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { contains, discoverSaves, assertLocalFolder, cloudRoots } = require('../src/game-paths');

test('finds ordinary and redirected OneDrive saves without assuming the newest is active', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const documents = path.join(root, 'redirected-documents');
  const cloud = path.join(home, 'OneDrive - Family');
  for (const base of [documents, path.join(cloud, 'Documents')]) {
    const save = path.join(base, 'Electronic Arts', 'The Sims 4', 'saves');
    await fs.mkdir(save, { recursive: true });
    await fs.writeFile(path.join(save, 'Slot_00000002.save'), 'DBPF');
  }
  const found = await discoverSaves({ home, documents, env: { OneDrive: cloud } });
  assert.equal(found.length, 2);
  assert.equal(found.filter(entry => entry.cloud).length, 1);
  assert.ok(found.every(entry => entry.count === 1));
  await assert.rejects(assertLocalFolder(path.join(cloud, 'Documents'), [cloud]), /outside OneDrive/);
  await assertLocalFolder(documents, [cloud]);
  assert.equal(contains('C:\\Users\\ME\\OneDrive', 'c:\\users\\me\\onedrive\\saves', 'win32'), true);
  assert.equal(contains('/home/OneDrive', '/home/OneDrive-old'), false);
});

test('cloud aliases cannot disguise the backup destination', { skip: process.platform === 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-cloud-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cloud = path.join(root, 'OneDrive');
  await fs.mkdir(cloud);
  const alias = path.join(root, 'local-looking');
  await fs.symlink(cloud, alias, 'dir');
  await assert.rejects(assertLocalFolder(alias, [cloud]), /outside OneDrive/);
});

test('recognizes Windows DirectX variants and the Mac game process', () => {
  const { gameIsRunning } = require('../src/game-paths');
  assert.equal(gameIsRunning('"TS4_x64.exe","1234","Console"'), true);
  assert.equal(gameIsRunning('"TS4_DX9_x64.exe","1234","Console"'), true);
  assert.equal(gameIsRunning('/Applications/The Sims 4.app/Contents/MacOS/The Sims 4\n'), true);
  assert.equal(gameIsRunning('"EA.exe","1234","Console"'), false);
});

test('treats iCloud for Windows as a cloud-sync folder', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-icloud-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const icloud = path.join(home, 'iCloudDrive');
  await fs.mkdir(path.join(icloud, 'Sims Backups'), { recursive: true });
  const roots = await cloudRoots(home, {});
  assert.ok(roots.includes(icloud));
  await assert.rejects(assertLocalFolder(path.join(icloud, 'Sims Backups'), roots), /outside OneDrive/);
});
