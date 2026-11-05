const { parseMoney } = require('./comparator');

const amountOff = text => {
  const cents = parseMoney(text);
  return cents === null ? null : Math.abs(cents);
};

// Drops the percentage, so a changed rate shows as a changed amount.
const discountName = label => label.replace(/\s*\([^)]*%\)\s*$/, '').trim();

// A missing rebate or LHC row means $0; no base premium means the breakdown wasn't read.
const readBreakdown = breakdown => {
  if (!breakdown)
    return {
      breakdownRead: false,
      basePremiumCents: null,
      rebateCents: null,
      lhcCents: null,
      discounts: null,
    };
  const basePremiumCents = parseMoney(breakdown.basePremium);
  return {
    breakdownRead: basePremiumCents !== null,
    basePremiumCents,
    rebateCents: breakdown.rebate ? amountOff(breakdown.rebate) : 0,
    lhcCents: breakdown.lhc ? parseMoney(breakdown.lhc) : 0,
    discounts: breakdown.discounts.map(discount => ({
      label: discountName(discount.label),
      value: amountOff(discount.amount),
    })),
  };
};

const readItems = items =>
  items ? items.map(item => ({ label: item.label, value: item.status })) : null;

// Reads a card, re-hovering until its breakdown shows; returns the last read.
const readUntilBreakdown = async (read, reset, attempts = 2) => {
  let raw = await read();
  for (let attempt = 1; attempt < attempts && !raw.breakdown; attempt += 1) {
    await reset();
    raw = await read();
  }
  return raw;
};

// Turns the text read from one card at one excess into a comparable record.
const toCardRecord = raw => {
  const { breakdown, benefits, ...visible } = raw;
  return {
    ...visible,
    priceCents: parseMoney(raw.priceText),
    ...readBreakdown(breakdown),
    benefitsRead: Boolean(benefits),
    hospitalItems: readItems(benefits?.hospital),
    extrasBenefits: readItems(benefits?.extras),
  };
};

module.exports = { readUntilBreakdown, toCardRecord };
