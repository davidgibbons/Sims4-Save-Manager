const byId = id => document.getElementById(id);
const search = window.librarySearch;
let current;
let update;
let working = false;
let activeTab = 'game';
let collection = 'backups';
const selected = { backups: null, imports: null };
const drafts = new Map();
const lotViews = new Map();
const householdViews = new Map();
let detailKey = null;
let showCandidates = false;
let lastAutomaticBackup;

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded';
const day = value => value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'an unknown date';
const size = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const locationsReady = () => !!current?.saveStatus.available && !!current?.config.backup_folder && !current?.backupWarning;
const importedTitle = entry => entry.annotation?.label || entry.saveName || `Save from ${day(entry.modified)}`;
function saveRollup(entry) {
  const sims = Number.isSafeInteger(entry.simCount) && entry.simCount >= 0 ? plural(entry.simCount, 'Sim') : 'Sims unknown';
  const packs = Array.isArray(entry.requiredPacks) ? plural(entry.requiredPacks.filter(pack => pack.id !== '0').length, 'pack') : 'Packs unknown';
  const households = entry.householdDetails || [];
  const recorded = households.filter(household => /^\d+$/.test(household.funds ?? ''));
  const total = recorded.reduce((sum, household) => sum + BigInt(household.funds), 0n);
  const complete = households.length === entry.householdCount && recorded.length === households.length && !entry.metadataTruncated;
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(total);
  const money = recorded.length ? `${complete ? '' : '≥ '}§${compact} total` : 'Funds unknown';
  return { text: `${sims} · ${packs} · ${money}`, detail: `${sims}: all Sims stored in the save, including premade and generated Sims. ${packs} recorded by the save; installed packs aren’t checked. ${recorded.length ? `${complete ? 'Total' : 'Known'} household funds: §${total.toLocaleString()}.${complete ? '' : ' Some household funds are unknown.'}` : 'Household funds haven’t been read.'}` };
}
function backupTitle(entry) {
  if (!entry.note) return 'Game backup';
  if (/^Automatic protective backup$/.test(entry.note)) return 'Automatic backup';
  if (/^(Return point before trying archive saves|My game before trying another save)$/.test(entry.note)) return 'Before trying another save';
  return entry.note.replace(/^Kept as my current game: /, 'Kept ');
}
function backupDate(name) {
  const match = /^(\d{4}-\d{2}-\d{2})[T_](\d{2})[-:](\d{2})[-:](\d{2})(?:-(\d{3})Z)?/.exec(name);
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] ? '.' + match[5] + 'Z' : ''}`;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const place = location => [location?.name, location?.neighborhood].filter(Boolean).join(' · ') || 'Unknown';
const member = sim => `${sim.name || 'Unnamed Sim'} · ${sim.lifeStage || 'Life stage unknown'}`;
function facts(parent, pairs) {
  const list = element('dl', undefined, 'facts');
  for (const [label, value] of pairs) {
    const pair = element('div'); pair.append(element('dt', label), element('dd', value)); list.append(pair);
  }
  parent.append(list);
}
function disclosure(title, id) {
  const details = element('details', undefined, 'save-disclosure'); details.id = id;
  details.append(element('summary', title));
  return details;
}
const lotLine = lot => [lot.name || 'Unnamed lot', lot.neighborhood, lot.bedrooms != null && plural(lot.bedrooms, 'bedroom'), lot.bathrooms != null && plural(lot.bathrooms, 'bathroom')].filter(Boolean).join(' · ');
function lotSummary(entry) {
  if (!Array.isArray(entry.lots)) return 'Lot details not read yet · Refresh to load';
  const neighborhoods = new Set(entry.lots.map(lot => lot.neighborhood).filter(Boolean)).size;
  return `${plural(entry.lotCount ?? entry.lots.length, 'Lot')}, ${plural(neighborhoods, 'Neighborhood')}`;
}
const modificationLabel = lot => lot.modification === 'modified' ? 'Modified' : lot.modification === 'unmodified' ? 'Unmodified' : 'Unknown';
async function previewCanvas(preview) {
  const load = async url => { const image = new Image(); image.src = url; await image.decode(); return image; };
  const image = await load(preview.image);
  if (image.naturalWidth !== preview.width || image.naturalHeight !== preview.height) throw new Error('Preview dimensions changed.');
  const canvas = document.createElement('canvas'); canvas.width = preview.width; canvas.height = preview.height;
  const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
  if (preview.mask) {
    const mask = await load(preview.mask);
    if (mask.naturalWidth !== preview.width || mask.naturalHeight !== preview.height) throw new Error('Preview transparency dimensions changed.');
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = canvas.width; maskCanvas.height = canvas.height;
    const maskContext = maskCanvas.getContext('2d'); maskContext.drawImage(mask, 0, 0);
    const alpha = maskContext.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let index = 0; index < alpha.length; index += 4) {
      pixels.data[index + 3] = alpha[index];
      if (alpha[index]) { const pixel = index / 4; const x = pixel % canvas.width; const y = Math.floor(pixel / canvas.width); left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    }
    if (right < left) return null;
    context.putImageData(pixels, 0, 0);
    const cropped = document.createElement('canvas'); cropped.width = right - left + 1; cropped.height = bottom - top + 1;
    cropped.getContext('2d').drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return cropped;
  }
  return canvas;
}
function lotPreview(record, entry, lot) {
  const figure = element('figure', undefined, 'lot-preview-image');
  const status = element('p', lot.hasPreview === undefined ? 'Refresh this save to check for a saved preview.' : lot.hasPreview ? 'Expand this lot to load its saved preview.' : 'No saved preview is stored for this lot.', 'hint');
  const retry = element('button', 'Try loading the preview again', 'text-button'); retry.hidden = true;
  figure.append(status, retry); record.append(figure);
  let requested = false;
  const load = async () => {
    if (!lot.hasPreview || requested) return;
    requested = true; retry.hidden = true; status.textContent = 'Loading saved preview…';
    try {
      const preview = await invoke(entry.kind === 'backup' ? window.saves.backupLotPreview(entry.id, lot.id) : window.saves.lotPreview(entry.id, lot.id));
      if (!preview) { status.textContent = 'No saved preview is stored for this lot.'; return; }
      const canvas = await previewCanvas(preview);
      if (!canvas) { status.textContent = 'No visible house preview was saved for this lot.'; return; }
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `Saved preview of ${lot.name || 'this lot'}`);
      if (!figure.isConnected) return;
      status.hidden = true; figure.append(canvas, element('figcaption', 'Saved by The Sims 4 · may not reflect the latest edits.', 'hint'));
    } catch (error) {
      requested = false;
      status.textContent = /Wait for the current operation/.test(error.message) ? 'A save operation is in progress. Try loading the preview again shortly.' : /ENOENT|EACCES|EPERM/.test(error.message) ? 'The stored save couldn’t be accessed. Reconnect its drive or check folder permissions, then try again.' : 'This saved preview couldn’t be displayed. Other save details are still available.';
      retry.hidden = false;
    }
  };
  record.addEventListener('toggle', () => { if (record.open) void load(); });
  retry.addEventListener('click', () => void load());
}
function lotsSection(panel, entry) {
  const preview = element('section', undefined, 'lot-preview'); panel.append(preview);
  const lots = entry.lots;
  if (!Array.isArray(lots)) { preview.append(element('p', 'Houses and lots haven’t been read for this save yet. Choose Refresh at the top of Saved games.', 'hint')); return; }
  const home = entry.activeHousehold?.homeLot;
  if (home) preview.append(element('p', `Active household’s home · ${lotLine(home)}`));
  const matched = new Set(entry.match?.lotIds || []);
  const matchedLots = lots.filter(lot => matched.has(lot.id));
  if (matchedLots.length) preview.append(element('p', `Matching lots: ${matchedLots.slice(0, 5).map(lot => lot.name || 'Unnamed lot').join(', ')}${matchedLots.length > 5 ? ` + ${matchedLots.length - 5} more` : ''}`, 'lot-match'));
  const view = lotViews.get(entry.hash) || { open: matchedLots.length > 0, filter: '', limit: 40, modifiedOnly: true };
  lotViews.set(entry.hash, view);
  const modifiedCount = entry.metadataVersion >= 3 ? `${plural(lots.filter(lot => lot.modification === 'modified').length, 'lot')} modified` : 'Modified count unknown';
  const neighborhoods = new Set(lots.map(lot => lot.neighborhood).filter(Boolean)).size;
  const browser = disclosure(`Browse all houses and lots · ${modifiedCount}, ${plural(entry.lotCount ?? lots.length, 'lot')}, ${plural(neighborhoods, 'neighborhood')}`, 'lot-browser'); browser.open = view.open;
  browser.addEventListener('toggle', () => { view.open = browser.open; });
  const filterLabel = element('label', 'Find a lot by name, neighborhood, or description'); filterLabel.htmlFor = 'lot-filter';
  const filter = element('input'); filter.id = 'lot-filter'; filter.type = 'search'; filter.value = view.filter;
  const modifiedLabel = element('label', undefined, 'check');
  const modified = element('input'); modified.id = 'modified-lots-only'; modified.type = 'checkbox'; modified.checked = !!view.modifiedOnly;
  modifiedLabel.append(modified, element('span', 'Modified lots only'));
  const status = element('p', '', 'hint'); status.setAttribute('role', 'status');
  const list = element('ul', undefined, 'lot-list');
  const more = element('button', 'Show more lots', 'text-button');
  const hiddenMatches = element('p', undefined, 'hint');
  const revealMatches = element('button', 'Show hidden matches', 'text-button'); revealMatches.id = 'show-hidden-lot-matches';
  const draw = () => {
    const shown = search.filterLots(entry, view.filter, !!view.modifiedOnly).sort((a, b) => Number(matched.has(b.id)) - Number(matched.has(a.id)));
    const hiddenCount = view.modifiedOnly ? search.filterLots(entry, view.filter).filter(lot => matched.has(lot.id) && lot.modification !== 'modified').length : 0;
    hiddenMatches.textContent = `${hiddenCount.toLocaleString()} search ${hiddenCount === 1 ? 'match' : 'matches'} hidden by “Modified lots only”.`;
    hiddenMatches.hidden = revealMatches.hidden = hiddenCount === 0;
    list.replaceChildren();
    for (const lot of shown.slice(0, view.limit)) {
      const record = element('details', undefined, matched.has(lot.id) ? 'lot-record match' : 'lot-record');
      record.append(element('summary', `${lotLine(lot)}${matched.has(lot.id) ? ' · Matches search' : ''}`));
      record.querySelector('summary').append(element('span', modificationLabel(lot), `lot-status ${lot.modification === 'modified' ? 'modified' : ''}`));
      lotPreview(record, entry, lot);
      facts(record, [['Building status', modificationLabel(lot)], ['Neighborhood', lot.neighborhood || 'Unknown'], ['Bedrooms recorded', lot.bedrooms ?? 'Not recorded'], ['Bathrooms recorded', lot.bathrooms ?? 'Not recorded'], ['Household', search.lotHouseholds(entry, lot).join(', ') || 'None recorded'], ['Lot ID', lot.id || 'Unknown']]);
      if (lot.description) record.append(element('p', lot.description, 'household-description'));
      const item = element('li'); item.append(record); list.append(item);
    }
    status.textContent = `Showing ${Math.min(view.limit, shown.length).toLocaleString()} of ${plural(entry.lotCount ?? lots.length, 'lot')}`;
    if ((view.modifiedOnly || view.filter.trim()) && shown.length > view.limit) status.textContent += ` · ${shown.length.toLocaleString()} match this filter`;
    if (!shown.length) status.textContent += view.modifiedOnly ? ' · No lots marked modified match this filter. Lots with unknown status are excluded.' : ' · No lots match this filter.';
    more.hidden = shown.length <= view.limit;
  };
  filter.addEventListener('input', () => { view.filter = filter.value; view.limit = 40; draw(); });
  modified.addEventListener('change', () => { view.modifiedOnly = modified.checked; view.limit = 40; draw(); });
  revealMatches.addEventListener('click', () => { modified.checked = view.modifiedOnly = false; view.limit = 40; browser.open = true; draw(); });
  more.addEventListener('click', () => { view.limit += 40; draw(); });
  browser.append(filterLabel, filter, modifiedLabel, hiddenMatches, revealMatches, element('p', 'Modified means the game marked a change from the lot template; it doesn’t identify who made it. Unknown does not mean stock. Room counts and images are saved records, not a fresh inspection of the house.', 'hint'), status, list, more);
  draw();
  preview.append(browser);
}
function importedDetails(panel, entry) {
  const active = entry.activeHousehold;
  const summary = element('div', undefined, 'household-preview');
  summary.append(element('h3', active?.name || 'Active household unknown'));
  if (active?.members?.length) summary.append(element('p', active.members.slice(0, 3).map(sim => sim.name || 'Unnamed Sim').join(', ') + (active.members.length > 3 ? ` + ${active.members.length - 3} more` : '')));
  if (active?.homeLot?.name) summary.append(element('p', `Home · ${place(active.homeLot)}`, 'hint'));
  if (!active) summary.append(element('p', 'Search for a familiar Sim or family name, or expand Households and Sims below.', 'hint'));
  panel.append(summary);
  lotsSection(panel, entry);

  const playerCount = entry.metadataVersion >= 4 ? plural(search.filterHouseholds(entry, true).length, 'Player household') : 'Player count unknown';
  const households = disclosure(`Households and Sims · ${playerCount}, ${(entry.householdCount ?? entry.householdDetails?.length ?? 0).toLocaleString()} total`, 'household-details');
  households.append(element('p', 'The active household is the family selected when the game was saved. Other households can include NPCs.', 'hint'));
  const playerLabel = element('label', undefined, 'check');
  const playerOnly = element('input'); playerOnly.id = 'player-households-only'; playerOnly.type = 'checkbox'; playerOnly.checked = householdViews.get(entry.hash) ?? true;
  playerLabel.append(playerOnly, element('span', 'Player households only'));
  const householdStatus = element('p', '', 'hint'); householdStatus.id = 'household-count-status'; householdStatus.setAttribute('role', 'status');
  const householdList = element('div');
  households.append(playerLabel, element('p', 'Uses the game’s player-household flag. This can include premade families you took over; it does not mean created from scratch.', 'hint'));
  if (entry.metadataVersion < 4) households.append(element('p', 'Choose Refresh above to read player-household flags for this save.', 'hint'));
  households.append(householdStatus, householdList);
  const drawHouseholds = () => {
    householdList.replaceChildren();
    const shown = search.filterHouseholds(entry, playerOnly.checked);
    householdStatus.textContent = `Showing ${shown.length.toLocaleString()} of ${plural(entry.householdCount ?? entry.householdDetails?.length ?? 0, 'household')}`;
    if (!shown.length) householdList.append(element('p', playerOnly.checked ? 'No households are marked as player households. Uncheck this filter to see other or unknown households.' : entry.households?.join(', ') || 'Household names unknown.', 'hint'));
    const ordered = shown.sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id));
    for (const household of ordered) {
      const details = element('details', undefined, 'household-record');
      details.open = !!active?.id && household.id === active.id;
      details.append(element('summary', `${household.name || 'Unnamed household'}${household.id && household.id === active?.id ? ' · Active household' : ''}`));
      const funds = /^\d+$/.test(household.funds ?? '') ? `§${BigInt(household.funds).toLocaleString()}` : 'Unknown';
      facts(details, [['Home', place(household.homeLot)], ['Household funds', funds], ['Household type', household.isPlayer === true ? 'Player household' : household.isPlayer === false ? 'Other household' : 'Unknown'], ['Play history recorded', household.isUnplayed === true ? 'Unplayed' : household.isUnplayed === false ? 'Played' : 'Unknown']]);
      if (household.description) details.append(element('p', household.description, 'household-description'));
      const people = element('ul', undefined, 'member-list');
      for (const sim of household.members || []) people.append(element('li', member(sim)));
      details.append(people);
      if (!household.members?.length) details.append(element('p', 'Members unknown.', 'hint'));
      householdList.append(details);
    }
    const allSims = element('details'); allSims.append(element('summary', playerOnly.checked ? 'Sims in shown households' : 'All Sims recorded in this save'));
    const sims = playerOnly.checked ? shown.flatMap(household => household.members || []) : entry.simDetails || [];
    if (sims.length) {
      const people = element('ul', undefined, 'member-list');
      for (const sim of sims) people.append(element('li', member(sim)));
      allSims.append(people);
    } else allSims.append(element('p', playerOnly.checked ? 'No Sim names available for these households.' : entry.sims?.join(', ') || 'Unknown'));
    householdList.append(allSims);
  };
  playerOnly.addEventListener('change', () => { householdViews.set(entry.hash, playerOnly.checked); drawHouseholds(); });
  drawHouseholds();
  if (entry.metadataTruncated) households.append(element('p', 'This unusually large save reached the detail limit. Some households or Sims are not shown.', 'hint'));
  panel.append(households);

  const save = disclosure('Save details and packs', 'recorded-save-details');
  facts(save, [
    ['Last-played location', place(entry.lastPlayedLocation)],
    ['Game version when saved', entry.gameVersion || 'Unknown'], ['Game version when created', entry.createdGameVersion || 'Unknown'],
    ['Internal save date', entry.recordedTimestamp ? 'Unknown · timestamp format not verified' : 'Unknown'],
    [entry.kind === 'backup' ? 'Save file modified' : 'Original file modified', date(entry.modified)],
    entry.kind === 'backup' ? ['Backup set', backupTitle(entry)] : ['Imported', date(entry.importedAt)],
    ['File size', size(entry.size)], ['Save copy', entry.recoveryVersion == null ? 'Main save' : 'Earlier recovery version'],
    ...(entry.kind === 'backup' ? [] : [['Tried before', entry.annotation.tried ? 'Yes' : 'Not yet']])
  ]);
  save.append(element('h3', 'Packs recorded by this save'));
  save.append(element('p', entry.requiredPacks?.length ? entry.requiredPacks.map(pack => pack.name || `Unrecognized pack (ID ${pack.id})`).join(', ') : 'No pack requirements were recorded or could be read.'));
  save.append(element('p', 'This list doesn’t check which packs are installed or identify missing mods. File dates can reflect copying.', 'hint'));
  const refresh = element('button', 'Refresh details', 'text-button'); refresh.id = 'refresh-save-details';
  refresh.addEventListener('click', () => run('Reading details from the stored copy…', async () => {
    const state = await invoke(entry.kind === 'backup' ? window.saves.refreshBackupDetails(entry.id) : window.saves.refreshSaveDetails(entry.id)); render(state);
    if (selected[collection] === entry.id) byId('recorded-save-details').open = true;
    return 'Save details refreshed. Your original file date, label, and notes were kept.';
  }));
  save.append(refresh); panel.append(save);
  if ((entry.metadataVersion || 0) < 2) panel.append(element('p', 'More details may be available. Choose Refresh above to read the details of your saved games.', 'hint'));
}

function activateTab(name, focus = false) {
  activeTab = name;
  for (const key of ['game', 'library', 'settings']) {
    byId(`tab-${key}`).setAttribute('aria-selected', String(key === name));
    byId(`tab-${key}`).tabIndex = key === name ? 0 : -1;
    byId(`panel-${key}`).hidden = key !== name;
  }
  if (focus) byId(`tab-${name}`).focus();
  if (name === 'library' && !working && current) void refresh(true);
}
for (const name of ['game', 'library', 'settings']) {
  byId(`tab-${name}`).addEventListener('click', () => activateTab(name));
  byId(`tab-${name}`).addEventListener('keydown', event => {
    const tabs = ['game', 'library', 'settings'];
    const position = tabs.indexOf(name);
    const next = event.key === 'ArrowRight' ? (position + 1) % 3 : event.key === 'ArrowLeft' ? (position + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
    if (next !== null) { event.preventDefault(); activateTab(tabs[next], true); }
  });
}

function buttons() {
  const blocked = working || update?.status === 'installing';
  document.querySelectorAll('button').forEach(button => { button.disabled = blocked; });
  document.querySelectorAll('[role="tab"], .save-row, .filters button').forEach(button => { button.disabled = false; });
  byId('note').disabled = blocked;
  byId('backup').disabled = blocked || !locationsReady() || !current?.saveStatus.count;
  byId('update-action').disabled = blocked || !update || ['disabled', 'checking', 'downloading'].includes(update.status);
  const trial = !!current?.archive.session;
  for (const id of ['choose-save', 'choose-backup', 'use-local']) byId(id).disabled = blocked || trial;
  document.querySelectorAll('[data-folder-change]').forEach(button => { button.disabled = blocked || trial || button.dataset.current === 'true'; });
  byId('return-saves').disabled = blocked || !trial;
  byId('keep-trial').disabled = blocked || !trial;
  byId('auto-backup').disabled = blocked || !locationsReady();
  byId('start-login').disabled = blocked || !current?.canStartAtLogin || !current?.config.auto_backup;
  byId('import-open').disabled = blocked || !current?.config.backup_folder || !!current?.backupWarning;
  byId('import-confirm').disabled = blocked || !document.querySelector('#import-preview input:checked:not([data-empty="true"])');
  document.querySelectorAll('#import-preview input, #import-all, #save-details input, #save-details textarea').forEach(input => { input.disabled = blocked || input.dataset.empty === 'true'; });
  const action = byId('detail-action');
  if (action) action.disabled = blocked || !locationsReady() || (collection === 'backups' && trial);
}

function renderUpdate(state) {
  if (update && state.revision < update.revision) return;
  update = state;
  byId('app-version').textContent = `Version ${state.currentVersion}`;
  byId('update-status').textContent = state.message;
  byId('update-progress').hidden = state.status !== 'downloading';
  byId('update-progress').value = state.percent || 0;
  byId('update-action').textContent = state.status === 'available' ? 'Download update' : state.status === 'downloaded' ? 'Restart and install' : 'Check for updates';
  buttons();
}
window.saves.onUpdate(renderUpdate);
window.saves.onProtection(state => {
  if (!current) return;
  current.protection = state;
  renderHome();
  renderProtection();
  if (state.lastSuccess && state.lastSuccess !== lastAutomaticBackup) { lastAutomaticBackup = state.lastSuccess; void refresh(true); }
});

function renderProtection() {
  const state = current.protection;
  let title = 'Starting automatic backups…';
  let copy = 'Checking your save and backup locations. Keep this app running.';
  if (!current.config.auto_backup) { title = 'Automatic backups are off'; copy = 'Turn them on to keep copies of your saved changes.'; }
  else if (state.status === 'settling') { title = state.lastSuccess ? 'Waiting for saved changes to finish' : 'Preparing your first automatic backup'; copy = 'Waiting for about 10–15 seconds without file changes before copying. No new backup has completed yet.'; }
  else if (state.status === 'backing-up') { title = 'Making an automatic backup…'; copy = 'Copying and verifying your saves. The completed copy will appear in Saved games → Backups.'; }
  else if (state.status === 'watching') { title = 'Automatic backups are working'; copy = 'Checking for saved changes every 5 seconds. Unchanged files do not create more copies while this app stays running.'; }
  else if (state.status === 'waiting') { title = 'Waiting for another save operation'; copy = 'Automatic backups will retry when the current operation finishes. Keep this app running.'; }
  else if (state.status === 'error') { title = 'Automatic backup needs attention'; copy = 'A new backup could not be completed. Review Backup status details below. Earlier backups are kept.'; }
  if (byId('automatic-status').textContent !== title) byId('automatic-status').textContent = title;
  if (byId('automatic-progress').textContent !== copy) byId('automatic-progress').textContent = copy;
  byId('protection-status').textContent = state.message;
  byId('last-success').textContent = state.lastSuccess ? `Last completed automatic backup: ${date(state.lastSuccess)}` : 'No automatic backup has completed yet.';
  byId('automatic-location').textContent = current.config.backup_folder ? `Copies saved to: ${current.config.backup_folder}` : 'Choose a Backup location above.';
}

function renderHome() {
  if (!current) return;
  const protection = current.protection;
  const connected = current.saveStatus.available;
  let title;
  let copy;
  let action;
  if (!connected) { title = 'Let’s connect your game'; copy = 'Choose the Save location The Sims 4 uses. We can help you find it.'; action = 'Set up locations'; }
  else if (current.backupWarning) { title = 'Check your Backup location'; copy = 'Choose an available folder outside OneDrive or iCloud to keep independent copies.'; action = 'Review locations'; }
  else if (!current.saveStatus.count) { title = 'Ready for your first saved game'; copy = 'Make a save in The Sims 4, or import an older one to pick up where you left off.'; action = 'Browse saved games'; }
  else if (!current.config.auto_backup) { title = 'Automatic backups are off'; copy = 'You can back up now, or let this app keep copies as your saved game changes.'; action = 'Turn on automatic backups'; }
  else if (protection.status === 'error') { title = 'Your backups need attention'; copy = 'Your older backups are still available. Review the backup status in Settings.'; action = 'Review backup settings'; }
  else if (protection.status === 'waiting') { title = 'Automatic backup is waiting'; copy = 'Another save operation is running. Automatic backups will retry when it finishes.'; action = 'View backup settings'; }
  else if (protection.status === 'settling' || protection.status === 'backing-up' || !protection.lastSuccess) { title = protection.status === 'backing-up' ? 'Making an automatic backup…' : protection.lastSuccess ? 'Waiting for saved changes to finish' : 'Preparing your first automatic backup'; copy = protection.status === 'backing-up' ? 'Copying and verifying your saves. Find the completed copy in Saved games → Backups.' : `${protection.lastSuccess ? 'A new' : 'The first'} copy starts after about 10–15 seconds without file changes. Keep this app running; closing its window is fine.`; action = 'View backup settings'; }
  else { title = 'Automatic backups are working'; copy = 'Automatic backups are working. Closing the window keeps them running; choosing Quit stops them.'; action = 'View saved games'; }
  byId('game-status-title').textContent = title;
  byId('game-status-copy').textContent = copy;
  byId('home-next').textContent = action;
  byId('game-last-backup').textContent = protection.lastSuccess ? `Last automatic backup · ${date(protection.lastSuccess)}` : `${plural(current.saveStatus.count || 0, 'save file')} found · ${plural(current.backups.length, 'backup')} available`;
  byId('manual-help').textContent = !locationsReady() ? 'Set up your locations in Settings before making a backup.' : !current.saveStatus.count ? 'A game save needs to exist before it can be backed up.' : 'Your current saves stay in place. The copy goes to your Backup location.';
  const attention = !connected || !!current.backupWarning || protection.status === 'error';
  byId('header-status').textContent = attention ? 'Setup or backup needs attention' : !current.config.auto_backup ? 'Automatic backups off' : protection.status === 'watching' ? 'Automatic backups working' : protection.status === 'backing-up' ? 'Making a backup…' : protection.status === 'waiting' ? 'Automatic backup waiting' : 'Automatic backup preparing';
  byId('header-status').classList.toggle('attention', attention);
}

function render(state, preserveDetail = false) {
  if (!current && !state.saveStatus.available && state.candidates.length) showCandidates = true;
  current = state;
  renderUpdate(state.updates);
  renderHome();
  const session = state.archive.session;
  byId('trial-banner').hidden = !session;
  byId('trial-title').textContent = session ? `You’re trying “${session.currentName || 'a different save'}”` : '';
  byId('save-folder').value = state.config.save_folder;
  byId('backup-folder').value = state.config.backup_folder;
  byId('backup-warning').textContent = state.backupWarning ? 'This location is unavailable or is in a cloud-sync folder. Choose another location to continue.' : '';
  byId('use-local').title = state.localBackupFolder;
  byId('save-location-status').textContent = state.saveStatus.available ? `${plural(state.saveStatus.count, 'save file')} found. ${session ? 'Finish this trial before changing locations.' : ''}` : 'This location is not connected. Use Find my saves or choose a folder.';
  byId('auto-backup').checked = !!state.config.auto_backup;
  byId('start-login').checked = !!state.config.start_at_login;
  byId('login-help').textContent = state.canStartAtLogin ? 'Optional: opens this app after you sign in, so backups can resume. Without it, open the app yourself. Your system may ask you to approve this login item.' : 'Start at sign-in is available in an installed build. In this local version, open the app yourself to start automatic backups.';
  renderProtection();

  byId('candidates').replaceChildren();
  state.candidates.forEach((candidate, index) => {
    if (!showCandidates) return;
    const item = element('li');
    const copy = element('div', `${plural(candidate.count, 'save file')}${candidate.latest ? ' · newest file ' + date(candidate.latest) : ''}${candidate.cloud ? ' · Cloud-synced folder' : ''}`);
    copy.append(element('p', candidate.folder, 'hint technical'));
    const use = element('button', candidate.folder === state.config.save_folder ? 'Current location' : 'Use this location'); use.dataset.folderChange = 'true'; use.dataset.current = String(candidate.folder === state.config.save_folder);
    use.addEventListener('click', () => run('Connecting your game…', async () => { const next = await invoke(window.saves.useCandidate(index)); showCandidates = false; render(next); return 'Save location connected.'; }));
    item.append(copy, use); byId('candidates').append(item);
  });
  renderLibrary(preserveDetail);
  buttons();
}

function libraryItems() {
  return collection === 'backups' ? (current.backupSaves || []).map(entry => ({ ...entry, title: entry.saveName || entry.name, when: backupDate(entry.backupName) })) : current.archive.imports.map(entry => ({ ...entry, title: importedTitle(entry), when: entry.modified }));
}
function renderLibrary(preserveDetail = false) {
  if (!current) return;
  byId('backup-count').textContent = current.backupSaves?.length ?? 0;
  byId('import-count').textContent = current.archive.imports.length;
  for (const key of ['backups', 'imports']) byId(`filter-${key}`).setAttribute('aria-pressed', String(key === collection));
  byId('library-context').textContent = collection === 'backups' ? 'Each tile is one save from a backup. Restoring replaces the whole backup set, including its other save files.' : 'Imported saves are copies kept by this app. Try one, then return to your game or keep it.';
  if (collection === 'backups' && current.warning) byId('library-context').textContent = 'Your backups couldn’t be read. Check the Backup location in Settings, then refresh.';
  const query = byId('library-search').value.trim();
  const scope = byId('library-search-scope').value;
  byId('search-scope').hidden = false;
  byId('library-search').placeholder = scope === 'lots' ? 'Search a house, lot, or neighborhood' : 'Search a family, Sim, note, or checksum';
  const items = libraryItems().map(entry => ({ ...entry, match: search.matchSave(entry, query, scope, date(entry.when)) })).filter(entry => entry.match);
  if (!items.some(entry => entry.id === selected[collection])) selected[collection] = items[0]?.id || null;
  byId('saved-list').replaceChildren();
  byId('library-empty').hidden = items.length > 0;
  byId('library-empty').textContent = query ? scope === 'lots' ? 'No houses or lots match your search. Choose Refresh to read houses and checksums from your saved games.' : 'No saved games match your search. Try a family name, a date, or a note.' : collection === 'backups' ? 'Your backups will appear here. Make your first one from My game.' : 'Bring in saves from another folder or drive with Import saves. Originals stay where they are.';
  if (collection === 'backups' && current.warning) byId('library-empty').textContent = 'Backups are unavailable until this location can be read.';
  const copies = search.duplicateCounts([...(current.backupSaves || []), ...current.archive.imports]);
  for (const entry of items) {
    const row = element('button', undefined, 'save-row');
    row.setAttribute('aria-current', String(entry.id === selected[collection]));
    row.append(element('strong', entry.title));
    row.append(element('span', entry.inspectable === false ? 'No game metadata available for this file' : lotSummary(entry)));
    if (entry.hash) {
      const rollup = saveRollup(entry);
      const summary = element('span', rollup.text, 'save-rollup'); summary.title = rollup.detail;
      row.append(summary, element('span', `${day(entry.modified)} · ${size(entry.size)}${entry.annotation?.tried ? ' · Tried' : ''}`));
    }
    if (entry.kind === 'backup') row.append(element('span', `${backupTitle(entry)} · ${date(entry.when)} · ${entry.name}`));
    if (entry.hash) {
      const checksum = element('span', `SHA-256 · ${entry.hash.slice(0, 12)}`, 'save-checksum');
      checksum.title = `SHA-256: ${entry.hash}`; checksum.setAttribute('aria-label', checksum.title);
      row.append(checksum);
      if (copies.get(entry.hash) > 1) row.append(element('span', `Identical save · ${copies.get(entry.hash)} copies`, 'save-match'));
    } else if (entry.inspectable) row.append(element('span', 'Houses and checksum not read yet · Refresh to load'));
    if (entry.match.hint) row.append(element('span', entry.match.hint, 'save-match'));
    row.addEventListener('click', () => { selected[collection] = entry.id; renderLibrary(); byId('save-details').focus({ preventScroll: true }); });
    const li = element('li'); li.append(row); byId('saved-list').append(li);
  }
  const entry = items.find(item => item.id === selected[collection]);
  if (!preserveDetail || detailKey !== `${collection}:${entry?.id}`) renderDetail(entry);
  buttons();
}

function renderDetail(entry) {
  const kind = collection;
  const panel = byId('save-details'); panel.replaceChildren(); panel.tabIndex = -1;
  detailKey = `${kind}:${entry?.id}`;
  if (!entry) {
    const empty = element('div', undefined, 'empty-state');
    empty.append(element('span', '◇'), element('h2', 'A chapter worth finding'), element('p', 'Choose a saved game to see its details.'));
    panel.append(empty); return;
  }
  panel.append(element('p', kind === 'backups' ? 'GAME BACKUP' : 'IMPORTED SAVE', 'eyebrow'), element('h2', entry.title), element('p', kind === 'backups' ? `Backed up ${date(entry.when)}` : `Original file modified ${date(entry.modified)}`, 'detail-meta'));
  if (kind === 'imports' || entry.inspectable) importedDetails(panel, entry);
  if (kind === 'imports') {
    const draft = drafts.get(entry.hash) || { label: entry.annotation.label || '', notes: entry.annotation.notes || '', tried: !!entry.annotation.tried };
    const label = element('label', 'Your name for this save'); label.htmlFor = 'detail-label';
    const nameInput = element('input'); nameInput.id = 'detail-label'; nameInput.maxLength = 200; nameInput.value = draft.label; nameInput.placeholder = 'For example, Wedding save';
    const notesLabel = element('label', 'Notes'); notesLabel.htmlFor = 'detail-notes';
    const notes = element('textarea'); notes.id = 'detail-notes'; notes.maxLength = 10000; notes.rows = 3; notes.value = draft.notes; notes.placeholder = 'What did you find when you opened it?';
    const triedLabel = element('label', undefined, 'check');
    const tried = element('input'); tried.type = 'checkbox'; tried.checked = draft.tried; triedLabel.append(tried, element('span', 'I’ve tried this save'));
    const dirty = element('p', drafts.has(entry.hash) ? 'Unsaved notes' : '', 'hint'); dirty.id = 'notes-state';
    const remember = () => { drafts.set(entry.hash, { label: nameInput.value, notes: notes.value, tried: tried.checked }); dirty.textContent = 'Unsaved notes · switching tabs keeps your draft'; };
    nameInput.addEventListener('input', remember); notes.addEventListener('input', remember); tried.addEventListener('change', remember);
    const save = element('button', 'Save notes', 'save-notes');
    save.addEventListener('click', () => run('Saving your notes…', async () => {
      const annotation = drafts.get(entry.hash) || draft;
      const state = await invoke(window.saves.annotateSave(entry.id, annotation)); drafts.delete(entry.hash); render(state); return 'Your notes are saved.';
    }));
    const editor = element('details'); editor.id = 'edit-notes'; editor.open = drafts.has(entry.hash);
    editor.append(element('summary', 'Edit label and notes'), label, nameInput, notesLabel, notes, triedLabel, dirty, save);
    if (entry.annotation.notes) panel.append(element('p', entry.annotation.notes, 'saved-note'));
    panel.append(editor);
  } else {
    panel.append(element('p', `This save belongs to ${backupTitle(entry)} (${date(entry.when)}). Restoring replaces all ${plural(entry.count, 'file')} in that backup, not just this save. Your current game is copied to backups before this set is restored.`));
  }
  const action = element('button', kind === 'backups' ? 'Restore entire backup' : 'Try this save', 'primary detail-action'); action.id = 'detail-action';
  action.addEventListener('click', () => run(kind === 'backups' ? 'Keeping your current game and restoring the backup…' : 'Keeping your current game and preparing this save…', async () => {
    const result = await invoke(kind === 'backups' ? window.saves.restore(entry.backupName) : window.saves.trySave(entry.id));
    if (result.canceled) return 'No save files were changed.';
    if (kind === 'imports' && drafts.has(entry.hash)) drafts.set(entry.hash, { ...drafts.get(entry.hash), tried: true });
    render(result);
    return kind === 'backups' ? 'Backup restored. Open The Sims 4 to continue playing.' : 'Ready to try. Open The Sims 4 and choose Load Game. Close the game before returning or keeping this save.';
  }));
  const actionArea = element('div', undefined, 'detail-action-area');
  actionArea.append(action, element('p', !locationsReady() ? 'Connect your Save location and Backup location in Settings before switching games.' : kind === 'backups' && current.archive.session ? 'Return to your game or choose Keep this save before restoring another backup.' : 'Close The Sims 4 before switching saved games.', 'hint'));
  panel.insertBefore(actionArea, panel.children[3] || null);
  const details = element('details'); details.append(element('summary', 'Technical details'));
  details.append(element('p', kind === 'backups' ? `Backup folder: ${entry.backupName}\nSave file: ${entry.name}\nSHA-256: ${entry.hash || "Not read yet"}` : `Original file: ${entry.originalFile || entry.file}\nStored copy: ${entry.file}\n${entry.detail}\nFile dates can reflect copying. Names can include NPCs.\nHouseholds recorded: ${(entry.households || []).join(', ') || 'Unknown'}\nSims recorded: ${(entry.sims || []).join(', ') || 'Unknown'}\nSlot: ${entry.slot || 'Unknown'}\nRecovery version: ${entry.recoveryVersion ?? 'Main save'}\nSHA-256: ${entry.hash}`, 'technical'));
  if (kind === 'imports') details.append(element('pre', JSON.stringify({ recordedTimestamp: entry.recordedTimestamp ?? null, activeHouseholdId: entry.activeHouseholdId ?? null, lastPlayedLocationId: entry.lastPlayedLocationId ?? null, lastPlayedLocation: entry.lastPlayedLocation ?? null, requiredPacks: entry.requiredPacks ?? null, householdDetails: entry.householdDetails ?? null, simDetails: entry.simDetails ?? null }, null, 2), 'technical'));
  panel.append(details);
}

async function invoke(promise) {
  const response = await promise;
  if (response.error) throw new Error(response.error);
  return response.value;
}
function readableError(message) {
  if (/rollback failed/i.test(message)) return 'The save switch needs help. Keep the recovery folder listed in Technical details before trying another switch.';
  if (/close the sims|close the game/i.test(message)) return 'Close The Sims 4, then try again.';
  if (/current operation|Wait for/i.test(message)) return 'A backup or save change is in progress. Please try again in a moment.';
  if (/ENOSPC|disk full/i.test(message)) return 'Your backup drive is full. Free up space or choose another Backup location in Settings.';
  if (/ENOENT|no longer|not found/i.test(message)) return 'A folder or file is no longer available. Reconnect its drive or check Settings, then try again.';
  if (/EACCES|EPERM/i.test(message)) return 'This location could not be accessed. Check folder permissions or choose another location in Settings.';
  if (/outside OneDrive|cloud/i.test(message)) return 'Choose a Backup location outside OneDrive or iCloud in Settings.';
  if (/changed.*scann|changed.*import|changed after|changed since/i.test(message)) return 'The source files changed. Choose Import saves again to scan their current versions.';
  if (/Return|trial|location|Select|Choose|Download|empty/i.test(message) && message.length < 240) return message;
  return 'That action couldn’t finish. Your existing backup copies have been kept. Review the details, then try again.';
}
function feedback(message, error = null) {
  byId('feedback').hidden = false;
  byId('feedback').classList.toggle('error', !!error);
  byId('status').textContent = message;
  byId('error-details').hidden = !error;
  byId('error-text').textContent = error?.message || '';
}
async function run(message, action) {
  if (working) return;
  working = true; buttons(); feedback(message); byId('busy-progress').hidden = false;
  try { const result = await action(); if (result) feedback(result); }
  catch (error) {
    const message = readableError(error.message); feedback(message, error);
    if (byId('import-dialog').open) byId('import-error').textContent = message;
  } finally { working = false; byId('busy-progress').hidden = true; buttons(); }
}
async function refresh(quiet = false, onlyMissing = false) {
  if (quiet) {
    try { render(await invoke(window.saves.state()), true);
      if (!working && activeTab === 'library' && collection === 'backups' && current.backupSaves?.some(entry => entry.inspectable && !entry.hash)) void refresh(false, true);
    } catch { /* The visible action reports its own errors. */ }
  } else {
    const readBackups = collection === 'backups';
    await run('Refreshing saved games…', async () => {
      let state = await invoke(window.saves.state());
      const entries = readBackups ? state.backupSaves.filter(entry => entry.inspectable && (!onlyMissing || !entry.hash)) : state.archive.imports;
      const failures = [];
      for (const [index, entry] of entries.entries()) {
        feedback(`Refreshing save details ${index + 1} of ${entries.length}…`);
        try { state = await invoke(readBackups ? window.saves.refreshBackupDetails(entry.id) : window.saves.refreshSaveDetails(entry.id)); }
        catch (error) { failures.push(`${importedTitle(entry)}: ${error.message}`); }
      }
      render(state);
      if (failures.length) {
        feedback(`Refreshed ${plural(entries.length - failures.length, 'save')}. Details for ${plural(failures.length, 'save')} couldn’t be refreshed. Reconnect the drive or check the files, then refresh again.`, new Error(failures.join('\n')));
      } else return entries.length ? `Details refreshed for ${plural(entries.length, 'save')}.` : 'Saved games are up to date.';
    });
  }
}

for (const key of ['backups', 'imports']) byId(`filter-${key}`).addEventListener('click', () => { collection = key; renderLibrary(); if (key === 'backups' && !working) void refresh(false, true); });
byId('library-search').addEventListener('input', () => renderLibrary());
byId('library-search-scope').addEventListener('change', () => renderLibrary());
byId('browse-games').addEventListener('click', () => activateTab('library'));
byId('home-next').addEventListener('click', () => {
  if (!locationsReady()) activateTab('settings');
  else if (!current.saveStatus.count || current.config.auto_backup && current.protection.status === 'watching') activateTab('library');
  else if (!current.config.auto_backup) void setProtection(true);
  else activateTab('settings');
});
byId('backup').addEventListener('click', () => run('Making a copy of your current game…', async () => {
  const state = await invoke(window.saves.backup(byId('note').value)); byId('note').value = ''; render(state); return 'Backup complete. Find it in Saved games → Backups.';
}));
byId('refresh').addEventListener('click', () => refresh());
for (const [id, kind] of [['choose-save', 'save_folder'], ['choose-backup', 'backup_folder']]) byId(id).addEventListener('click', () => run('Choosing a location…', async () => { const state = await invoke(window.saves.chooseFolder(kind)); if (kind === 'save_folder') showCandidates = false; render(state); return 'Location settings updated.'; }));
byId('find-saves').addEventListener('click', () => run('Looking for The Sims 4 saves…', async () => {
  const state = await invoke(window.saves.findSaves()); showCandidates = true; render(state); return state.candidates.length ? 'Choose the detected location used by your game.' : 'No standard location was found. Choose the Save location manually.';
}));
byId('use-local').addEventListener('click', () => run('Setting the recommended Backup location…', async () => { render(await invoke(window.saves.useLocalBackups())); return 'Backup location set outside the standard cloud-sync folders.'; }));
async function setProtection(enabled = byId('auto-backup').checked) {
  await run('Updating automatic backup settings…', async () => {
    try { render(await invoke(window.saves.protectionSettings({ enabled, startAtLogin: byId('start-login').checked }))); }
    catch (error) { render(current, true); throw error; }
    return enabled ? 'Automatic backups enabled. Check the visible status for progress and the last completed copy.' : 'Automatic backups are off. Your existing copies are still available.';
  });
}
byId('view-auto-backups').addEventListener('click', () => { collection = 'backups'; byId('library-search').value = ''; byId('library-search-scope').value = 'people'; activateTab('library'); });
byId('auto-backup').addEventListener('change', () => setProtection());
byId('start-login').addEventListener('change', () => setProtection());
byId('return-saves').addEventListener('click', () => run('Returning to your previous game…', async () => {
  const state = await invoke(window.saves.returnSaves()); if (state.canceled) return 'Your trial is still open.';
  render(state); return 'You’re back to your previous game. The trial game was also kept in backups.';
}));
byId('keep-trial').addEventListener('click', () => run('Backing up and keeping this game…', async () => {
  const state = await invoke(window.saves.keepTrial()); if (state.canceled) return 'Your trial is still open.';
  render(state); return 'This is now your current game. Your previous game remains in Saved games → Backups.';
}));
byId('update-action').addEventListener('click', () => run('Checking app update status…', async () => {
  const action = update.status === 'available' ? 'download' : update.status === 'downloaded' ? 'install' : 'check'; renderUpdate(await invoke(window.saves.updateAction(action))); return 'Update status is shown in Settings.';
}));

function updateImportCount() {
  const count = document.querySelectorAll('#import-preview input:checked:not([data-empty="true"])').length;
  byId('import-confirm').textContent = count ? `Import selected (${count})` : 'Import selected';
  const boxes = [...document.querySelectorAll('#import-preview input:not([data-empty="true"])')];
  byId('import-all').checked = boxes.length > 0 && boxes.every(box => box.checked);
  byId('import-all').indeterminate = boxes.some(box => box.checked) && !byId('import-all').checked;
  buttons();
}
byId('import-open').addEventListener('click', () => run('Reading saves from the selected folder…', async () => {
  const chosen = await invoke(window.saves.chooseFolder('archive_folder')); render(chosen, true);
  if (chosen.selectionCanceled) return 'Import canceled.';
  const state = await invoke(window.saves.scanArchive()); render(state, true);
  const entries = state.archive.entries;
  byId('import-source').textContent = state.config.archive_folder;
  byId('import-summary').textContent = `${plural(entries.length, 'file')} found · ${plural(new Set(entries.map(entry => entry.hash)).size, 'different save')}`;
  byId('import-warnings').textContent = state.archive.warnings.join('\n');
  byId('import-error').textContent = '';
  byId('import-preview').replaceChildren();
  for (const entry of entries) {
    const row = element('li'); const label = element('label'); const box = element('input'); box.type = 'checkbox'; box.dataset.id = entry.id;
    box.dataset.empty = String(!entry.size); box.disabled = !entry.size;
    const exists = state.archive.imports.some(item => item.hash === entry.hash);
    box.checked = entry.size > 0 && !exists;
    const copy = element('span', importedTitle(entry));
    copy.append(element('small', `${day(entry.modified)} · ${size(entry.size)}${exists ? ' · Already in your library' : entry.duplicates ? ' · Identical copies found' : ''}${!entry.size ? ' · Empty file' : ''}`));
    copy.append(element('small', entry.relative));
    label.append(box, copy); row.append(label); byId('import-preview').append(row);
    box.addEventListener('change', updateImportCount);
  }
  updateImportCount(); byId('import-dialog').showModal(); return 'Choose the files you want to import. Originals stay unchanged.';
}));
byId('import-all').addEventListener('change', () => {
  document.querySelectorAll('#import-preview input:not([data-empty="true"])').forEach(box => { box.checked = byId('import-all').checked; }); updateImportCount();
});
for (const id of ['import-close', 'import-cancel']) byId(id).addEventListener('click', () => byId('import-dialog').close());
byId('import-dialog').addEventListener('cancel', event => { if (working) event.preventDefault(); });
byId('import-confirm').addEventListener('click', () => run('Copying and verifying the selected saves…', async () => {
  const ids = [...document.querySelectorAll('#import-preview input:checked')].map(box => box.dataset.id);
  const hashes = new Set(current.archive.entries.filter(entry => ids.includes(entry.id)).map(entry => entry.hash));
  const state = await invoke(window.saves.importSaves(ids));
  collection = 'imports'; selected.imports = state.archive.imports.find(entry => hashes.has(entry.hash))?.id || null;
  render(state); byId('import-dialog').close(); activateTab('library');
  return `${plural(state.importResult.imported, 'save')} imported. ${state.importResult.skipped ? state.importResult.skipped + ' duplicate copies skipped. ' : ''}The originals were left unchanged.`;
}));

void run('Connecting to your game…', async () => { render(await invoke(window.saves.state())); byId('feedback').hidden = true; });
