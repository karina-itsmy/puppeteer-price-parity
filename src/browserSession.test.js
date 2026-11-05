import { describe, expect, it } from 'vitest';
import { browserGone, closeBrowsers, ensureBrowsers } from './browserSession';

// A stand-in browser that only knows whether it is connected and whether it was closed.
const fakeBrowser = connected => ({
  connected,
  closed: false,
  async close() {
    this.closed = true;
  },
});

const twoTabs = [{ key: 'expected' }, { key: 'actual' }];

describe('browserGone', () => {
  it('reads the connected flag, falls back to isConnected, and treats no browser as gone', () => {
    expect(browserGone(fakeBrowser(true))).toBe(false);
    expect(browserGone(fakeBrowser(false))).toBe(true);
    expect(browserGone({ isConnected: () => true })).toBe(false);
    expect(browserGone({ isConnected: () => false })).toBe(true);
    expect(browserGone(null)).toBe(true);
  });
});

describe('ensureBrowsers', () => {
  it('opens one browser per tab, telling launch which tab it is for', async () => {
    const launched = [];
    const session = { tabs: twoTabs, browsers: {}, pages: {} };
    const launch = async index => {
      launched.push(index);
      return fakeBrowser(true);
    };
    expect(await ensureBrowsers(session, launch)).toBe(true);
    expect(launched).toEqual([0, 1]);
    expect(Object.keys(session.browsers)).toEqual(['expected', 'actual']);
  });

  it('keeps connected browsers and their tabs', async () => {
    const browsers = { expected: fakeBrowser(true), actual: fakeBrowser(true) };
    const session = { tabs: twoTabs, browsers: { ...browsers }, pages: { expected: 'tab' } };
    expect(await ensureBrowsers(session, async () => fakeBrowser(true))).toBe(false);
    expect(session.browsers).toEqual(browsers);
    expect(session.pages).toEqual({ expected: 'tab' });
  });

  it('relaunches only the browser that has gone, dropping only its tab', async () => {
    const dead = fakeBrowser(false);
    const alive = fakeBrowser(true);
    const fresh = fakeBrowser(true);
    const session = {
      tabs: twoTabs,
      browsers: { expected: alive, actual: dead },
      pages: { expected: 'live tab', actual: 'dead tab' },
    };
    expect(await ensureBrowsers(session, async () => fresh)).toBe(true);
    expect(session.browsers).toEqual({ expected: alive, actual: fresh });
    expect(session.pages).toEqual({ expected: 'live tab' });
    expect(dead.closed).toBe(true);
  });

  it('still relaunches when closing the dead browser throws', async () => {
    const dead = { connected: false, close: async () => Promise.reject(new Error('gone')) };
    const fresh = fakeBrowser(true);
    const session = { tabs: [{ key: 'both' }], browsers: { both: dead }, pages: {} };
    expect(await ensureBrowsers(session, async () => fresh)).toBe(true);
    expect(session.browsers.both).toBe(fresh);
  });
});

describe('closeBrowsers', () => {
  it('closes every browser, even when one fails to close', async () => {
    const first = { close: async () => Promise.reject(new Error('gone')) };
    const second = fakeBrowser(true);
    await closeBrowsers({ browsers: { expected: first, actual: second } });
    expect(second.closed).toBe(true);
  });
});
