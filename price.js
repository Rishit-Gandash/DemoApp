const { chromium } = require('playwright');

async function humanHover(page, targetSelector, { steps = 10, dwellMs = 700 } = {}) {
  const box = await page.locator(targetSelector).boundingBox();
  if (!box) throw new Error(`Could not find bounding box for ${targetSelector}`);

  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;

  // Start from a plausible spot (viewport center) rather than 0,0
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  let x = viewport.width / 2 + (Math.random() * 100 - 50);
  let y = viewport.height / 2 + (Math.random() * 100 - 50);
  await page.mouse.move(x, y);

  // Generate N waypoints that wander toward the target, not a straight line
  const waypoints = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease toward target with random jitter that shrinks as we approach
    const jitter = (1 - t) * 60;
    const wx = x + (targetX - x) * t + (Math.random() * jitter - jitter / 2);
    const wy = y + (targetY - y) * t + (Math.random() * jitter - jitter / 2);
    waypoints.push({ wx, wy });
  }

  for (const { wx, wy } of waypoints) {
    // Break each hop into a few sub-steps so mousemove fires multiple times per hop
    await page.mouse.move(wx, wy, { steps: 3 + Math.floor(Math.random() * 3) });
    await page.waitForTimeout(40 + Math.random() * 90); // spacing between moves
  }

  // Final settle exactly on target, then dwell
  await page.mouse.move(targetX, targetY, { steps: 5 });
  await page.waitForTimeout(dwellMs);
}

async function dismissCookieBanner(page) {
  // Try a handful of common selectors/text patterns; bail quietly if none show up
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("Yes")',
    'button:has-text("I agree")',
    '[id*="cookie" i] button:has-text("Accept")',
    '[class*="cookie" i] button:has-text("Accept")',
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 1500 })) {
        await locator.click();
        return true;
      }
    } catch {
      // not present, try next
    }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://demo.inelabteamdev.com/item/2576');
  console.log(await page.evaluate(() => navigator.webdriver));

  // 1. Handle the cookie popup first, before anything else interacts with the page
  await dismissCookieBanner(page);

  // 2. Perform the multi-point hover + dwell over the panel so its mousemove
  //    handler fires enough times to enable the button
  await humanHover(page, 'button:has-text("price")', { steps: 8, dwellMs: 600 });

  // 3. Now the button should be enabled — click it and capture the quote response
  const quotePromise = page.waitForResponse(res =>
    /\/api\/v2\/items\/\d+\/quote\?opt=/.test(res.url())
  );
  await page.click('button:has-text("price")');
  const res = await quotePromise;
  const { price, stock } = await res.json();
  console.log({ price, stock });

  await browser.close();
})();
