require('dotenv').config();
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const pLimit = require('p-limit');
const { getPrice } = require('./fetch_price'); // your existing implementation
const fs = require('fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function required(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return val;
}

const BASE_URL = process.env.BASE_URL || 'https://demo.inelabteamdev.com';
const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');
const LISTINGS_PAGE_LIMIT = 20;
const PRICE_SAMPLE_COUNT = 5;

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Browser lifecycle — singleton, relaunches if disconnected
// ---------------------------------------------------------------------------

let browserInstance = null;
let launching = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  if (launching) {
    return launching;
  }
  launching = (async () => {
    try {
      browserInstance = await chromium.launch({ headless: true });
      return browserInstance;
    } finally {
      launching = null;
    }
  })();
  return launching;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Reliable price: sample getPrice N times, majority-vote, drop null prices
// ---------------------------------------------------------------------------

async function getReliablePrice(browser, itemUrl, optionLabel) {
  const samples = [];

  for (let i = 0; i < PRICE_SAMPLE_COUNT; i++) {
    const result = await Promise.race([
      getPrice(browser, itemUrl, optionLabel),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getPrice timed out')), 15000)),
    ]).catch(() => null);
    if (result && result.price !== null && result.price !== undefined && result.price !== 0) {
      samples.push(result);
    }
  }

  if (samples.length === 0) {
    return { price: null, stock: null, sampleCount: 0 };
  }

  const counts = new Map();
  for (const s of samples) {
    const key = `${s.price}::${s.stock}`;
    if (!counts.has(key)) {
      counts.set(key, { count: 0, price: s.price, stock: s.stock });
    }
    counts.get(key).count += 1;
  }

  let winner = null;
  for (const entry of counts.values()) {
    if (!winner || entry.count > winner.count) {
      winner = entry;
    }
  }

  return { price: winner.price, stock: winner.stock, sampleCount: samples.length };
}

// ---------------------------------------------------------------------------
// Site API — listings pagination + item detail
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}) for ${url}`);
  }
  return res.json();
}

async function fetchListingsPage(page, limit = LISTINGS_PAGE_LIMIT) {
  const url = `${BASE_URL}/api/v2/listings?page=${page}&limit=${limit}`;
  return fetchJson(url);
}

async function fetchAllListings(limit = LISTINGS_PAGE_LIMIT) {
  const first = await fetchListingsPage(1, limit);
  const results = [...(first.results || [])];

  // const totalPages =
  //   first.totalPages ||
  //   first.total_pages ||
  //   (first.total ? Math.ceil(first.total / limit) : 1);

  // for (let page = 2; page <= totalPages; page++) {
  //   await sleep(1000);
  //   const data = await fetchListingsPage(page, limit);
  //   results.push(...(data.results || []));
  // }

  return results;
}

async function fetchItemDetail(itemId) {
  const url = `${BASE_URL}/api/v2/items/${itemId}`;
  return fetchJson(url);
}

// ---------------------------------------------------------------------------
// Repository — all Supabase reads/writes
// ---------------------------------------------------------------------------

async function upsertItem({ id, name, url, optionAxis }) {
  const { error } = await supabase
    .from('items')
    .upsert(
      { id, name, url, option_axis: optionAxis, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  if (error) throw new Error(`upsertItem(${id}) failed: ${error.message}`);
}

async function upsertItemOption({ itemId, externalOptionId, label }) {
  const { data, error } = await supabase
    .from('item_options')
    .upsert(
      {
        item_id: itemId,
        external_option_id: externalOptionId,
        label,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'item_id,label' }
    )
    .select('id')
    .single();

  if (error) throw new Error(`upsertItemOption(${itemId}, ${label}) failed: ${error.message}`);
  return data.id;
}

// Trimming to the last 10 rows per option is handled by a DB trigger
// (see db/schema.sql) — this just inserts, same as any other row.
async function insertPriceHistory({ itemOptionId, price, stock, sampleCount }) {
  const { error } = await supabase.from('price_history').insert({
    item_option_id: itemOptionId,
    price,
    stock,
    sample_count: sampleCount,
  });
  if (error) {
    throw new Error(`insertPriceHistory(item_option_id=${itemOptionId}) failed: ${error.message}`);
  }
}

async function startCrawlRun() {
  const { data, error } = await supabase
    .from('crawl_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (error) throw new Error(`startCrawlRun failed: ${error.message}`);
  return data.id;
}

async function finishCrawlRun(runId, { itemsProcessed, optionsProcessed, errors, status }) {
  const { error } = await supabase
    .from('crawl_runs')
    .update({
      finished_at: new Date().toISOString(),
      items_processed: itemsProcessed,
      options_processed: optionsProcessed,
      errors,
      status,
    })
    .eq('id', runId);
  if (error) throw new Error(`finishCrawlRun(${runId}) failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Crawler orchestration
// ---------------------------------------------------------------------------

async function processItem(browser, listingSummary, stats) {
  const itemId = listingSummary.id;
  const itemUrl = `${BASE_URL}/item/${itemId}`;

  let detail;
  try {
    detail = await fetchItemDetail(itemId);
  } catch (err) {
    console.error(`[item ${itemId}] failed to fetch detail: ${err.message}`);
    stats.errors += 1;
    return;
  }

  const options = detail.options || [];

  try {
    await upsertItem({
      id: itemId,
      name: detail.name || listingSummary.name || null,
      url: itemUrl,
      optionAxis: detail.optionAxis || null,
    });
  } catch (err) {
    console.error(`[item ${itemId}] failed to upsert item: ${err.message}`);
    stats.errors += 1;
    return;
  }

  for (const option of options) {
    try {
      const itemOptionId = await upsertItemOption({
        itemId,
        externalOptionId: option.id,
        label: option.label,
      });

      const { price, stock, sampleCount } = await getReliablePrice(browser, itemUrl, option.label);

      if (sampleCount === 0) {
        console.warn(`[item ${itemId}] option "${option.label}": all samples came back null, skipping record`);
        stats.errors += 1;
        continue;
      }

      await insertPriceHistory({ itemOptionId, price, stock, sampleCount });
      stats.optionsProcessed += 1;
    } catch (err) {
      console.error(`[item ${itemId}] option "${option.label}" failed: ${err.message}`);
      stats.errors += 1;
    }
  }

  stats.itemsProcessed += 1;
  console.log(`[item ${itemId}] done — ${options.length} option(s) processed`);
}

async function runCrawl() {
  const runId = await startCrawlRun();
  const stats = { itemsProcessed: 0, optionsProcessed: 0, errors: 0 };

  try {

    let listings;
    if (fs.existsSync('listings.json')) {
      console.log('Loading listings from listings.json...');
      listings = JSON.parse(fs.readFileSync('listings.json', 'utf-8'));
      console.log(`Loaded ${listings.length} items from cache.`);
    } else {
      console.log('Fetching listings...');
      listings = await fetchAllListings();
      console.log(`Found ${listings.length} items across all pages.`);
      fs.writeFileSync('listings.json', JSON.stringify(listings, null, 2));
      console.log('Wrote listings.json');
    }

    const browser = await getBrowser();
    const limit = pLimit(3);

    await Promise.all(
      listings.map((listing) =>
        limit(async () => {
          const activeBrowser = browser.isConnected() ? browser : await getBrowser();
          await processItem(activeBrowser, listing, stats);
        })
      )
    );


    // const browser = await getBrowser();
    //
    // for (const listing of listings) {
    //   const activeBrowser = browser.isConnected() ? browser : await getBrowser();
    //   await processItem(activeBrowser, listing, stats);
    // }
    //
    await finishCrawlRun(runId, { ...stats, status: 'completed' });
    console.log('Crawl completed:', stats);
  } catch (err) {
    await finishCrawlRun(runId, { ...stats, status: 'failed' }).catch(() => {});
    console.error('Crawl failed:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Entrypoint — single run, exits when done
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      await runCrawl();
    } catch (err) {
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  })();
}

module.exports = { runCrawl, getBrowser, closeBrowser };
