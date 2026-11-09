const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { deflateSync } = require('node:zlib');
const { parseMetadata, inspectSave } = require('../src/save-inspector');
const { matchSave, filterLots, lotHouseholds } = require('../src/library-search');

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
  assert.equal(result.metadataVersion, 2);
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
