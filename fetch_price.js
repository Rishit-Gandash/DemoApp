const { chromium } = require('playwright');



const DEFAULT_ITEM_URL = 'https://demo.inelabteamdev.com/item/2030';
const PRICE_BUTTON = 'button[aria-label="Check today’s price"]';


async function selectOption(page, optionLabel) {
  const picker = page.locator('.opt-picker');
  await picker.waitFor({ state: 'visible', timeout: 10_000 });

  // The axis name (Level/Storage/Capacity/etc.) varies by product, so match
  // on the button's own text, not the group's aria-label.
  const chip = picker.getByRole('button', { name: optionLabel, exact: true });
  await chip.waitFor({ state: 'visible', timeout: 5_000 });

  const alreadySelected = (await chip.getAttribute('aria-pressed')) === 'true';
  if (alreadySelected) return;

  await chip.click({ timeout: 5_000 });

  // Confirm the click actually registered before moving on — don't assume.
  await page.waitForFunction(
    (label) => {
      const btn = [...document.querySelectorAll('.opt-picker .opt-chip')]
        .find((el) => el.textContent.trim() === label);
      return btn?.getAttribute('aria-pressed') === 'true';
    },
    optionLabel,
    { timeout: 5_000 },
  );
}


async function getPrice(browser, itemUrl, optionLabel) {

  let stopCookieWatcher = () => {};
  let context;

  try {
    context = await browser.newContext();
    const page = await context.newPage();
    stopCookieWatcher = startCookieConsentWatcher(page);
    await page.goto(itemUrl, { waitUntil: 'domcontentloaded' });
    // Banners are commonly injected after the initial page load. Wait long
    // enough for one to appear; the watcher above continues through the rest
    // of the workflow in case it appears even later.
    await dismissCookieConsent(page, { timeout: 6_000 });

    await selectOption(page, optionLabel);
    await activatePriceButton(page);

    await page.waitForSelector('.offer-row', { timeout: 10_000 });





    const debug = await page.evaluate(() => {
      const offerRow = document.querySelector('.offer-row');
      return offerRow ? offerRow.outerHTML : null;
    });

    console.log(debug);


    const price = parsePrice(debug);
    // const price = await getPriceFromOfferRow(page);
    const stock = await getStock(page);

    console.log("price: " + price);
    console.log("stock: " + stock);
    return {
        price: price,
      stock: stock,
    };
  } finally {
    stopCookieWatcher();
    await context?.close();
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
//
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



function countSpan(debug) {
    let i = 0;
    let count = 0;
    while(i + 4 < debug.length){
        if(debug.slice(i, i + 4) === "span") {
            count++;
        }
        i++;
    }
    return count;
}


function parseSpan(debug, endTerm) {
  let i = 0;
  while (debug.slice(i, i + 6) !== "2.4rem") {
    if (i + 6 > debug.length) {
      console.log("error: couldn't find dpe in string");
      return null;
    }
    i++;
  }

  while (debug[i] !== ">") {
    if (i > debug.length) {
      console.log("error: couldn't find end of tag in string");
      return null;
    }
    i++;
  }
  i++;

  let intPart = "";
  let n = endTerm.length;

  while (debug.slice(i, i + n) !== endTerm) { 
    if (i + 6 > debug.length) {
      console.log("error: couldn't find closing term in string");
      return null;
    }
    const ch = debug[i].normalize("NFKC");
    if (ch === ".") {
      break;
    } else if ("0123456789".includes(ch)) {
        intPart += ch;
    }
    i++;
  }

  const whole = Number(intPart);
  return whole
}

function parsePrice(debug) {
  const no_span = countSpan(debug);
  if(no_span > 15) { // Multiple spans, likely ends with <span class =
    return parseSpan(debug, "<span class");
  } else {
    return parseSpan(debug, "</span>");
  }
}

function startCookieConsentWatcher(page) {
  let checking = false;
  const check = async () => {
    if (checking || page.isClosed()) return;
    checking = true;
    try {
      await dismissCookieConsent(page, { timeout: 0 });
    } catch {
      // A navigation or closed page can race the background check.
    } finally {
      checking = false;
    }
  };
 
  const interval = setInterval(() => void check(), 250);
  void check();
  return () => clearInterval(interval);
}

if (require.main === module) {
  (async () => {
    const browser = await chromium.launch({ headless: false});
    try {
      const result = await getPrice(browser, DEFAULT_ITEM_URL, 'Starter');
      console.log(result);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  })();
}

async function getPriceFromOfferRow(page) {
  const rawText = await page.evaluate(() => {
    const el = document.querySelector('.dpe-n6');
    return el ? el.textContent : null;
  });

  return parsePrice(rawText);
}

// function parsePrice(rawText) {
//   if (!rawText) return null;
//
//   // Strip currency prefix, non-breaking spaces, and thousands separators —
//   // e.g. "Rs.\u00a027,749.00" -> "27749.00"
//   const cleaned = rawText.replace(/[^\d.]/g, '');
//   if (!cleaned) return null;
//
//   const value = Number(cleaned);
//   return Number.isFinite(value) ? value : null;
// }



module.exports = { getPrice, dismissCookieConsent, activatePriceButton };
