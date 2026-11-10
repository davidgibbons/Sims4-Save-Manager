const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { createUpdates } = require('../src/updates');

function setup({ enabled = true, busy = false } = {}) {
  const updater = new EventEmitter();
  const calls = { check: 0, download: 0, install: 0 };
  updater.checkForUpdates = async () => {
    calls.check++;
    updater.emit('update-available', { version: '3.1.0' });
    return {};
  };
  updater.downloadUpdate = async () => {
    calls.download++;
    updater.emit('download-progress', { percent: 42 });
    updater.emit('update-downloaded', { version: '3.1.0' });
    return ['update'];
  };
  updater.quitAndInstall = () => { calls.install++; };
  const changes = [];
  const service = createUpdates({ updater, version: '3.0.0', enabled, isBusy: () => busy, onChange: state => changes.push(state) });
  return { updater, service, changes, calls };
}

test('checking does not download; download and installation each need an explicit action', async () => {
  const { updater, service, calls, changes } = setup();
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(service.check().status, 'checking');
  service.check();
  await tick();
  assert.deepEqual(calls, { check: 1, download: 0, install: 0 });
  assert.equal(service.snapshot().status, 'available');
  assert.equal(service.download().status, 'downloading');
  assert.throws(() => service.download(), /available update/);
  service.check();
  await tick();
  assert.equal(service.snapshot().status, 'downloaded');
  assert.ok(changes.some(state => state.percent === 42));
  assert.ok(changes.every((state, index) => state.revision === index + 1));
  assert.equal(calls.install, 0);
  service.check();
  assert.equal(service.install().status, 'installing');
  assert.equal(calls.install, 1);
  assert.throws(() => service.install(), /Download an update/);
  service.check();
  assert.equal(calls.check, 1);
});

test('installing is refused during a save operation and leaves the update ready', async () => {
  const { service, calls } = setup({ busy: true });
  service.check();
  await tick();
  service.download();
  await tick();
  assert.throws(() => service.install(), /backup or restore/);
  assert.equal(service.snapshot().status, 'downloaded');
  assert.equal(calls.install, 0);
});

test('development builds never contact the update provider or install updates', () => {
  const { service, calls } = setup({ enabled: false });
  assert.equal(service.check().status, 'disabled');
  assert.throws(() => service.download(), /available update/);
  assert.throws(() => service.install(), /Download an update/);
  assert.deepEqual(calls, { check: 0, download: 0, install: 0 });
});

test('failed checks and no published releases are recoverable', async () => {
  const { updater, service } = setup();
  updater.checkForUpdates = async () => { throw Object.assign(new Error('No release'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }); };
  service.check();
  await tick();
  assert.match(service.snapshot().message, /No update release/);
  updater.checkForUpdates = async () => { throw Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_XML_MISSED_ELEMENT' }); };
  service.check();
  await tick();
  assert.match(service.snapshot().message, /No update release/);
  updater.checkForUpdates = async () => { updater.emit('update-not-available'); return {}; };
  service.check();
  await tick();
  assert.equal(service.snapshot().status, 'current');
});

test('download, signature, and install failures never trigger an unattended restart', async () => {
  const { updater, service, calls } = setup();
  assert.throws(() => service.install(), /Download an update/);
  service.check();
  await tick();
  updater.downloadUpdate = async () => { throw new Error('Checksum mismatch'); };
  service.download();
  await tick();
  assert.match(service.snapshot().message, /Checksum mismatch/);
  assert.equal(calls.install, 0);
  service.check();
  await tick();
  updater.emit('update-downloaded', { version: '3.1.0' });
  updater.quitAndInstall = () => { throw new Error('Cannot start installer'); };
  assert.equal(service.install().status, 'error');
  assert.match(service.snapshot().message, /Cannot start installer/);
  updater.emit('error', new Error('Invalid signature'));
  assert.equal(service.snapshot().status, 'error');
  assert.match(service.snapshot().message, /Invalid signature/);
});

test('an unsupported build does not get stuck checking', async () => {
  const { updater, service } = setup();
  updater.checkForUpdates = async () => null;
  service.check();
  await tick();
  assert.equal(service.snapshot().status, 'error');
});
