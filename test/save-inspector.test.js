const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deflateSync } = require('node:zlib');
const { parseMetadata, inspectSave, readLotPreview, digest } = require('../src/save-inspector');
const { matchSave, filterLots, filterHouseholds, lotHouseholds } = require('../src/library-search');

function varint(value) {
  value = BigInt(value); const bytes = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function field(number, value) { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]); }
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
function fixed(field, value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return Buffer.concat([varint(field * 8 + 1), bytes]); }
function fixture(compressed = false, proto = Buffer.concat([field(2, field(9, 'Before the wedding')), field(5, field(3, 'Goth')), field(6, Buffer.concat([field(5, 'Bella'), field(6, 'Goth')]))])) {
  let resource = compressed ? deflateSync(proto) : proto;
  if (compressed === 'internal') {
    const header = Buffer.from([0x10, 0xfb, 0, 0, proto.length]);
    const length = proto.length - proto.length % 4;
    resource = Buffer.concat([header, Buffer.from([0xe0 + length / 4 - 1]), proto.subarray(0, length), Buffer.from([0xfc + proto.length % 4]), proto.subarray(length)]);
  }
  const header = Buffer.alloc(96);
  header.write('DBPF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(1, 36); header.writeUInt32LE(96, 40); header.writeBigUInt64LE(96n, 64);
  const index = Buffer.alloc(compressed ? 36 : 34);
  index.writeUInt32LE(13, 4); index.writeUInt32LE(96 + index.length, 20); index.writeUInt32LE((resource.length + (compressed ? 0x80000000 : 0)) >>> 0, 24); index.writeUInt32LE(proto.length, 28);
  if (compressed) index.writeUInt16LE(compressed === 'internal' ? 0xffff : 0x5a42, 32);
  return Buffer.concat([header, index, resource]);
}

test('reads embedded save, household and Sim names from uncompressed and zlib DBPF resources', () => {
  for (const compressed of [false, true, 'internal']) {
    const result = parseMetadata(fixture(compressed));
    assert.equal(result.saveName, 'Before the wedding');
    assert.deepEqual(result.households, ['Goth']);
    assert.deepEqual(result.sims, ['Bella Goth']);
  }
});

test('joins the active household, life stages and locations without rounding 64-bit IDs', () => {
  const family = 9007199254740993n;
  const lot = 18446744073709551614n;
  const proto = Buffer.concat([
    field(2, Buffer.concat([field(9, 'Wedding'), number(11, family), fixed(5, lot), number(10, 1700000000), field(17, Buffer.concat([field(1, Buffer.concat([varint(3), varint(26), varint(999)])), number(1, 3)]))])),
    field(3, Buffer.concat([field(10, '1.100.1'), field(17, '1.90.2')])),
    field(4, Buffer.concat([fixed(1, 42), field(3, 'Willow Creek')])),
    field(7, Buffer.concat([fixed(1, lot), field(2, 'Ophelia Villa'), fixed(10, 42), number(3, 10)])),
    field(5, Buffer.concat([fixed(2, family), field(3, 'Goth'), fixed(4, lot), number(5, 0), field(18, 'Before the wedding')])),
    field(5, Buffer.concat([fixed(2, family - 1n), field(3, 'Neighbors')])),
    ...[[family, 'Bella', 32], [family, 'Baby', 128], [family, 'Toddler', 2], [family - 1n, 'Neighbor', 513]].map(([household, name, age], index) => field(6, Buffer.concat([fixed(1, index + 1), fixed(4, household), field(5, name), number(8, age)])))
  ]);
  for (const compressed of [false, true]) {
    const result = parseMetadata(fixture(compressed, proto));
    assert.equal(result.activeHousehold.id, family.toString());
    assert.equal(result.activeHousehold.funds, '0');
    assert.equal(result.activeHousehold.description, 'Before the wedding');
    assert.deepEqual(result.activeHousehold.members.map(sim => sim.lifeStage), ['Adult', 'Infant', 'Toddler']);
    assert.equal(result.householdDetails[1].members.length, 1);
    assert.equal(result.householdDetails[1].members[0].lifeStage, null);
    assert.equal(result.householdDetails[1].funds, null);
    assert.equal(result.activeHousehold.homeLot.name, 'Ophelia Villa');
    assert.equal(result.lastPlayedLocation.neighborhood, 'Willow Creek');
    assert.equal(result.gameVersion, '1.100.1');
    assert.equal(result.createdGameVersion, '1.90.2');
    assert.equal(result.recordedTimestamp, '1700000000');
    assert.deepEqual(result.requiredPacks, [{ id: '3', name: 'Get to Work' }, { id: '26', name: 'Seasons' }, { id: '999', name: null }]);
    assert.equal(result.householdCount, 2); assert.equal(result.simCount, 4);
  }
});

test('absent fields remain unknown and malformed numeric encodings are rejected', () => {
  const result = parseMetadata(fixture());
  assert.equal(result.activeHousehold, null);
  assert.equal(result.householdDetails[0].funds, null);
  assert.deepEqual(result.householdDetails[0].members, []);
  assert.equal(result.recordedTimestamp, null);
  assert.deepEqual(result.requiredPacks, []);
  const unmatched = parseMetadata(fixture(false, Buffer.concat([field(2, number(11, 1)), field(5, Buffer.concat([fixed(2, 2), field(3, 'Not the active family'), number(5, 18446744073709551615n)]))])));
  assert.equal(unmatched.activeHousehold, null);
  assert.equal(unmatched.activeHouseholdId, '1');
  assert.equal(unmatched.householdDetails[0].funds, '18446744073709551615');
  assert.throws(() => parseMetadata(fixture(false, field(2, Buffer.concat([varint(80), Buffer.alloc(10, 255)])))), /integer/);
  assert.throws(() => parseMetadata(fixture(false, field(7, Buffer.from([9, 1, 2])))));
});

test('inspection preserves source bytes and describes recovery files and renamed archives', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-inspect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Slot_00000002.save.ver1');
  const bytes = fixture(true);
  await fs.writeFile(file, bytes);
  const result = await inspectSave(file);
  assert.equal(result.recoveryVersion, 1);
  assert.equal(result.slot, '00000002');
  assert.equal(result.saveName, 'Before the wedding');
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.rename(file, path.join(root, 'wedding.save'));
  assert.equal((await inspectSave(path.join(root, 'wedding.save'))).slot, null);
});

test('corrupt and hostile resource sizes return unknown metadata without crashing', async t => {
  assert.throws(() => parseMetadata(Buffer.from('DBPF')), /recognized/);
  const oversized = fixture(true); oversized.writeUInt32LE(0xffffffff, 124);
  assert.throws(() => parseMetadata(oversized), /limit/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Slot_00000002.save');
  await fs.writeFile(file, 'broken');
  assert.match((await inspectSave(file)).detail, /Metadata unknown/);
  for (let length = 0; length < 180; length++) {
    const buffer = Buffer.alloc(length, 255);
    assert.throws(() => parseMetadata(buffer));
  }
});

test('malformed internal compression is stopped by the worker deadline', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = fixture('internal').subarray(0, 132);
  base.writeUInt32LE(0x80000006, 120); base.writeUInt32LE(1, 124);
  const bytes = Buffer.concat([base, Buffer.from([0x10, 0xfb, 0, 0, 1, 0])]);
  const file = path.join(root, 'Slot_00000002.save');
  await fs.writeFile(file, bytes);
  assert.match((await inspectSave(file)).detail, /timed out|stopped/);
});

function lotSave({ family, sims, lots }) {
  const familyId = 900n;
  return parseMetadata(fixture(false, Buffer.concat([
    field(2, Buffer.concat([field(9, 'Story'), number(11, familyId)])),
    field(4, Buffer.concat([fixed(1, 42), field(3, 'Windenburg')])),
    ...lots.map(([id, name, extra = Buffer.alloc(0)]) => field(7, Buffer.concat([fixed(1, id), field(2, name), fixed(10, 42), extra]))),
    field(5, Buffer.concat([fixed(2, familyId), field(3, family), fixed(4, lots[0][0])])),
    ...sims.map((name, index) => field(6, Buffer.concat([fixed(1, index + 1), fixed(4, familyId), field(5, name), field(6, family), number(8, 32)])))
  ])));
}

test('reads every recorded lot with exact IDs, room counts, descriptions and household links', () => {
  const home = 18446744073709551613n;
  const result = lotSave({ family: 'Lightfeather', sims: ['Ana'], lots: [
    [home, 'Cliffside Cottage', Buffer.concat([field(14, 'A breezy home'), number(16, 3), number(17, 2), fixed(6, 900)])],
    [7n, 'Empty Lot']
  ] });
  assert.equal(result.metadataVersion, 4);
  assert.equal(result.lotCount, 2);
  const [cottage, empty] = result.lots;
  assert.equal(cottage.id, home.toString());
  assert.equal(cottage.neighborhood, 'Windenburg');
  assert.equal(cottage.description, 'A breezy home');
  assert.equal(cottage.bedrooms, 3); assert.equal(cottage.bathrooms, 2);
  assert.equal(cottage.householdId, '900');
  assert.deepEqual(cottage.homeHouseholdIds, ['900']);
  assert.deepEqual([empty.bedrooms, empty.bathrooms, empty.description, empty.homeHouseholdIds], [null, null, '', []]);
  assert.deepEqual(lotHouseholds(result, cottage), ['Lightfeather']);
  assert.equal(result.activeHousehold.homeLot.name, 'Cliffside Cottage');
});

test('player-household filtering uses explicit flags and preserves unknown play history', () => {
  const record = (id, flag, unplayed) => field(5, Buffer.concat([fixed(2, id), field(3, `Family ${id}`), ...(flag === null ? [] : [number(31, flag)]), ...(unplayed === null ? [] : [number(14, unplayed)])]));
  const result = parseMetadata(fixture(false, Buffer.concat([record(1, 1, 0), record(2, 0, 1), record(3, null, null), record(4, 2, 2)])));
  assert.deepEqual(result.householdDetails.map(household => [household.isPlayer, household.isUnplayed]), [[true, false], [false, true], [null, null], [null, null]]);
  assert.deepEqual(filterHouseholds(result, true).map(household => household.name), ['Family 1']);
  assert.equal(filterHouseholds(result, false).length, 4);
  assert.equal(filterHouseholds({ householdDetails: [{ name: 'Legacy household' }] }, true).length, 0);
  assert.equal(filterHouseholds({}).length, 0);
});

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCUAD0Kf//Z', 'base64');
function packageFixture(resources, flags = 0) {
  const values = resource => [resource.type, 0, Number(BigInt(resource.id || 0) >> 32n)];
  const shared = values(resources[0]);
  const packed = resources.map(resource => ({ ...resource, data: resource.compressed ? deflateSync(resource.bytes) : resource.bytes }));
  const words = []; const word = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value >>> 0); words.push(bytes); };
  const sharedCount = [1, 2, 4].filter(bit => flags & bit).length;
  let position = 96 + 4 + sharedCount * 4 + packed.reduce((sum, resource) => sum + 30 - sharedCount * 4 + (resource.compressed ? 2 : 0), 0);
  word(flags); for (let i = 0; i < 3; i++) if (flags & (1 << i)) word(shared[i]);
  for (const resource of packed) {
    const fields = values(resource);
    for (let i = 0; i < 3; i++) { if (!(flags & (1 << i))) word(fields[i]); else assert.equal(fields[i], shared[i]); }
    word(Number(BigInt(resource.id || 0) & 0xffffffffn)); word(position);
    word(resource.data.length + (resource.compressed ? 0x80000000 : 0)); word(resource.bytes.length);
    if (resource.compressed) words.push(Buffer.from([0x42, 0x5a]));
    words.push(Buffer.alloc(2)); position += resource.data.length;
  }
  const header = Buffer.alloc(96); header.write('DBPF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(1, 8); header.writeUInt32LE(resources.length, 36); header.writeBigUInt64LE(96n, 64);
  return Buffer.concat([header, ...words, ...packed.map(resource => resource.data)]);
}
function translucentJpeg(width = 1) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8;
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255]))), chunk('IEND', Buffer.alloc(0))]);
  const segment = Buffer.alloc(12 + png.length); segment.writeUInt16BE(0xffe0); segment.writeUInt16BE(png.length + 10, 2); segment.write('ALFA', 4); segment.writeUInt32BE(png.length, 8); png.copy(segment, 12);
  const insertion = 4 + JPEG.readUInt16BE(4);
  return Buffer.concat([JPEG.subarray(0, insertion), segment, JPEG.subarray(insertion)]);
}

test('lot modification flags distinguish explicit true/false from missing, duplicate and corrupt records', () => {
  const ids = [18446744073709551613n, 2n, 3n, 4n, 5n];
  const save = Buffer.concat(ids.map(id => field(7, Buffer.concat([fixed(1, id), field(2, `Lot ${id}`)]))));
  const building = (id, flag) => ({ type: 6, id, compressed: true, bytes: Buffer.concat([fixed(1, id), ...(flag === null ? [] : [number(6, flag)])]) });
  const bytes = packageFixture([{ type: 13, bytes: save }, building(ids[0], 1), building(2n, 0), building(3n, null), building(4n, 1), building(4n, 0), { type: 6, id: 5n, bytes: Buffer.from([255]) }, { type: 16, id: ids[0], bytes: JPEG }]);
  const result = parseMetadata(bytes);
  assert.deepEqual(result.lots.map(lot => lot.modification), ['modified', 'unmodified', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(result.lots.map(lot => lot.hasPreview), [true, false, false, false, false]);
  assert.deepEqual(filterLots(result, '', true).map(lot => lot.id), [ids[0].toString()]);
  assert.equal(filterLots(result, 'Lot 2', true).length, 0);
  assert.equal(filterLots(result, 'Lot 2').length, 1);
  const mismatched = parseMetadata(packageFixture([{ type: 13, bytes: save }, { type: 6, id: ids[0], bytes: Buffer.concat([fixed(1, 2), number(6, 1)]) }]));
  assert.equal(mismatched.lots[0].modification, 'unknown');
});

test('previews load on demand by exact lot ID, including shared indexes, transparency and a corrupt-image fallback', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-preview-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'preview.save'); const id = '18446744073709551613';
  const image = translucentJpeg();
  const bytes = packageFixture([{ type: 16, id, bytes: Buffer.from('bad image') }, { type: 15, id, bytes: image, compressed: true }, { type: 16, id: '2', bytes: JPEG }]);
  await fs.writeFile(file, bytes); const hash = await digest(file);
  const preview = await readLotPreview(file, id, hash);
  assert.equal(preview.width, 1); assert.equal(preview.height, 1);
  assert.deepEqual(Buffer.from(preview.image.split(',')[1], 'base64'), image);
  assert.ok(preview.mask.startsWith('data:image/png;base64,'));
  assert.equal(await readLotPreview(file, '3', hash), null);
  await assert.rejects(readLotPreview(file, '../2', hash), /valid lot/);
  await assert.rejects(readLotPreview(file, '18446744073709551616', hash), /valid lot/);
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.writeFile(file, packageFixture([{ type: 16, id, bytes: JPEG }], 7));
  assert.ok(await readLotPreview(file, id, await digest(file)));
  await assert.rejects(readLotPreview(file, id, hash), /stored save changed/);
});

test('oversized, malformed and mismatched preview payloads are rejected without hiding lot metadata', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sims-preview-bad-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'bad.save');
  const huge = Buffer.from(JPEG); const frame = huge.indexOf(Buffer.from([255, 192])); assert.ok(frame > 0); huge.writeUInt16BE(2049, frame + 7);
  const startScan = JPEG.indexOf(Buffer.from([255, 218]));
  const repeatedFrame = Buffer.concat([JPEG.subarray(0, startScan), JPEG.subarray(frame, frame + 2 + JPEG.readUInt16BE(frame + 2)), JPEG.subarray(startScan)]);
  const truncatedMask = translucentJpeg(); truncatedMask.writeUInt32BE(1000000, truncatedMask.indexOf(Buffer.from('ALFA')) + 4);
  for (const image of [Buffer.from('broken'), translucentJpeg(2), huge, repeatedFrame, truncatedMask, Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const bytes = packageFixture([{ type: 13, bytes: field(7, Buffer.concat([fixed(1, 1), field(2, 'Still visible')])) }, { type: 16, id: 1n, bytes: image }]);
    await fs.writeFile(file, bytes);
    assert.equal(parseMetadata(bytes).lots[0].name, 'Still visible');
    await assert.rejects(readLotPreview(file, '1', await digest(file)), /preview|Preview|limit/);
  }
});

test('search defaults to families, Sims and notes; lots are a separate scope with matching hints', () => {
  const feathers = { ...lotSave({ family: 'Lightfeather', sims: ['Ana', 'Joe', 'Kit'], lots: [[1n, 'Cliffside Cottage']] }), annotation: {} };
  const lighthouse = { ...lotSave({ family: 'Goth', sims: ['Bella'], lots: [[1n, 'Goth Manor'], [2n, 'The Lighthouse', field(14, 'Watch the light at sea')]] }), annotation: { notes: 'Before the wedding' } };
  const saves = [feathers, lighthouse];
  const found = (query, scope) => saves.filter(entry => matchSave(entry, query, scope));
  assert.deepEqual(found('Light'), [feathers]);
  assert.deepEqual(found('feather'), [feathers]);
  assert.deepEqual(found('wedding'), [lighthouse]);
  assert.deepEqual(found('Light', 'lots'), [lighthouse]);
  assert.deepEqual(found('windenburg', 'lots'), saves);
  assert.equal(matchSave(feathers, 'feather').hint, 'Matches Family: Lightfeather · Sim: Ana Lightfeather, Joe Lightfeather +1');
  const lots = matchSave(lighthouse, 'light', 'lots');
  assert.equal(lots.hint, 'Matches Lot: The Lighthouse');
  assert.deepEqual(lots.lotIds, ['2']);
  assert.deepEqual(filterLots(lighthouse, 'sea').map(lot => lot.name), ['The Lighthouse']);
  assert.equal(filterLots(lighthouse, '').length, 2);
  assert.equal(matchSave(lighthouse, lighthouse.hash ?? '900'), null);
  assert.deepEqual(matchSave(feathers, ''), { hint: '', lotIds: [] });
  assert.equal(matchSave({ kind: 'backup', note: 'Automatic protective backup', title: 'Automatic backup' }, 'nov 9', 'people', 'Nov 9, 2026, 2:00 PM').hint, 'Matches Date: Nov 9, 2026, 2:00 PM');
});
