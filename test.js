const { chromium } = require('playwright');

const DEFAULT_ITEM_URL = 'https://demo.inelabteamdev.com/item/2030';
const PRICE_BUTTON = 'button[aria-label="Check today’s price"]';

/**
 * Fetch the quote shown after pressing the item's price button.
 * Run with: node fetch_price.js <item-page-url>
 */
async function getPrice(itemUrl = DEFAULT_ITEM_URL) {
  const browser = await chromium.launch({ headless: true});

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(itemUrl, { waitUntil: 'domcontentloaded' });
    // Banners are commonly injected after the initial page load. Wait long
    // enough for one to appear; the watcher above continues through the rest
    // of the workflow in case it appears even later.
    await dismissCookieConsent(page, { timeout: 6_000 });
    await activatePriceButton(page);

    await page.waitForSelector('.offer-row', { timeout: 10_000 });




    const debug = await page.evaluate(() => {
      const offerRow = document.querySelector('.offer-row');
      return offerRow ? offerRow.outerHTML : null;
    });

    let price= parsePrice(debug);

    const stock = await getStock(page);

    console.log("price: " + price);
    console.log("stock: " + stock);
    return {
      price,
      stock,
    };
  } finally {
    await browser.close();
  }
}

async function activatePriceButton(page) {
  const button = page.locator(PRICE_BUTTON).first();
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  const pricePanel = page.locator('.offer-panel').filter({ has: button }).first();
  await pricePanel.scrollIntoViewIfNeeded();

  // This storefront deliberately requires a human-like hover: at least eight
  // pointer moves, spaced apart, followed by a 600 ms dwell. Hovering only the
  // disabled button does not reach the panel's mouse-move handler.
  const box = await pricePanel.boundingBox();
  if (!box) {
    throw new Error('The price panel is visible but has no pointer bounds.');
  }

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const wiggleX = Math.min(24, Math.max(4, box.width / 4));
  const wiggleY = Math.min(12, Math.max(3, box.height / 4));
  await page.mouse.move(centerX, centerY);
  for (let move = 0; move < 8; move += 1) {
    const direction = move % 2 === 0 ? 1 : -1;
    await page.mouse.move(
      centerX + direction * wiggleX * ((move % 3) + 1) / 3,
      centerY + direction * wiggleY,
    );
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(600);

  // This waits for the now-enabled button and performs a trusted click.
  await button.click({ timeout: 5_000 });
}



async function dismissCookieConsent(page, { timeout = 0 } = {}) {
  const selectors = [
    '.consent-box [aria-label="Allow cookies"]',
    '.consent-box [aria-label="Reject cookies"]',
    '.consent-box .ctl-main',
    '.consent-box .ctl-plain',
  ];
  const deadline = Date.now() + timeout;

  do {
    for (const selector of selectors) {
      if (await clickIfVisible(page.locator(selector).first())) return;
    }
    if (Date.now() < deadline) await page.waitForTimeout(100);
  } while (Date.now() < deadline);
}

// async function dismissCookieConsent(page, { timeout = 0 } = {}) {
//   const selector = '.consent-box [aria-label="Allow cookies"]';
//   const deadline = Date.now() + timeout;
//
//   do {
//     if (await clickIfVisible(page.locator(selector).first())) return;
//     if (Date.now() < deadline) await page.waitForTimeout(100);
//   } while (Date.now() < deadline);
// }

// async function dismissCookieConsent(page, { timeout = 0 } = {}) {
//   // Consent providers differ wildly; use specific IDs first, then accessible
//   // button names. Check every frame because many CMPs render in an iframe.
//   const selectors = [
//     '#onetrust-accept-btn-handler',
//     '#onetrust-reject-all-handler',
//     '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
//     '#CybotCookiebotDialogBodyButtonDecline',
//     '[data-testid="cookie-accept"]',
//     '[data-testid="cookie-reject"]',
//     '[data-testid="uc-accept-all-button"]',
//     '[aria-label*="accept cookies" i]',
//     '[aria-label*="reject cookies" i]',
//     '[id*="cookie"][id*="accept" i]',
//     '[id*="cookie"][id*="reject" i]',
//   ];
//   const names = [
//     /^(accept|accept all|accept cookies|allow all|agree|i agree|yes|ok|got it)$/i,
//     /^(reject|reject all|reject cookies|decline|deny|no|necessary only)$/i,
//   ];
//
//   const deadline = Date.now() + timeout;
//   do {
//     for (const frame of page.frames()) {
//       for (const selector of selectors) {
//         if (await clickIfVisible(frame.locator(selector).first())) return;
//       }
//       for (const name of names) {
//         if (await clickIfVisible(frame.getByRole('button', { name, exact: true }).first())) return;
//       }
//     }
//     if (Date.now() < deadline) await page.waitForTimeout(100);
//   } while (Date.now() < deadline);
// }

async function clickIfVisible(locator) {
  try {
    if (await locator.isVisible()) {
      await locator.click({ timeout: 1_000 });
      return true;
    }
  } catch {
    // The frame may navigate or the banner may disappear between checks.
  }
  return false;
}

async function getStock(page) {
  return page.evaluate(() => {
    const soldOut = document.querySelector('.avail-pill.avail-no');
    if (soldOut) return 0;

    const available = document.querySelector('.avail-pill.avail-yes');
    if (available) {
      const match = available.textContent.match(/\d+/);
      if (match) return parseInt(match[0], 10);
    }

    return null; // neither pill found — unexpected state, don't guess
  });
}



function parsePrice(debug) {
  let i = 0;
  while (debug.slice(i, i + 6) !== "strong") {
    if (i + 6 > debug.length) {
      console.log("error: couldn't find strong in string");
      return null;
    }
    i++;
  }

  while (debug.slice(i, i + 4) !== "span") {
    if (i + 4 > debug.length) {
      console.log("error: couldn't find span in string");
      return null;
    }
    i++;
  }
  i++;

  let intPart = "";
  let decPart = "";
  let sawDecimal = false;

  while (debug.slice(i, i + 6) !== "strong") { // see note below
    if (i + 6 > debug.length) {
      console.log("error: couldn't find closing strong in string");
      return null;
    }
    const ch = debug[i];
    if (ch === ".") {
      break;
    } else if ("0123456789".includes(ch)) {
      if (sawDecimal) decPart += ch;
      else intPart += ch;
    }
    i++;
  }

  const whole = Number(intPart);
  return whole
}



if (require.main === module) {
  getPrice(process.argv[2] || DEFAULT_ITEM_URL)
    .then((quote) => console.log(quote))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { getPrice, dismissCookieConsent, activatePriceButton };
