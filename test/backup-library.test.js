const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupLibrary } = require('../src/backup-library');
const { createBackup, restoreBackup } = require('../src/save-manager');
const { digest } = require('../src/save-inspector');
const { duplicateCounts, matchSave } = require('../src/library-search');

function fixture() {
  const varint = value => { const bytes = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value); return Buffer.from(bytes); };
  const field = (key, data) => { data = Buffer.isBuffer(data) ? data : Buffer.from(data); return Buffer.concat([varint(key * 8 + 2), varint(data.length), data]); };
  const fixed = (key, value) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return Buffer.concat([varint(key * 8 + 1), data]); };
  const proto = Buffer.concat([field(2, field(9, 'Wedding')), field(4, Buffer.concat([fixed(1, 9), field(3, 'Willow Creek')])), field(7, Buffer.concat([fixed(1, 42), field(2, 'Rose Cottage'), fixed(10, 9)])), field(5, Buffer.concat([fixed(2, 1), field(3, 'Lightfeather'), Buffer.from([248, 1, 1])]))]);
  const header = Buffer.alloc(96); header.write('DBPF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 36); header.writeBigUInt64LE(96n, 64);
  const index = Buffer.alloc(34); index.writeUInt32LE(13, 4); index.writeUInt32LE(130, 20); index.writeUInt32LE(proto.length, 24); index.writeUInt32LE(proto.length, 28);
  return Buffer.concat([header, index, proto]);
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-backup-library-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { save_folder: path.join(root, 'saves'), backup_folder: path.join(root, 'backups') };
  await fs.mkdir(config.save_folder); await fs.mkdir(config.backup_folder);
  const bytes = fixture();
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000001.save'), bytes);
  await fs.writeFile(path.join(config.save_folder, 'Slot_00000001.save.ver0'), bytes);
  await fs.writeFile(path.join(config.save_folder, 'notes.txt'), 'Preserve this too');
  const folder = await createBackup(config, 'Before wedding');
  return { root, config, folder, bytes, library: createBackupLibrary() };
}

test('individual backup saves expose read-only metadata, full hashes and duplicate identity', async t => {
  const { config, folder, bytes, library } = await setup(t);
  let state = await library.list(config);
  assert.equal(state.backups.length, 1); assert.equal(state.saves.length, 2);
  const entries = state.saves.filter(entry => entry.inspectable);
  assert.equal(entries.length, 2); assert.ok(entries.every(entry => !entry.hash));
  for (const entry of entries) await library.refresh(config, entry.id);
  state = await library.list(config);
  const entry = state.saves.find(entry => entry.hash);
  assert.equal(entry.saveName, 'Wedding'); assert.equal(entry.lots[0].name, 'Rose Cottage');
  assert.equal(entry.householdDetails[0].isPlayer, true);
  assert.equal(entry.hash, await digest(path.join(folder, entry.name)));
  assert.equal(duplicateCounts(state.saves).get(entry.hash), 2);
  assert.ok(matchSave(entry, 'Light')); assert.deepEqual(matchSave(entry, 'Rose', 'lots').lotIds, ['42']);
  assert.ok(matchSave(entry, entry.hash.slice(0, 12)));
  assert.equal(await library.preview(config, entry.id, '42'), null);
  await assert.rejects(library.preview(config, entry.id, '99'), /recorded lot/);
  assert.deepEqual(await fs.readFile(path.join(folder, entry.name)), bytes);
  assert.deepEqual(await fs.readFile(path.join(config.save_folder, entry.name)), bytes);
  assert.deepEqual((await fs.readdir(folder)).sort(), ['Slot_00000001.save', 'Slot_00000001.save.ver0', 'backup-note.txt', 'notes.txt']);
});

test('changed, removed and relocated files invalidate cached details and previews', async t => {
  const { root, config, folder, library } = await setup(t);
  const entry = (await library.list(config)).saves.find(entry => entry.inspectable);
  await library.refresh(config, entry.id);
  const originalHash = (await library.list(config)).saves.find(save => save.id === entry.id).hash;
  await fs.writeFile(path.join(folder, entry.name), 'changed');
  assert.equal((await library.list(config)).saves.find(save => save.id === entry.id).hash, undefined);
  await assert.rejects(library.preview(config, entry.id, '42'), /Refresh/);
  await library.refresh(config, entry.id);
  assert.notEqual((await library.list(config)).saves.find(save => save.id === entry.id).hash, originalHash);
  const elsewhere = path.join(root, 'elsewhere'); await fs.mkdir(elsewhere);
  assert.deepEqual((await library.list({ ...config, backup_folder: elsewhere })).saves, []);
  await fs.rm(path.join(folder, entry.name));
  await assert.rejects(library.refresh(config, entry.id), /ENOENT/);
});

test('backup selectors reject traversal, recovery folders, files and directory links', async t => {
  const { root, config, folder, library } = await setup(t);
  for (const id of [null, 'not-json', '[]', '["..","x.save"]', '["backup","../x.save"]', '["Restored Backups","x.save"]', '["backup","backup-note.txt"]']) await assert.rejects(library.refresh(config, id), /Select/);
  const outside = path.join(root, 'outside.save'); await fs.writeFile(outside, fixture());
  const name = 'linked.save'; await fs.symlink(outside, path.join(folder, name));
  await assert.rejects(library.refresh(config, JSON.stringify([path.basename(folder), name])), /Linked/);
  await fs.rm(path.join(folder, name));
  await fs.symlink(folder, path.join(config.backup_folder, 'linked'), 'junction');
  await assert.rejects(library.refresh(config, JSON.stringify(['linked', 'Slot_00000001.save'])), /Linked/);
});

test('restoring the selected backup still restores every file and preserves current saves', async t => {
  const { config, folder, bytes, library } = await setup(t);
  const entry = (await library.list(config)).saves.find(save => save.inspectable);
  await fs.writeFile(path.join(config.save_folder, entry.name), 'current game');
  const result = await restoreBackup(config, entry.backupName);
  assert.deepEqual(await fs.readFile(path.join(config.save_folder, 'Slot_00000001.save.ver0')), bytes);
  assert.equal(await fs.readFile(path.join(config.save_folder, 'notes.txt'), 'utf8'), 'Preserve this too');
  assert.equal(await fs.readFile(path.join(result.recovery, entry.name), 'utf8'), 'current game');
  assert.deepEqual(await fs.readFile(path.join(folder, entry.name)), bytes);
});

test('duplicate comparison uses the full digest, never the displayed prefix', () => {
  const first = 'a'.repeat(64); const second = 'a'.repeat(12) + 'b'.repeat(52);
  const counts = duplicateCounts([{ hash: first }, { hash: second }, { hash: first }, { hash: 'unknown' }]);
  assert.equal(counts.get(first), 2); assert.equal(counts.get(second), 1); assert.equal(counts.size, 2);
});
