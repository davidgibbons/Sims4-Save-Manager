const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAutoBackup } = require('../src/auto-backup');

async function setup(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-auto-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { auto_backup: true, save_folder: path.join(root, 'saves'), backup_folder: path.join(root, 'backups') };
  await fs.mkdir(config.save_folder); await fs.mkdir(config.backup_folder);
  const source = path.join(config.save_folder, 'Slot_00000002.save');
  await fs.writeFile(source, 'DBPF current');
  let time = 1000;
  let locked = false;
  const changes = [];
  const service = createAutoBackup({ getConfig: () => config, validateDestination: async () => {}, withLock: async action => locked ? null : action(), onChange: value => changes.push(value), now: () => time, settleMs: 100, ...overrides });
  return { config, source, service, changes, advance: () => { time += 200; }, lock: () => { locked = true; } };
}

test('waits for settled saves, makes a verified snapshot, and avoids unchanged duplicates', async t => {
  const { config, source, service, advance } = await setup(t);
  await service.tick(); assert.equal(service.status().status, 'settling');
  assert.deepEqual(await fs.readdir(config.backup_folder), []);
  advance(); await service.tick();
  assert.equal(service.status().status, 'watching');
  assert.ok(service.status().lastSuccess);
  const [snapshot] = await fs.readdir(config.backup_folder);
  assert.equal(await fs.readFile(path.join(config.backup_folder, snapshot, path.basename(source)), 'utf8'), 'DBPF current');
  await service.tick(); assert.equal((await fs.readdir(config.backup_folder)).length, 1);
  await fs.writeFile(source, 'DBPF new'); await service.tick(); advance(); await service.tick();
  assert.equal((await fs.readdir(config.backup_folder)).length, 2);
});

test('missing and empty saves do not delete or supersede earlier snapshots', async t => {
  const { config, source, service, advance } = await setup(t);
  await service.tick(); advance(); await service.tick();
  await fs.writeFile(source, ''); await service.tick(); advance(); await service.tick();
  assert.equal(service.status().status, 'error');
  await fs.unlink(source); await service.tick(); advance(); await service.tick();
  assert.match(service.status().message, /disappeared/);
  assert.equal((await fs.readdir(config.backup_folder)).length, 1);
});

test('busy restore, unsafe destination, and failed copy leave protection recoverable', async t => {
  const { config, service, advance, lock } = await setup(t);
  lock(); await service.tick(); assert.equal(service.status().status, 'waiting');
  const unsafe = await setup(t, { validateDestination: async () => { throw new Error('Cloud folder'); } });
  await unsafe.service.tick(); assert.match(unsafe.service.status().message, /Cloud folder/);
  const failure = await setup(t);
  await failure.service.tick(); failure.advance();
  t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); });
  await failure.service.tick(); assert.match(failure.service.status().message, /Disk full/);
  assert.equal(failure.service.status().errorKey, 'ENOSPC');
  assert.deepEqual(await fs.readdir(failure.config.backup_folder), []);
  config.auto_backup = false; advance(); await service.tick();
});

test('app-controlled trial swaps can be acknowledged without losing older backups', async t => {
  const { config, source, service, advance } = await setup(t);
  await service.tick(); advance(); await service.tick();
  await fs.unlink(source);
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000003.save'), 'DBPF trial');
  service.acceptChange();
  await service.tick(); advance(); await service.tick();
  assert.equal(service.status().status, 'watching');
  assert.equal((await fs.readdir(config.backup_folder)).length, 2);
});

test('unchanged saves are protected again if the last snapshot is removed', async t => {
  const { config, service, advance } = await setup(t);
  await service.tick(); advance(); await service.tick();
  const [snapshot] = await fs.readdir(config.backup_folder);
  await fs.rm(path.join(config.backup_folder, snapshot), { recursive: true });
  await service.tick();
  assert.equal((await fs.readdir(config.backup_folder)).length, 1);
  assert.equal(service.status().status, 'watching');
});

test('temporary empty files during a save settle before they can raise an alarm', async t => {
  const { source, service, advance, changes } = await setup(t);
  await service.tick(); advance(); await service.tick();
  await fs.writeFile(source, ''); await service.tick();
  assert.equal(service.status().status, 'settling');
  await fs.writeFile(source, 'DBPF completed'); await service.tick();
  advance(); await service.tick();
  assert.equal(service.status().status, 'watching');
  assert.equal(changes.some(state => state.status === 'error'), false);
});
