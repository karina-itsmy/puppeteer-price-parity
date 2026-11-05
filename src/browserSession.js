// True when the session's browser has crashed or been closed.
const browserGone = browser =>
  !browser ||
  (typeof browser.connected === 'boolean' ? !browser.connected : !browser.isConnected?.());

// Each tab has its own browser so the two sides run at once, every page in front of its own window.
// Relaunches any gone browser so one crash doesn't fail later searches; true when it did.
const ensureBrowsers = async (session, launch) => {
  let relaunched = false;
  for (const [index, tab] of session.tabs.entries()) {
    const browser = session.browsers[tab.key];
    if (!browserGone(browser)) continue;
    await browser?.close().catch(() => {});
    session.browsers[tab.key] = await launch(index);
    delete session.pages[tab.key];
    relaunched = true;
  }
  return relaunched;
};

const closeBrowsers = async session => {
  for (const browser of Object.values(session.browsers)) await browser.close().catch(() => {});
};

module.exports = { browserGone, closeBrowsers, ensureBrowsers };
