function createUpdates({ updater, version, enabled, isBusy, onChange }) {
  let state = {
    status: enabled ? 'idle' : 'disabled',
    revision: 0,
    currentVersion: version,
    message: enabled ? 'Updates are checked when you open the app.' : 'Updates are available in an installed release.'
  };
  const snapshot = () => ({ ...state });
  function change(status, message, details = {}) {
    state = { status, revision: state.revision + 1, currentVersion: version, message, ...details };
    onChange(snapshot());
  }
  function fail(error) {
    const unpublished = error.message === 'No published versions on GitHub' ||
      ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'].includes(error.code);
    change('error', unpublished ? 'No update release is available yet. Try again later.' : `Update failed: ${error.message}`);
  }

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on('error', fail);
  updater.on('update-available', info => change('available', `Version ${info.version} is available.`, { version: info.version }));
  updater.on('update-not-available', () => change('current', 'You have the latest version.'));
  updater.on('download-progress', progress => {
    change('downloading', `Downloading update: ${Math.round(progress.percent)}%`, { percent: progress.percent });
  });
  updater.on('update-downloaded', info => change('downloaded', `Version ${info.version} is ready. Restart to install it.`, { version: info.version }));

  return {
    snapshot,
    check() {
      if (!enabled || ['checking', 'downloading', 'downloaded', 'installing'].includes(state.status)) return snapshot();
      change('checking', 'Checking for updates…');
      Promise.resolve().then(() => updater.checkForUpdates()).then(result => {
        if (result === null && state.status === 'checking') change('error', 'Updates are unavailable for this build.');
      }).catch(fail);
      return snapshot();
    },
    download() {
      if (!enabled || state.status !== 'available') throw new Error('Check for an available update first.');
      change('downloading', 'Downloading update…', { percent: 0 });
      Promise.resolve().then(() => updater.downloadUpdate()).catch(fail);
      return snapshot();
    },
    install() {
      if (!enabled || state.status !== 'downloaded') throw new Error('Download an update before installing.');
      if (isBusy()) throw new Error('Wait for the backup or restore to finish before installing an update.');
      change('installing', 'Restarting to install the update…');
      try { updater.quitAndInstall(false, true); }
      catch (error) { fail(error); }
      return snapshot();
    }
  };
}

module.exports = { createUpdates };
