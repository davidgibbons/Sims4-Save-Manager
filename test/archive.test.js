const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createArchive } = require('../src/archive');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saves = path.join(root, 'saves'); const backups = path.join(root, 'backups'); const old = path.join(root, 'old');
  for (const folder of [saves, backups, old]) await fs.mkdir(folder);
  const options = { file: path.join(root, 'archive.json'), getConfig: () => ({ save_folder: saves, backup_folder: backups }), assertGameClosed: async () => {}, validateDestination: async () => {} };
  const archive = createArchive(options); await archive.load();
  return { root, saves, backups, old, options, archive };
}

test('nested saves and recovery copies are identified; labels persist by content', async t => {
  const { old, options, archive } = await setup(t);
  await fs.mkdir(path.join(old, 'nested'));
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF old');
  await fs.writeFile(path.join(old, 'nested', 'Slot_00000002.save.ver0'), 'DBPF old');
  const state = await archive.scan(old);
  assert.equal(state.entries.length, 2);
  assert.ok(state.entries.every(entry => entry.duplicates === 1));
  await archive.annotate(state.entries[0].id, { label: 'Right family', notes: 'Before wedding', tried: true });
  const reopened = createArchive(options); await reopened.load();
  assert.ok((await reopened.scan(old)).entries.every(entry => entry.annotation.label === 'Right family'));
});

test('multiple trials preserve originals and keep the initial return point across restarts', async t => {
  const { saves, old, options, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF current');
  const original = path.join(old, 'Slot_00000002.save.ver0');
  await fs.writeFile(original, 'DBPF old');
  await archive.scan(old);
  await archive.trySave(archive.state().entries[0].id);
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000002.save'), 'utf8'), 'DBPF old');
  const baseline = archive.state().session.baseline;
  await fs.writeFile(path.join(saves, 'Slot_00000002.save'), 'DBPF played trial');
  await archive.trySave(archive.state().entries[0].id);
  assert.equal(archive.state().session.baseline, baseline);
  assert.equal(await fs.readFile(original, 'utf8'), 'DBPF old');
  const restarted = createArchive(options); await restarted.load();
  await restarted.returnToPrevious();
  assert.deepEqual(await fs.readdir(saves), ['Slot_00000009.save']);
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000009.save'), 'utf8'), 'DBPF current');
  assert.equal(restarted.state().session, null);
});

test('empty initial folders can be returned to and active-save archives are refused', async t => {
  const { saves, old, archive } = await setup(t);
  await fs.writeFile(path.join(old, 'renamed.save'), 'DBPF old');
  await archive.scan(old); await archive.trySave(archive.state().entries[0].id);
  await archive.returnToPrevious(); assert.deepEqual(await fs.readdir(saves), []);
  await fs.writeFile(path.join(saves, 'Slot_00000002.save'), 'DBPF current');
  await archive.scan(saves);
  await assert.rejects(archive.trySave(archive.state().entries[0].id), /outside the active/);
});

test('changed archive files and a running game cannot replace current saves', async t => {
  const { saves, old, archive, options } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF current');
  const source = path.join(old, 'Slot_00000002.save');
  await fs.writeFile(source, 'DBPF old'); await archive.scan(old);
  await fs.writeFile(source, 'changed');
  await assert.rejects(archive.trySave(archive.state().entries[0].id), /changed since/);
  const blocked = createArchive({ ...options, assertGameClosed: async () => { throw new Error('Close the game'); } });
  await blocked.load(); await blocked.scan(old);
  await assert.rejects(blocked.trySave(blocked.state().entries[0].id), /Close the game/);
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000009.save'), 'utf8'), 'DBPF current');
});

test('an interrupted trial keeps a restartable return journal and the original saves', async t => {
  const { saves, old, options, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF current');
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF old');
  await archive.scan(old);
  const copy = fs.copyFile;
  let failed = false;
  t.mock.method(fs, 'copyFile', async (source, destination, flags) => {
    if (!failed && path.basename(path.dirname(destination)) === 'saves' && source.includes('.sims-restore-')) {
      failed = true; throw new Error('Simulated disk failure');
    }
    return copy(source, destination, flags);
  });
  await assert.rejects(archive.trySave(archive.state().entries[0].id), /original saves were recovered/);
  const restarted = createArchive(options); await restarted.load();
  assert.ok(restarted.state().session.baseline);
  await restarted.returnToPrevious();
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000009.save'), 'utf8'), 'DBPF current');
});

test('import copies and verifies saves, skips duplicates, and survives removal of the source drive', async t => {
  const { saves, old, backups, options, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF current');
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF imported');
  await fs.writeFile(path.join(old, 'Slot_00000002.save.ver0'), 'DBPF imported');
  const scanned = await archive.scan(old);
  const original = await fs.readFile(scanned.entries[0].file);
  const result = await archive.importSaves(scanned.entries.map(entry => entry.id));
  assert.deepEqual(result, { imported: 1, skipped: 1 });
  assert.deepEqual(await fs.readFile(scanned.entries[0].file), original);
  const [saved] = archive.state().imports;
  assert.ok(saved.file.startsWith(await fs.realpath(backups)));
  assert.equal(saved.modified, scanned.entries[0].modified);
  assert.deepEqual(await archive.importSaves([scanned.entries[0].id]), { imported: 0, skipped: 1 });
  await archive.annotate(saved.id, { label: 'Wedding', notes: 'Found on old PC', tried: false });
  await fs.rm(old, { recursive: true });
  const restarted = createArchive(options); await restarted.load();
  assert.equal(restarted.state().imports[0].annotation.label, 'Wedding');
  await restarted.trySave(saved.id);
  assert.deepEqual(await fs.readFile(path.join(saves, 'Slot_00000002.save')), original);
  await restarted.returnToPrevious();
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000009.save'), 'utf8'), 'DBPF current');
});

test('a failed import never registers incomplete copies or changes source saves', async t => {
  const { old, backups, archive } = await setup(t);
  const source = path.join(old, 'Slot_00000002.save');
  await fs.writeFile(source, 'DBPF old'); await archive.scan(old);
  const copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (from, to, flags) => { await copy(from, to, flags); await fs.writeFile(to, 'damaged'); });
  await assert.rejects(archive.importSaves([archive.state().entries[0].id]), /verification/);
  assert.equal(archive.state().imports.length, 0);
  assert.deepEqual(await fs.readdir(path.join(backups, 'Imported saves')), []);
  assert.equal(await fs.readFile(source, 'utf8'), 'DBPF old');
});

test('keeping a trial backs up current progress, ends the trial, and retains the previous game', async t => {
  const { saves, old, options, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF original game');
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF trial');
  await archive.scan(old); await archive.trySave(archive.state().entries[0].id);
  const baseline = archive.state().session.baseline;
  await fs.writeFile(path.join(saves, 'Slot_00000002.save'), 'DBPF played trial');
  const kept = await archive.keepTrial();
  assert.equal(archive.state().session, null);
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000002.save'), 'utf8'), 'DBPF played trial');
  assert.equal(await fs.readFile(path.join(kept.location, 'Slot_00000002.save'), 'utf8'), 'DBPF played trial');
  assert.equal(await fs.readFile(path.join(baseline, 'Slot_00000009.save'), 'utf8'), 'DBPF original game');
  const restarted = createArchive(options); await restarted.load(); assert.equal(restarted.state().session, null);
});

test('a failed keep backup leaves the trial and its return point intact', async t => {
  const { saves, old, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF original');
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF trial');
  await archive.scan(old); await archive.trySave(archive.state().entries[0].id);
  const baseline = archive.state().session.baseline;
  t.mock.method(fs, 'copyFile', async () => { throw new Error('Disk full'); });
  await assert.rejects(archive.keepTrial(), /Disk full/);
  assert.equal(archive.state().session.baseline, baseline);
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000002.save'), 'utf8'), 'DBPF trial');
});

test('renaming the save being tried updates the trial banner name', async t => {
  const { saves, old, archive } = await setup(t);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF original');
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF trial');
  await archive.scan(old); const entry = archive.state().entries[0];
  await archive.trySave(entry.id);
  await archive.annotate(entry.id, { label: 'The right family', notes: '', tried: true });
  assert.equal(archive.state().session.currentName, 'The right family');
});

test('refresh reads an older imported record from its stored copy and preserves its identity, notes and trial', async t => {
  const { old, saves, options, archive } = await setup(t);
  const field = (number, text) => { const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text); return Buffer.concat([Buffer.from([number * 8 + 2, bytes.length]), bytes]); };
  const lotId = Buffer.alloc(9); lotId[0] = 9; lotId.writeBigUInt64LE(42n, 1);
  const proto = Buffer.concat([field(2, field(9, 'Wedding')), field(7, Buffer.concat([lotId, field(2, 'Wedding home')]))]);
  const header = Buffer.alloc(96); header.write('DBPF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 36); header.writeUInt32LE(96, 40);
  const index = Buffer.alloc(34); index.writeUInt32LE(13, 4); index.writeUInt32LE(130, 20); index.writeUInt32LE(proto.length, 24); index.writeUInt32LE(proto.length, 28);
  const bytes = Buffer.concat([header, index, proto]);
  await fs.writeFile(path.join(old, 'renamed.save.ver2'), bytes);
  await fs.writeFile(path.join(saves, 'Slot_00000009.save'), 'DBPF current');
  await archive.scan(old); await archive.importSaves([archive.state().entries[0].id]);
  const original = archive.state().imports[0];
  await archive.annotate(original.id, { label: 'My wedding', notes: 'Found it', tried: true });
  await archive.trySave(original.id);
  const journal = JSON.parse(await fs.readFile(options.file, 'utf8'));
  delete journal.imports[0].metadataVersion; delete journal.imports[0].saveName;
  await fs.writeFile(options.file, JSON.stringify(journal)); await fs.rm(old, { recursive: true });
  const reopened = createArchive(options); await reopened.load();
  await reopened.refreshDetails(original.id);
  const refreshed = reopened.state().imports[0];
  assert.equal(refreshed.saveName, 'Wedding'); assert.equal(refreshed.metadataVersion, 4);
  for (const key of ['id', 'file', 'modified', 'slot', 'recoveryVersion', 'originalFile', 'originalName', 'importedAt']) assert.equal(refreshed[key], original[key]);
  assert.deepEqual(refreshed.annotation, { label: 'My wedding', notes: 'Found it', tried: true });
  assert.deepEqual(reopened.state().session, journal.session);
  assert.deepEqual(await fs.readFile(refreshed.file), bytes);
  const beforePreview = await fs.readFile(options.file);
  assert.equal(await reopened.lotPreview(original.id, '42'), null);
  await assert.rejects(reopened.lotPreview(original.id, '../42'), /select a recorded lot/);
  await assert.rejects(reopened.lotPreview('not-imported', '42'), /select a recorded lot/);
  assert.deepEqual(await fs.readFile(options.file), beforePreview);
  const restarted = createArchive(options); await restarted.load(); assert.equal(restarted.state().imports[0].saveName, 'Wedding');
  await restarted.returnToPrevious();
  assert.equal(await fs.readFile(path.join(saves, 'Slot_00000009.save'), 'utf8'), 'DBPF current');
  await fs.writeFile(refreshed.file, 'changed');
  await assert.rejects(restarted.lotPreview(original.id, '42'), /stored save changed/);
});

test('refresh rejects changed or unreadable copies without rewriting library details', async t => {
  const { old, archive, options } = await setup(t);
  await fs.writeFile(path.join(old, 'Slot_00000002.save'), 'DBPF old');
  await archive.scan(old); await archive.importSaves([archive.state().entries[0].id]);
  const saved = archive.state().imports[0];
  const before = await fs.readFile(options.file);
  await assert.rejects(archive.refreshDetails(saved.id), /Metadata unknown/);
  await fs.writeFile(saved.file, 'changed');
  await assert.rejects(archive.refreshDetails(saved.id), /stored save changed/);
  await assert.rejects(archive.refreshDetails({ file: saved.file }), /Select an imported/);
  assert.deepEqual(await fs.readFile(options.file), before);
});
