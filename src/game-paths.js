const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SAVE_NAME } = require('./save-inspector');
const run = promisify(execFile);

function contains(parent, child, platform = process.platform) {
  if (platform === 'win32') { parent = parent.toLowerCase(); child = child.toLowerCase(); }
  const api = platform === 'win32' ? path.win32 : path;
  const relative = api.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

async function cloudRoots(home, env = process.env) {
  const roots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial, path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')].filter(Boolean);
  for (const base of [home, path.join(home, 'Library/CloudStorage')]) {
    try {
      for (const entry of await fs.readdir(base, { withFileTypes: true })) {
        if (/^(OneDrive|Dropbox|GoogleDrive|iCloudDrive)(\b|[- ])/i.test(entry.name)) roots.push(path.join(base, entry.name));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return [...new Set(roots)];
}

async function assertLocalFolder(folder, roots) {
  const real = await fs.realpath(folder);
  for (const root of roots) {
    let resolved = root;
    try { resolved = await fs.realpath(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (contains(resolved, real)) throw new Error('Protective backups must be outside OneDrive, iCloud, Dropbox, and Google Drive folders. Choose the suggested local backup folder.');
  }
  return real;
}

async function discoverSaves({ home, documents, env = process.env }) {
  const roots = await Promise.all((await cloudRoots(home, env)).map(async root => {
    try { return await fs.realpath(root); } catch (error) { if (error.code === 'ENOENT') return root; throw error; }
  }));
  const bases = [documents, path.join(home, 'Documents'), ...roots.map(root => path.join(root, 'Documents'))];
  const candidates = [];
  const seen = new Set();
  for (const base of bases) {
    try {
      const folder = await fs.realpath(path.join(base, 'Electronic Arts', 'The Sims 4', 'saves'));
      if (seen.has(folder)) continue;
      seen.add(folder);
      const entries = await fs.readdir(folder, { withFileTypes: true });
      const saves = entries.filter(entry => entry.isFile() && SAVE_NAME.test(entry.name));
      const stats = await Promise.all(saves.map(entry => fs.stat(path.join(folder, entry.name))));
      candidates.push({ folder, count: saves.length, latest: stats.length ? new Date(Math.max(...stats.map(stat => stat.mtimeMs))).toISOString() : null, cloud: roots.some(root => contains(root, folder)) });
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
  }
  return candidates.sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
}

function gameIsRunning(output) {
  return /(?:^|["/\\\s])(?:TS4(?:_DX9)?(?:_x64)?\.exe|The Sims 4(?:\.app)?)(?=["\r\n]|$)/im.test(output);
}

async function assertGameClosed() {
  let output;
  try {
    output = process.platform === 'win32'
      ? (await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout
      : (await run('/bin/ps', ['-axo', 'comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch { throw new Error('Could not check whether The Sims 4 is running. Close the game and retry; no save files were changed.'); }
  if (gameIsRunning(output)) {
    throw new Error('Close The Sims 4 before trying or restoring a save.');
  }
}

module.exports = { contains, cloudRoots, assertLocalFolder, discoverSaves, assertGameClosed, gameIsRunning };
