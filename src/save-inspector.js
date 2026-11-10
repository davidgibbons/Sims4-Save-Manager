const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const SAVE_NAME = /^Slot_([0-9a-f]{8})\.save(?:\.ver(\d+))?$/i;
const ARCHIVE_SAVE = /\.save(?:\.ver(\d{1,3}))?$/i;
const MAX_RESOURCE = 64 * 1024 * 1024;
const MAX_PREVIEW = 2 * 1024 * 1024;
const LOT_IMAGES = [0x10, 0x0f];
const LIFE_STAGES = { 1: 'Newborn', 2: 'Toddler', 4: 'Child', 8: 'Teen', 16: 'Young adult', 32: 'Adult', 64: 'Elder', 128: 'Infant' };
// Pack IDs are recorded requirements, not proof that a pack is installed.
const PACK_NAMES = {
  0: 'Base Game', 1: 'Luxury Party Stuff', 2: 'Outdoor Retreat', 3: 'Get to Work', 4: 'Perfect Patio Stuff', 5: 'Holiday Celebration',
  6: 'Spa Day', 7: 'Cool Kitchen Stuff', 8: 'Spooky Stuff', 9: 'Get Together', 10: 'Dine Out', 11: 'Movie Hangout Stuff',
  12: 'Romantic Garden Stuff', 13: 'Kids Room Stuff', 14: 'Backyard Stuff', 15: 'Vintage Glamour Stuff', 16: 'Bowling Night Stuff',
  17: 'Vampires', 18: 'Parenthood', 19: 'Jungle Adventure', 20: 'StrangerVille', 21: 'Realm of Magic', 22: 'Journey to Batuu',
  23: 'Dream Home Decorator', 24: 'City Living', 25: 'Cats & Dogs', 26: 'Seasons', 27: 'Get Famous', 28: 'Island Living',
  29: 'Discover University', 30: 'Eco Lifestyle', 31: 'Snowy Escape', 32: 'Fitness Stuff', 33: 'Toddler Stuff',
  34: 'Laundry Day Stuff', 35: 'My First Pet Stuff', 36: 'Moschino Stuff', 37: 'Tiny Living Stuff', 38: 'Nifty Knitting Stuff',
  39: 'Paranormal Stuff', 52: 'Cottage Living', 53: 'High School Years', 54: 'Growing Together', 55: 'Horse Ranch',
  56: 'For Rent', 57: 'Lovestruck', 58: 'Life & Death', 59: 'Businesses & Hobbies', 60: 'Enchanted by Nature',
  61: 'Adventure Awaits', 62: 'My Wedding Stories', 63: 'Werewolves', 76: 'First Fits', 87: 'Home Chef Hustle Stuff', 90: 'Crystal Creations Stuff',
  141: 'Royalty & Legacy'
};

async function digest(file) {
  const before = await fs.lstat(file);
  if (!before.isFile()) throw new Error('Only regular files can be inspected or backed up.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await fs.lstat(file);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('A save changed while it was being read. Waiting for it to settle.');
  }
  return hash.digest('hex');
}

function integer(buffer, start) {
  let value = 0n;
  for (let i = 0; i < 10 && start + i < buffer.length; i++) {
    const byte = buffer[start + i];
    if (i === 9 && byte > 1) break;
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return { value, next: start + i + 1 };
  }
  throw new Error('Invalid protobuf integer.');
}

// Preserve 64-bit IDs exactly; converting them to Number can join the wrong family.
function fields(buffer) {
  let offset = 0;
  const result = new Map();
  const read = () => { const item = integer(buffer, offset); offset = item.next; return item.value; };
  while (offset < buffer.length) {
    const rawKey = read();
    if (rawKey > 0xffffffffn) throw new Error('Invalid metadata field.');
    const key = Number(rawKey);
    const number = Math.floor(key / 8);
    const type = key & 7;
    if (!number || number > 536870911) throw new Error('Invalid metadata field.');
    let value;
    if (type === 0) value = read();
    else if (type === 1) { value = buffer.readBigUInt64LE(offset); offset += 8; }
    else if (type === 5) { value = BigInt(buffer.readUInt32LE(offset)); offset += 4; }
    else if (type === 2) {
      const length = Number(read());
      if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) throw new Error('Truncated metadata.');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else throw new Error('Unsupported metadata encoding.');
    if (offset > buffer.length) throw new Error('Truncated metadata.');
    if (value !== undefined) {
      if (!result.has(number)) result.set(number, []);
      result.get(number).push(value);
    }
  }
  return result;
}

function text(map, number) {
  const value = map.get(number)?.[0];
  if (!Buffer.isBuffer(value) || value.length > 2048) return '';
  return new TextDecoder('utf-8', { fatal: true }).decode(value).replace(/[\x00-\x1f]/g, ' ').trim();
}

const scalar = (map, number) => typeof map.get(number)?.[0] === 'bigint' ? map.get(number)[0].toString() : null;
const boolean = (map, number) => { const value = scalar(map, number); return value === '1' ? true : value === '0' ? false : null; };
const identifier = (map, number) => { const value = scalar(map, number); return value === '0' ? null : value; };
const messages = (map, number) => (map.get(number) || []).filter(Buffer.isBuffer);

function metadata(resource) {
  const root = fields(resource);
  const slot = fields(messages(root, 2)[0] || Buffer.alloc(0));
  const account = fields(messages(root, 3)[0] || Buffer.alloc(0));
  const neighborhoods = new Map(messages(root, 4).map(item => { const value = fields(item); return [identifier(value, 1), text(value, 3)]; }));
  const zoneRecords = messages(root, 7);
  const lots = zoneRecords.slice(0, 5000).map(item => {
    const value = fields(item);
    const count = number => { const recorded = Number(scalar(value, number) ?? NaN); return Number.isSafeInteger(recorded) ? recorded : null; };
    return { id: identifier(value, 1), name: text(value, 2), neighborhoodId: identifier(value, 10), neighborhood: neighborhoods.get(identifier(value, 10)) || '', worldId: scalar(value, 3), description: text(value, 14), bedrooms: count(16), bathrooms: count(17), householdId: identifier(value, 6) };
  });
  const zones = new Map(lots.filter(lot => lot.id).map(lot => [lot.id, lot]));
  const simRecords = messages(root, 6);
  const people = simRecords.slice(0, 10000).map(item => {
    const value = fields(item);
    const age = scalar(value, 8);
    return { id: identifier(value, 1), householdId: identifier(value, 4), name: [text(value, 5), text(value, 6)].filter(Boolean).join(' '), age, lifeStage: LIFE_STAGES[age] || null };
  });
  const householdRecords = messages(root, 5);
  const householdDetails = householdRecords.slice(0, 1000).map(item => {
    const value = fields(item);
    const id = identifier(value, 2);
    return { id, name: text(value, 3), description: text(value, 18), funds: scalar(value, 5), isPlayer: boolean(value, 31), isUnplayed: boolean(value, 14), homeLotId: identifier(value, 4), homeLot: zones.get(identifier(value, 4)) || null, lastPlayedSimId: identifier(value, 9), members: id ? people.filter(sim => sim.householdId === id) : [] };
  });
  for (const lot of lots) lot.homeHouseholdIds = householdDetails.filter(household => lot.id && household.homeLotId === lot.id && household.id).map(household => household.id);
  const content = fields(messages(slot, 17)[0] || Buffer.alloc(0));
  const packIds = [];
  for (const value of content.get(1) || []) {
    if (typeof value === 'bigint') packIds.push(value.toString());
    else for (let offset = 0; offset < value.length;) { const item = integer(value, offset); packIds.push(item.value.toString()); offset = item.next; }
  }
  return {
    metadataVersion: 4, saveName: text(slot, 9),
    households: householdDetails.map(household => household.name).filter(Boolean), sims: people.map(sim => sim.name).filter(Boolean),
    householdCount: householdRecords.length, simCount: simRecords.length, householdDetails, simDetails: people,
    activeHousehold: householdDetails.find(household => household.id && household.id === identifier(slot, 11)) || null,
    activeHouseholdId: identifier(slot, 11), lastPlayedLocationId: identifier(slot, 5),
    lastPlayedLocation: zones.get(identifier(slot, 5)) || null, lots, lotCount: zoneRecords.length,
    recordedTimestamp: scalar(slot, 10), gameVersion: text(account, 10), createdGameVersion: text(account, 17),
    requiredPacks: [...new Set(packIds)].map(id => ({ id, name: PACK_NAMES[id] || null })),
    metadataTruncated: householdRecords.length > 1000 || simRecords.length > 10000 || zoneRecords.length > 5000
  };
}

function packageResources(input) {
  const buffer = Buffer.from(input);
  if (buffer.length < 96 || buffer.toString('ascii', 0, 4) !== 'DBPF') throw new Error('Not a recognized DBPF save.');
  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== 1) throw new Error('Unsupported DBPF version.');
  const count = buffer.readUInt32LE(36);
  const position = Number(buffer.readBigUInt64LE(64)) || buffer.readUInt32LE(40);
  if (count > 100000 || !Number.isSafeInteger(position) || position < 96 || position + 4 > buffer.length) throw new Error('Invalid save index.');
  let cursor = position;
  const word = () => { const result = buffer.readUInt32LE(cursor); cursor += 4; return result; };
  const flags = word();
  if (flags & ~7) throw new Error('Unsupported save index flags.');
  const shared = [1, 2, 4].map(bit => flags & bit ? word() : undefined);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const type = shared[0] ?? word();
    if (shared[1] === undefined) word();
    const high = shared[2] ?? word();
    const low = word();
    const start = word();
    const packedSize = word();
    const size = packedSize & 0x7fffffff;
    const expected = word();
    let compression = 0;
    if (packedSize >>> 31) { compression = buffer.readUInt16LE(cursor); cursor += 2; }
    cursor += 2;
    if (cursor > buffer.length || start + size > buffer.length) throw new Error('Truncated save resource.');
    entries.push({ type, id: ((BigInt(high) << 32n) | BigInt(low)).toString(), start, size, expected, compression });
  }
  return { buffer, entries };
}

function resourceBytes(buffer, entry, limit = MAX_RESOURCE) {
  const { start, size, expected, compression } = entry;
  if (expected > limit || size > limit) throw new Error('Save resource exceeds the inspection limit.');
  let resource = buffer.subarray(start, start + size);
  if (compression === 0x5a42) resource = inflateSync(resource, { maxOutputLength: limit });
  else if (compression === 0xffff) {
    if (resource.length < 5 || resource.readUIntBE(2, 3) > limit) throw new Error('Invalid compressed save size.');
    resource = require('@s4tk/compression').decompressBuffer(resource, compression);
  } else if (compression !== 0) throw new Error('Unsupported save compression.');
  if (resource.length !== expected) throw new Error('Save resource size does not match its index.');
  return resource;
}

function parseMetadata(input) {
  const { buffer, entries } = packageResources(input);
  const save = entries.find(entry => entry.type === 13);
  if (!save) throw new Error('No supported save-game resource found.');
  const result = metadata(resourceBytes(buffer, save));
  const buildings = new Map();
  const previews = new Set(entries.filter(entry => LOT_IMAGES.includes(entry.type)).map(entry => entry.id));
  for (const entry of entries) if (entry.type === 6) {
    if (!buildings.has(entry.id)) buildings.set(entry.id, []);
    buildings.get(entry.id).push(entry);
  }
  for (const lot of result.lots) {
    lot.modification = 'unknown';
    lot.hasPreview = !!lot.id && previews.has(lot.id);
    const matches = buildings.get(lot.id) || [];
    if (matches.length !== 1) continue;
    try {
      const building = fields(resourceBytes(buffer, matches[0]));
      if (identifier(building, 1) !== lot.id) continue;
      const flag = scalar(building, 6);
      lot.modification = flag === '1' ? 'modified' : flag === '0' ? 'unmodified' : 'unknown';
    } catch { /* An unreadable building must not hide otherwise usable lot details. */ }
  }
  return result;
}

function previewImage(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error('Saved preview is not a supported JPEG.');
  let offset = 2;
  let width, height, alpha;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('Invalid saved preview marker.');
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) throw new Error('Truncated saved preview.');
    const segment = bytes.subarray(offset + 4, offset + 2 + length);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (segment.length < 6 || width !== undefined) throw new Error('Invalid preview dimensions.');
      height = segment.readUInt16BE(1); width = segment.readUInt16BE(3);
    }
    if (marker === 0xe0 && segment.toString('ascii', 0, 4) === 'ALFA') {
      if (segment.length < 8) throw new Error('Invalid preview transparency.');
      const size = segment.readUInt32BE(4);
      if (size > segment.length - 8 || size < 33) throw new Error('Truncated preview transparency.');
      alpha = segment.subarray(8, 8 + size);
    }
    offset += length + 2;
  }
  if (!width || !height || width > 2048 || height > 2048) throw new Error('Preview dimensions exceed the display limit.');
  if (alpha) {
    if (!alpha.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || alpha.readUInt32BE(8) !== 13 || alpha.toString('ascii', 12, 16) !== 'IHDR' || alpha.readUInt32BE(16) !== width || alpha.readUInt32BE(20) !== height || alpha[24] !== 8 || alpha[25] !== 0) throw new Error('Preview transparency does not match its image.');
    let cursor = 8, pixels = false, complete = false;
    while (cursor + 12 <= alpha.length) {
      const length = alpha.readUInt32BE(cursor); const type = alpha.toString('ascii', cursor + 4, cursor + 8);
      if (length > alpha.length - cursor - 12 || ['acTL', 'fcTL', 'fdAT'].includes(type)) throw new Error('Unsupported preview transparency.');
      if (type === 'IDAT') pixels = true;
      cursor += length + 12;
      if (type === 'IEND') { complete = length === 0 && cursor === alpha.length; break; }
    }
    if (!pixels || !complete) throw new Error('Truncated preview transparency.');
  }
  return { image: `data:image/jpeg;base64,${bytes.toString('base64')}`, mask: alpha ? `data:image/png;base64,${alpha.toString('base64')}` : null, width, height };
}

function parseLotPreview(input, lotId) {
  const { buffer, entries } = packageResources(input);
  let failure;
  for (const type of LOT_IMAGES) for (const entry of entries) {
    if (entry.type !== type || entry.id !== lotId) continue;
    try { return previewImage(resourceBytes(buffer, entry, MAX_PREVIEW)); }
    catch (error) { failure = error; }
  }
  if (failure) throw failure;
  return null;
}

// A worker deadline contains malformed legacy compression without freezing the UI.
function readMetadata(buffer, lotId) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { buffer, lotId }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Save inspection timed out.')); }, 3000);
    worker.once('message', result => { clearTimeout(timeout); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result.value); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error('Save inspection stopped.')); });
  });
}

async function readLotPreview(file, lotId, expectedHash) {
  if (typeof lotId !== 'string' || !/^[1-9]\d{0,19}$/.test(lotId) || BigInt(lotId) > 0xffffffffffffffffn) throw new Error('Select a valid lot first.');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || !stat.size || stat.size > 128 * 1024 * 1024) throw new Error('The stored save cannot be inspected for previews.');
  const buffer = await fs.readFile(file);
  if (createHash('sha256').update(buffer).digest('hex') !== expectedHash) throw new Error('The stored save changed. Its preview was not loaded.');
  return readMetadata(buffer, lotId);
}

async function inspectSave(file) {
  const stat = await fs.lstat(file);
  const name = path.basename(file);
  const match = SAVE_NAME.exec(name);
  const suffix = ARCHIVE_SAVE.exec(name);
  if (!stat.isFile() || !suffix) throw new Error('Select a regular .save or .save.verN file.');
  const hash = await digest(file);
  let metadata = {};
  let detail;
  try {
    if (!stat.size || stat.size > 128 * 1024 * 1024) throw new Error('Save is empty or exceeds the 128 MB inspection limit.');
    metadata = await readMetadata(await fs.readFile(file));
    detail = 'Metadata read; game compatibility is not verified.';
  } catch (error) { detail = `Metadata unknown: ${error.message}`; }
  if (hash !== await digest(file)) throw new Error('The save changed during inspection. Try scanning again.');
  return { file, name, slot: match ? match[1].toUpperCase() : null, recoveryVersion: suffix[1] === undefined ? null : Number(suffix[1]), size: stat.size, modified: stat.mtime.toISOString(), hash, ...metadata, detail };
}

if (!isMainThread) {
  try { parentPort.postMessage({ value: workerData.lotId ? parseLotPreview(workerData.buffer, workerData.lotId) : parseMetadata(workerData.buffer) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
module.exports = { SAVE_NAME, ARCHIVE_SAVE, digest, parseMetadata, inspectSave, readLotPreview };
