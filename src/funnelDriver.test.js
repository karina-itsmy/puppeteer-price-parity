import { describe, expect, it } from 'vitest';
import { cardsMatchCount } from './funnelDriver';

describe('cardsMatchCount', () => {
  it('matches when the count covers only the product cards', () => {
    expect(cardsMatchCount({ shown: 16, cards: 16, previousFundCards: 0 })).toBe(true);
  });

  it('matches when the count includes the previous-fund card', () => {
    expect(cardsMatchCount({ shown: 7, cards: 6, previousFundCards: 1 })).toBe(true);
  });

  it('does not match while cards are still loading', () => {
    expect(cardsMatchCount({ shown: 16, cards: 8, previousFundCards: 1 })).toBe(false);
  });

  it('does not match before the count is shown', () => {
    expect(cardsMatchCount({ shown: null, cards: 0, previousFundCards: 0 })).toBe(false);
  });
});
