(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.librarySearch = api;
})(this, function () {
  const SCOPES = { people: 'Families, Sims & notes', lots: 'Houses & lots' };
  const normalize = value => String(value || '').toLocaleLowerCase().trim();
  const unique = values => [...new Set(values.filter(Boolean))];

  function householdNames(entry) {
    return unique(entry.householdDetails?.length ? entry.householdDetails.map(household => household.name) : entry.households || []);
  }
  function simNames(entry) {
    return unique(entry.simDetails?.length ? entry.simDetails.map(sim => sim.name) : entry.sims || []);
  }
  function lotHouseholds(entry, lot) {
    const ids = unique([lot.householdId, ...(lot.homeHouseholdIds || [])]);
    return unique(ids.map(id => (entry.householdDetails || []).find(household => household.id === id)?.name));
  }
  function lotMatches(lot, query) {
    return [lot.name, lot.neighborhood, lot.description].some(value => normalize(value).includes(query));
  }
  function filterLots(entry, query, modifiedOnly = false) {
    query = normalize(query);
    const lots = entry.lots || [];
    return lots.filter(lot => (!modifiedOnly || lot.modification === 'modified') && (!query || lotMatches(lot, query)));
  }
  function filterHouseholds(entry, playerOnly = false) {
    return (entry.householdDetails || []).filter(household => !playerOnly || household.isPlayer === true);
  }

  function fieldsFor(entry, dateText) {
    if (entry.kind === 'backup') return [['Note', [entry.title, entry.note]], ['Date', [dateText]]];
    return [['Label', [entry.annotation?.label]], ['Save', [entry.saveName]], ['Family', householdNames(entry)], ['Sim', simNames(entry)], ['Note', [entry.annotation?.notes]], ['Date', [dateText]]];
  }

  function summarize(kind, values) {
    const shown = values.slice(0, 2).map(value => value.length > 60 ? `${value.slice(0, 57)}…` : value);
    return `${kind}: ${shown.join(', ')}${values.length > 2 ? ` +${values.length - 2}` : ''}`;
  }

  function matchSave(entry, query, scope = 'people', dateText = '') {
    query = normalize(query);
    if (!query) return { hint: '', lotIds: [] };
    if (scope === 'lots' && entry.kind !== 'backup') {
      const lots = filterLots(entry, query);
      return lots.length ? { hint: `Matches ${summarize('Lot', unique(lots.map(lot => lot.name || 'Unnamed lot')))}`, lotIds: lots.map(lot => lot.id) } : null;
    }
    const found = [];
    for (const [kind, values] of fieldsFor(entry, dateText)) {
      const hits = unique(values.filter(value => normalize(value).includes(query)));
      if (hits.length) found.push([kind, hits]);
    }
    if (!found.length) return null;
    return { hint: `Matches ${found.slice(0, 2).map(([kind, hits]) => summarize(kind, hits)).join(' · ')}`, lotIds: [] };
  }

  return { SCOPES, matchSave, filterLots, filterHouseholds, lotHouseholds };
});
