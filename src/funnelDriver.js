const { readUntilBreakdown, toCardRecord } = require('./cardReader');
const { credentialsFor } = require('./config');

// Every element id the script uses; fix renamed ids here only.
const selectors = {
  dateOfBirthInput: '#needs-analysis-primary-dob',
  dateOfBirthLabel: '#needs-analysis-primary-dob_label',
  partnerDateOfBirthInput: '#needs-analysis-partner-dob',
  partnerDateOfBirthLabel: '#needs-analysis-partner-dob_label',
  continuousCoverYes: '#needs-analysis-held-continuous-cover-true',
  continuousCoverNo: '#needs-analysis-held-continuous-cover-false',
  lhcAgeInput: '#needs-analysis-personal-lhc-age',
  partnerLhcAgeInput: '#needs-analysis-partner-lhc-age',
  rebateYes: '#needs-analysis-federal-rebate-true',
  rebateNo: '#needs-analysis-federal-rebate-false',
  rebateTierDropdown: '#needs-analysis-rebate-tier',
  rebateTierOption: 'li[role="needs-analysis-rebate-tier-option"]',
  stateDropdown: '#needs-analysis-state',
  membershipTypeDropdown: '#needs-analysis-membership-type',
  coverTypeDropdown: '#needs-analysis-cover-type',
  dropdownOption: (field, label) =>
    `::-p-xpath(//li[@role="needs-analysis-${field}-option"][normalize-space()="${label}"])`,
  compareProductsButton:
    '#needs-analysis-sticky-summary-form-action-button-group-compare-products-btn',
  defaultView: '#product-comparison-default-view',
  productsList: '#product-comparison-default-view-products-list',
  displayCount: '#product-comparison-display-count',
  noProducts: '#product-comparison-no-products',
  noProductsReturnButton: '#product-comparison-no-products-action-button',
  showMoreButton: 'button[name="default-view-show-more-button"]',
  fundsFilterButton: '#product-comparison-filter-funds-button',
  fundsFilterContents: '#product-comparison-filter-modal-funds-contents',
  fundsDeselectAllButton: '#product-comparison-filter-modal-funds-select-deselect-all-button',
  fundsSelectedCount: '#product-comparison-filter-modal-funds-selected-count',
  fundCheckboxWrapper: '[id^="product-comparison-filter-modal-fund-"][id$="-checkbox"]',
  filterApplyButton: '#product-comparison-filter-modal-apply-button',
  productCard: '#product-comparison-default-view [data-package-product-codes]',
  cardFundLogo: 'img',
  cardProductName: '[id$="-product-name-button"]',
  cardFundProductCode: '[id$="-product-name-fund-product-code"]',
  cardExcessButton: '[id$="-excess-select"]',
  cardExcessOption: '[id$="-excess-section"] li',
  cardDisplayPrice: '[id$="-display-price-your-premium"]',
  cardPremiumSection: '[id$="-your-premium-section"]',
  cardPriceList: '[id$="-your-premium-price-list"]',
  priceListBasePremium: '[id$="-price-list-base-premium"] span:last-child',
  priceListRebate: '[id$="-price-list-rebate"] span:last-child',
  priceListLhc: '[id$="-price-list-lhc"] span:last-child',
  priceListDiscount: '[id*="-price-list-discounts"]:not([id$="-no-discounts"])',
  goBackButton: '#needs-analysis-go-back-button',
  defaultViewButton: '#product-comparison-default-view-button',
  detailedViewButton: '#product-comparison-detailed-view-button',
  detailedCard: '[id$="-detailed-view-product-card"]',
  carouselNextButton: '#product-comparison-carousel-next-button',
  hospitalTable: '[id$="-product-details-table-hospital"]',
  extrasTable: '[id$="-product-details-table-ancillary"]',
  benefitRow: '[id*="-product-details-accordion-"]:not([id$="-trigger"]):not([id$="-panel"])',
  benefitTrigger: '[role="accordion-trigger-button"]',
};

const stateLabels = {
  ACT: 'Australian Capital Territory',
  NSW: 'New South Wales',
  NT: 'Northern Territory',
  QLD: 'Queensland',
  SA: 'South Australia',
  TAS: 'Tasmania',
  VIC: 'Victoria',
  WA: 'Western Australia',
};
const membershipTypeLabels = {
  single: 'Just for you',
  couple: 'For you and your partner',
  family: 'For your whole family',
  'single-parent': 'For your family - Single Parent',
  'single-any-dependants': 'Single: any dependants',
  'couple-any-dependants': 'Couple: any dependants',
};
const coverTypeLabels = {
  hospital: 'Hospital cover only',
  extras: 'Extras cover only',
  combined: 'both Hospital and Extras cover',
};

// An environment problem, e.g. the lead won't load, that stops the whole run.
class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
  }
}

// Tier labels are income bands from the backend, so tiers are picked by position (0 is the placeholder).
const rebateTierPositions = { base: 1, tier1: 2, tier2: 3, tier3: 4 };

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const labelFor = (labels, value, field) => {
  const label = labels[value];
  if (!label)
    throw new Error(
      `Unknown ${field} "${value}". Expected one of: ${Object.keys(labels).join(', ')}`,
    );
  return label;
};

const chooseDropdownOption = async (page, dropdownSelector, field, label) => {
  await page.waitForSelector(dropdownSelector, { visible: true, timeout: 60000 });
  await page.click(dropdownSelector);
  const optionSelector = selectors.dropdownOption(field, label);
  await page.waitForSelector(optionSelector, { visible: true, timeout: 10000 });
  await page.click(optionSelector);
  await pause(300);
};

// Opens the lead in the agent funnel and waits for its details to load.
// Deployed slots sit behind basic auth, which a browser dialog can't be scripted through, so the
// credentials come from the environment, never from config.
const openLead = async (page, baseUrl, leadId, credentials = credentialsFor(null)) => {
  const url = `${baseUrl.replace(/\/$/, '')}/${leadId}`;
  const { username, password, variables } = credentials;
  if (username) await page.authenticate({ username, password });
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  } catch (error) {
    const hint = error.message.includes('ERR_INVALID_AUTH_CREDENTIALS')
      ? username
        ? `The site rejected ${variables}.`
        : `The site needs a login: set ${variables}.`
      : 'Is comparator-need-analysis-3 running?';
    throw new SetupError(`Could not reach the comparator at ${url}. ${hint} (${error.message})`);
  }
  // An unknown lead still renders the form, but empty; a loaded lead fills in the date of birth.
  try {
    await page.waitForSelector(selectors.stateDropdown, { visible: true, timeout: 60000 });
    await page.waitForFunction(
      selector => Boolean(document.querySelector(selector)?.value),
      { timeout: 30000 },
      selectors.dateOfBirthInput,
    );
  } catch {
    throw new SetupError(
      `Lead ${leadId} did not load into the needs analysis form. Check the lead id and that Django is running.`,
    );
  }
};

// Picks the state, membership type and cover type.
const enterSearch = async (page, search) => {
  await chooseDropdownOption(
    page,
    selectors.stateDropdown,
    'state',
    labelFor(stateLabels, search.state, 'state'),
  );
  await chooseDropdownOption(
    page,
    selectors.membershipTypeDropdown,
    'membership-type',
    labelFor(membershipTypeLabels, search.membershipType, 'membership type'),
  );
  await chooseDropdownOption(
    page,
    selectors.coverTypeDropdown,
    'cover-type',
    labelFor(coverTypeLabels, search.coverType, 'cover type'),
  );
};

const typeDateOfBirth = async (page, inputSelector, labelSelector, dateOfBirth, age) => {
  await page.$eval(inputSelector, input => {
    input.focus();
    input.select();
  });
  await page.keyboard.press('Backspace');
  await page.keyboard.type(dateOfBirth.replaceAll('-', ''));
  await page.mouse.click(5, 5);
  await pause(300);
  const label = await page.$eval(labelSelector, element => element.innerText);
  if (!label.includes(`(${age} years old)`)) {
    throw new Error(
      `Date of birth ${dateOfBirth} did not give age ${age}; the funnel shows "${label}"`,
    );
  }
};

const clickRadio = async (page, selector) => {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector);
  await pause(300);
};

const typeLhcAge = async (page, inputSelector, lhcAge) => {
  await page.waitForSelector(inputSelector, { visible: true, timeout: 10000 });
  await page.$eval(inputSelector, input => input.select());
  await page.keyboard.type(String(lhcAge));
  await page.keyboard.press('Tab');
  await pause(300);
};

// Sets age, LHC and rebate tier; run after enterSearch, which decides the fields shown.
const enterProfile = async (page, profile) => {
  const { age, dateOfBirth, lhcAge, rebateTier } = profile;
  await typeDateOfBirth(
    page,
    selectors.dateOfBirthInput,
    selectors.dateOfBirthLabel,
    dateOfBirth,
    age,
  );
  if (await page.$(selectors.partnerDateOfBirthInput)) {
    await typeDateOfBirth(
      page,
      selectors.partnerDateOfBirthInput,
      selectors.partnerDateOfBirthLabel,
      dateOfBirth,
      age,
    );
  }

  // The funnel only asks about LHC from age 31. Below that there is nothing to answer.
  const lhcQuestion = await page
    .waitForSelector(selectors.continuousCoverYes, { visible: true, timeout: 3000 })
    .catch(() => null);
  if (!lhcQuestion) {
    if (lhcAge !== null) {
      throw new Error(
        `The funnel doesn't ask about LHC at age ${age}, so LHC age ${lhcAge} can't be entered`,
      );
    }
  } else if (lhcAge === null) {
    await clickRadio(page, selectors.continuousCoverYes);
  } else {
    await clickRadio(page, selectors.continuousCoverNo);
    await typeLhcAge(page, selectors.lhcAgeInput, lhcAge);
    // A couple or family is asked the partner's LHC age too, and the partner gets the same one.
    if (await page.$(selectors.partnerLhcAgeInput)) {
      await typeLhcAge(page, selectors.partnerLhcAgeInput, lhcAge);
    }
  }

  if (rebateTier === 'none') {
    await clickRadio(page, selectors.rebateNo);
    return;
  }
  await clickRadio(page, selectors.rebateYes);
  await page.waitForSelector(selectors.rebateTierDropdown, { visible: true, timeout: 10000 });
  await page.click(selectors.rebateTierDropdown);
  await page.waitForSelector(selectors.rebateTierOption, { visible: true, timeout: 10000 });
  const options = await page.$$(selectors.rebateTierOption);
  const option = options[rebateTierPositions[rebateTier]];
  if (!option) throw new Error(`The rebate tier list has no option for "${rebateTier}"`);
  await option.click();
  await pause(300);
};

// The previous-fund card is the customer's own policy, so it isn't counted.
const readDisplayState = page =>
  page.evaluate(
    (countSelector, cardSelector, noProductsSelector) => {
      const text = document.querySelector(countSelector)?.innerText ?? '';
      const match = text.match(/Showing (\d+) of (\d+)/);
      const allCards = [...document.querySelectorAll(cardSelector)];
      const cards = allCards.filter(card => !card.id.startsWith('previous-fund'));
      return {
        shown: match ? Number(match[1]) : null,
        total: match ? Number(match[2]) : null,
        cards: cards.length,
        previousFundCards: allCards.length - cards.length,
        noProducts: Boolean(document.querySelector(noProductsSelector)),
      };
    },
    selectors.displayCount,
    selectors.productCard,
    selectors.noProducts,
  );

// "No products found" also flashes while the fund filter is being changed, so it must hold this long.
const NO_PRODUCTS_STEADY_READS = 10;

// Whether every counted result is on the page; the "Showing" count may include the previous-fund card.
const cardsMatchCount = ({ shown, cards, previousFundCards = 0 }) =>
  shown !== null && (cards === shown || cards + previousFundCards === shown);

const waitForResults = async (page, isReady = () => true, timeout = 90000) => {
  const deadline = Date.now() + timeout;
  let previous = null;
  let steadyReads = 0;
  while (Date.now() < deadline) {
    const read = await readDisplayState(page);
    // An empty result shows no count, so it is read as nothing shown.
    const empty = read.noProducts && read.shown === null && read.cards === 0;
    const state = empty ? { ...read, shown: 0, total: 0 } : read;
    const settled = cardsMatchCount(state) && isReady(state);
    const unchanged = previous && JSON.stringify(previous) === JSON.stringify(state);
    steadyReads = settled && unchanged ? steadyReads + 1 : 0;
    if (steadyReads >= (empty ? NO_PRODUCTS_STEADY_READS : 3)) return state;
    previous = state;
    await pause(500);
  }
  const last = previous
    ? `last read: "Showing ${previous.shown ?? '?'} of ${previous.total ?? '?'}", ${previous.cards} product cards`
    : 'nothing read';
  throw new Error(`Results did not finish loading within ${timeout / 1000}s (${last})`);
};

// Submits the form and waits for the results.
const openComparison = async page => {
  await page.waitForSelector(selectors.compareProductsButton, { visible: true, timeout: 60000 });
  await page.click(selectors.compareProductsButton);
  await page.waitForSelector(selectors.defaultView, { visible: true, timeout: 90000 });
  return waitForResults(page);
};

// How long a fund filter gets to change the result count before the unchanged results are taken.
const FILTER_CHANGE_TIMEOUT_MS = 20000;

// Ticks only the given test funds in the fund filter, skipping it when already set.
const filterToFunds = async (page, fundNames) => {
  const before = await readDisplayState(page);
  await page.click(selectors.fundsFilterButton);
  await page.waitForSelector(selectors.fundsFilterContents, { visible: true, timeout: 30000 });

  const funds = await page.$$eval(selectors.fundCheckboxWrapper, wrappers =>
    wrappers.map(wrapper => ({
      name: wrapper.innerText.trim(),
      ticked: Boolean(wrapper.querySelector('input[type="checkbox"]')?.checked),
    })),
  );
  const available = funds.map(fund => fund.name);
  const missing = fundNames.filter(name => !available.includes(name));
  if (missing.length) {
    throw new SetupError(
      `Fund filter has no ${missing.join(' or ')}. Is the fund linked to the corporate? Available: ${available.join(', ')}`,
    );
  }
  const ticked = funds.filter(fund => fund.ticked).map(fund => fund.name);
  const alreadySet =
    ticked.length === fundNames.length && fundNames.every(name => ticked.includes(name));

  if (!alreadySet) {
    await page.click(selectors.fundsDeselectAllButton);
    await pause(300);
    for (const name of fundNames) {
      await page.$$eval(
        selectors.fundCheckboxWrapper,
        (wrappers, fundName) => {
          const wrapper = wrappers.find(item => item.innerText.trim() === fundName);
          wrapper.querySelector('input[type="checkbox"]').click();
        },
        name,
      );
      await pause(200);
    }
  }
  const selectedCount = await page.$eval(selectors.fundsSelectedCount, el => el.innerText);
  if (!selectedCount.startsWith(`${fundNames.length} /`)) {
    throw new Error(
      `Fund filter shows "${selectedCount}" after selecting ${fundNames.join(' and ')}`,
    );
  }
  await page.click(selectors.filterApplyButton);
  if (alreadySet) return waitForResults(page);
  // A new total means the filter applied; a corporate showing only the test funds never changes it.
  return waitForResults(
    page,
    state => state.total !== before.total || state.shown !== before.shown,
    FILTER_CHANGE_TIMEOUT_MS,
  ).catch(() => waitForResults(page));
};

// Clicks "Show More" until every result is on the page.
const loadAllResults = async page => {
  let latest = await readDisplayState(page);
  while (latest.shown < latest.total) {
    const shownBefore = latest.shown;
    const button = await page.waitForSelector(selectors.showMoreButton, {
      visible: true,
      timeout: 30000,
    });
    await button.click();
    latest = await waitForResults(page, next => next.shown > shownBefore);
  }
  return latest;
};

// Returns to the form, keeping the lead and fund filter.
const backToForm = async page => {
  await page.evaluate(() => window.scrollTo(0, 0));
  // An empty result has its own way back; the usual back button doesn't reach the form from it.
  const returnButton = (await page.$(selectors.noProducts))
    ? selectors.noProductsReturnButton
    : selectors.goBackButton;
  await page.waitForSelector(returnButton, { visible: true, timeout: 30000 });
  await page.$eval(returnButton, button => button.click());
  await page.waitForSelector(selectors.stateDropdown, { visible: true, timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(1000);
};

const cardPrefix = id => id.replace(/-(detailed-view-)?product-card$/, '');

// The breakdown only exists while hovered, so everything is read in one call.
const readVisibleCardValues = card =>
  card.evaluate((element, cardSelectors) => {
    const text = (selector, root = element) =>
      root.querySelector(selector)?.innerText.trim() ?? null;
    const list = element.querySelector(cardSelectors.cardPriceList);
    return {
      fundName: element.querySelector(cardSelectors.cardFundLogo)?.alt ?? null,
      productName: text(cardSelectors.cardProductName),
      fundProductCode: text(cardSelectors.cardFundProductCode),
      excess: text(cardSelectors.cardExcessButton),
      priceText: text(cardSelectors.cardDisplayPrice),
      breakdown: list && {
        basePremium: text(cardSelectors.priceListBasePremium, list),
        rebate: text(cardSelectors.priceListRebate, list),
        lhc: text(cardSelectors.priceListLhc, list),
        discounts: [...list.querySelectorAll(cardSelectors.priceListDiscount)].map(row => ({
          label: row.querySelector('span')?.innerText.trim() ?? '',
          amount: row.querySelector('span:last-child')?.innerText.trim() ?? null,
        })),
      },
    };
  }, selectors);

// A card's id follows its product name, which can change with the excess and remount the card,
// detaching any held handle. So each step finds the card again by its product codes, which cover
// every excess; the position tells apart cards with the same codes.
const cardFinder = (page, codes, position) => async () => {
  const cards = [];
  for (const card of await page.$$(selectors.productCard)) {
    const { id, cardCodes } = await card.evaluate(element => ({
      id: element.id,
      cardCodes: element.dataset.packageProductCodes,
    }));
    if (!id.startsWith('previous-fund') && cardCodes === codes) cards.push(card);
  }
  if (!cards[position]) throw new Error(`Card for products ${codes} is no longer on the page`);
  return cards[position];
};

// The popup only opens on a fresh hover, so a missed breakdown is re-hovered.
const readHoveredCard = (page, findCard) =>
  readUntilBreakdown(
    async () => {
      const card = await findCard();
      await (await card.$(selectors.cardPremiumSection)).hover();
      await card.waitForSelector(selectors.cardPriceList, { timeout: 5000 }).catch(() => {});
      return readVisibleCardValues(card);
    },
    async () => {
      await page.mouse.move(1, 1);
      await pause(300);
    },
  );

const chooseExcess = async (findCard, optionIndex) => {
  await (await (await findCard()).$(selectors.cardExcessButton)).click();
  await pause(200);
  const options = await (await findCard()).$$(selectors.cardExcessOption);
  await options[optionIndex].click();
  await pause(300);
};

const countExcessOptions = async findCard => {
  const codes = await (
    await findCard()
  ).evaluate(element => (element.dataset.packageProductCodes ?? '').split(',').filter(Boolean));
  if (codes.length === 1) return 1;
  await (await (await findCard()).$(selectors.cardExcessButton)).click();
  await pause(200);
  const count = (await (await findCard()).$$(selectors.cardExcessOption)).length;
  await (await (await findCard()).$(selectors.cardExcessButton)).click();
  await pause(200);
  return count;
};

const readCard = async (page, findCard) => {
  const optionCount = await countExcessOptions(findCard);
  const records = [await readHoveredCard(page, findCard)];
  for (let index = 1; index < optionCount; index += 1) {
    await chooseExcess(findCard, index);
    records.push(await readHoveredCard(page, findCard));
  }
  if (optionCount > 1) await chooseExcess(findCard, 0);
  return records;
};

const readMountedBenefits = page =>
  page.$$eval(
    selectors.detailedCard,
    (cards, cardSelectors) =>
      cards.map(card => {
        const items = tableSelector => {
          const table = card.querySelector(tableSelector);
          if (!table) return null;
          return [...table.querySelectorAll(cardSelectors.benefitRow)].map(row => {
            const trigger = row.querySelector(cardSelectors.benefitTrigger);
            const badge = trigger?.querySelector('[aria-hidden="true"], span');
            let status = 'not covered';
            if (badge?.innerText.trim() === 'R') status = 'restricted';
            else if (trigger?.querySelector('.bg-success-tint')) status = 'covered';
            return { label: trigger?.querySelector('p')?.innerText.trim() ?? '', status };
          });
        };
        return {
          id: card.id,
          hospital: items(cardSelectors.hospitalTable),
          extras: items(cardSelectors.extrasTable),
        };
      }),
    selectors,
  );

const backToDefaultView = async page => {
  await page.click(selectors.defaultViewButton);
  await page.waitForSelector(selectors.defaultView, { visible: true, timeout: 30000 });
  // The card list grows in from zero height, so screenshots wait for it to finish.
  await page.waitForFunction(
    selector => {
      const list = document.querySelector(selector);
      return list && getComputedStyle(list).transform === 'none';
    },
    { timeout: 10000 },
    selectors.productsList,
  );
};

const stepThroughDetailedView = async (page, visit) => {
  // The funnel remembers the view, so the default view is restored even if this one fails.
  try {
    await page.click(selectors.detailedViewButton);
    await page.waitForSelector(selectors.detailedCard, { visible: true, timeout: 30000 });
    await pause(500);
    for (let step = 0; step < 500; step += 1) {
      if (await visit()) break;
      const canMove = await page
        .$eval(selectors.carouselNextButton, button => !button.disabled)
        .catch(() => false);
      if (!canMove) break;
      await page.click(selectors.carouselNextButton);
      await pause(350);
    }
  } finally {
    await backToDefaultView(page);
  }
};

// The carousel only mounts nearby cards, so it is stepped through to read them all.
const readAllBenefits = async page => {
  const benefits = new Map();
  await stepThroughDetailedView(page, async () => {
    for (const card of await readMountedBenefits(page)) {
      if (!benefits.has(cardPrefix(card.id))) benefits.set(cardPrefix(card.id), card);
    }
    return false;
  });
  return benefits;
};

// Screenshots each wanted card's hospital and extras items; returns the ids captured.
const screenshotDetailedCards = async (page, files) => {
  const captured = new Set();
  if (!files.size || !(await page.$(selectors.productCard))) return captured;
  await page.mouse.move(1, 1);
  await stepThroughDetailedView(page, async () => {
    for (const [cardId, file] of files) {
      if (captured.has(cardId)) continue;
      const card = await page.$(`[id="${cardId}-detailed-view-product-card"]`);
      if (!card) continue;
      const onScreen = await card.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      });
      if (!onScreen) continue;
      // At the top of the page the sticky filter bar sits above the card instead of over it.
      await page.evaluate(() => window.scrollTo(0, 0));
      await card.screenshot({ path: file, scrollIntoView: false, captureBeyondViewport: true });
      captured.add(cardId);
    }
    return captured.size === files.size;
  });
  return captured;
};

// Reads every result card, one record per excess, with its benefits.
const readAllCards = async page => {
  const cards = (
    await page.$$eval(selectors.productCard, elements =>
      elements.map(element => ({ id: element.id, codes: element.dataset.packageProductCodes })),
    )
  ).filter(card => !card.id.startsWith('previous-fund'));
  // With no products the detailed view has no cards to step through.
  if (!cards.length) return [];
  const rawRecords = [];
  for (const [index, { id, codes }] of cards.entries()) {
    const position = cards.slice(0, index).filter(other => other.codes === codes).length;
    for (const record of await readCard(page, cardFinder(page, codes, position)))
      rawRecords.push({ prefix: cardPrefix(id), record });
  }
  const benefits = await readAllBenefits(page);
  return rawRecords.map(({ prefix, record }) =>
    toCardRecord({ ...record, cardId: prefix, benefits: benefits.get(prefix) ?? null }),
  );
};

// Screenshots one card with its breakdown showing; false when it isn't on the page.
const screenshotCard = async (page, cardId, file) => {
  const card = await page.$(`[id="${cardId}-product-card"]`);
  if (!card) return false;
  await card.scrollIntoView();
  await (await card.$(selectors.cardPremiumSection))?.hover();
  await card.waitForSelector(selectors.cardPriceList, { timeout: 3000 }).catch(() => {});
  await card.screenshot({ path: file });
  return true;
};

// Screenshots the whole page with no breakdown or sticky bar in the way.
const screenshotPage = async (page, file) => {
  await page.mouse.move(1, 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(500);
  await page.screenshot({ path: file, fullPage: true });
};

module.exports = {
  backToForm,
  cardsMatchCount,
  enterProfile,
  enterSearch,
  filterToFunds,
  loadAllResults,
  openComparison,
  openLead,
  readAllCards,
  screenshotCard,
  screenshotDetailedCards,
  screenshotPage,
  selectors,
  SetupError,
};
