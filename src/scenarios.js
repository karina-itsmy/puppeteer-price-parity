// Membership types in report order.
const membershipTypeOrder = [
  'single',
  'couple',
  'family',
  'single-parent',
  'single-any-dependants',
  'couple-any-dependants',
];
// Cover types in report order.
const coverTypeOrder = ['hospital', 'extras', 'combined'];
const rebateTiers = ['none', 'base', 'tier1', 'tier2', 'tier3'];

// The full sweep's single customer profile.
const defaultProfile = { age: 40, rebateTier: 'base', lhcAge: null };

const orderOf = (order, value) => {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
};

const compareSearches = (a, b) =>
  a.state.localeCompare(b.state) ||
  orderOf(membershipTypeOrder, a.membershipType) - orderOf(membershipTypeOrder, b.membershipType) ||
  orderOf(coverTypeOrder, a.coverType) - orderOf(coverTypeOrder, b.coverType) ||
  a.membershipType.localeCompare(b.membershipType) ||
  a.coverType.localeCompare(b.coverType);

const searchKey = search => `${search.state}|${search.membershipType}|${search.coverType}`;

// One search per state, membership type and cover type in the rate file.
const groupIntoSearches = rateRows => {
  const searches = new Map();
  for (const row of rateRows) {
    const key = searchKey(row);
    if (!searches.has(key)) {
      const { state, membershipType, coverType } = row;
      searches.set(key, { search: { state, membershipType, coverType }, rateRows: [] });
    }
    searches.get(key).rateRows.push(row);
  }
  return [...searches.values()].sort((a, b) => compareSearches(a.search, b.search));
};

// Parses "VIC/single/hospital", as used by --search.
const parseSearch = text => {
  const [state, membershipType, coverType] = String(text).split('/');
  if (!state || !membershipType || !coverType) {
    throw new Error(`Search "${text}" should look like VIC/single/hospital`);
  }
  return { state: state.toUpperCase(), membershipType, coverType };
};

const validateProfile = profile => {
  if (!Number.isInteger(profile.age) || profile.age < 18 || profile.age > 99) {
    throw new Error(`Profile age ${profile.age} should be a whole number from 18 to 99`);
  }
  if (!rebateTiers.includes(profile.rebateTier)) {
    throw new Error(
      `Profile rebate tier "${profile.rebateTier}" should be one of: ${rebateTiers.join(', ')}`,
    );
  }
  if (profile.lhcAge !== null && !Number.isInteger(profile.lhcAge)) {
    throw new Error(`Profile LHC age ${profile.lhcAge} should be a whole number or null`);
  }
  return profile;
};

// A birthday a month back, so the funnel reads exactly `age` on any day.
const dateOfBirthForAge = (age, today = new Date()) => {
  const birthday = new Date(
    Date.UTC(today.getFullYear() - age, today.getMonth(), today.getDate() - 30),
  );
  const pad = number => String(number).padStart(2, '0');
  return `${pad(birthday.getUTCDate())}-${pad(birthday.getUTCMonth() + 1)}-${birthday.getUTCFullYear()}`;
};

// A profile as text, e.g. "age 40 · rebate base · no LHC".
const describeProfile = profile =>
  `age ${profile.age} · rebate ${profile.rebateTier} · ${profile.lhcAge === null ? 'no LHC' : `LHC age ${profile.lhcAge}`}`;

const scenarioId = (search, profile) =>
  [
    search.state,
    search.membershipType,
    search.coverType,
    `age${profile.age}`,
    profile.rebateTier,
    profile.lhcAge === null ? 'nolhc' : `lhc${profile.lhcAge}`,
  ].join('-');

// One scenario per rate file search, all with the default profile.
const buildFullSweep = (rateRows, options = {}) => {
  const profile = validateProfile({ ...defaultProfile, ...options.profile });
  const today = options.today ?? new Date();
  let searches = groupIntoSearches(rateRows);
  if (options.onlySearches?.length) {
    const wanted = new Set(options.onlySearches.map(searchKey));
    const found = new Set(searches.map(({ search }) => searchKey(search)));
    const unknown = [...wanted].filter(key => !found.has(key));
    if (unknown.length) {
      throw new Error(`The rate file has no rows for ${unknown.join(', ').replaceAll('|', '/')}`);
    }
    searches = searches.filter(({ search }) => wanted.has(searchKey(search)));
  }
  return searches.map(({ search, rateRows: rows }) => ({
    id: scenarioId(search, profile),
    set: 'full-sweep',
    search,
    profile: { ...profile, dateOfBirth: dateOfBirthForAge(profile.age, today) },
    rateRows: rows,
  }));
};

// Every variation search with every variation profile.
const buildVariations = (rateRows, variations, options = {}) => {
  const today = options.today ?? new Date();
  const { searches = [], profiles = [] } = variations ?? {};
  if (!Array.isArray(searches) || !Array.isArray(profiles)) {
    throw new Error('The variation file needs "searches" and "profiles" lists');
  }
  const rowsBySearch = new Map(
    groupIntoSearches(rateRows).map(({ search, rateRows: rows }) => [searchKey(search), rows]),
  );
  const wanted = options.onlySearches?.length ? new Set(options.onlySearches.map(searchKey)) : null;
  return searches
    .map(parseSearch)
    .filter(search => !wanted || wanted.has(searchKey(search)))
    .flatMap(search => {
      const rows = rowsBySearch.get(searchKey(search));
      if (!rows) {
        throw new Error(
          `The variation file asks for ${searchKey(search).replaceAll('|', '/')}, which the rate file has no rows for`,
        );
      }
      return profiles.map(entry => {
        const profile = validateProfile({ ...defaultProfile, ...entry });
        return {
          id: scenarioId(search, profile),
          set: 'variations',
          search,
          profile: { ...profile, dateOfBirth: dateOfBirthForAge(profile.age, today) },
          rateRows: rows,
        };
      });
    });
};

// Full sweep then variations, without repeats; `onlyIds` narrows to a re-run.
const buildScenarios = (rateRows, options = {}) => {
  const sets = options.sets ?? ['full-sweep', 'variations'];
  const fullSweep = sets.includes('full-sweep') ? buildFullSweep(rateRows, options) : [];
  const variations = sets.includes('variations')
    ? buildVariations(rateRows, options.variations, options)
    : [];
  const seen = new Set(fullSweep.map(scenario => scenario.id));
  const extra = variations.filter(scenario => {
    if (seen.has(scenario.id)) return false;
    seen.add(scenario.id);
    return true;
  });
  const scenarios = [...fullSweep, ...extra];
  if (!options.onlyIds) return scenarios;
  const known = new Set(scenarios.map(scenario => scenario.id));
  const unknown = options.onlyIds.filter(id => !known.has(id));
  if (unknown.length) {
    throw new Error(`These scenarios are not in this run's rate files: ${unknown.join(', ')}`);
  }
  const wanted = new Set(options.onlyIds);
  return scenarios.filter(scenario => wanted.has(scenario.id));
};

module.exports = {
  buildFullSweep,
  buildScenarios,
  buildVariations,
  dateOfBirthForAge,
  defaultProfile,
  describeProfile,
  coverTypeOrder,
  groupIntoSearches,
  membershipTypeOrder,
  parseSearch,
};
