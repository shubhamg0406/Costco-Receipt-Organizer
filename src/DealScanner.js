const https = require("https");
const crypto = require("crypto");

const DEFAULT_SOURCES = [
  { name: "CocoWest", home: "https://cocowest.ca/", regions: ["BC", "AB", "SK", "MB"], market: "CA" },
  { name: "CocoEast", home: "https://cocoeast.ca/", regions: ["ON", "QC", "NB", "NS", "NL", "PE"], market: "CA" }
];
const US_WAREHOUSE_SAVINGS = {
  name: "Costco US Warehouse Savings",
  page: "https://www.costco.com/o/-/warehouse-savings",
  regions: [],
  market: "US"
};

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "User-Agent": "Costco Receipt Organizer local price checker/1.0",
        Accept: "text/html,application/xhtml+xml"
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
        response.resume();
        return resolve(fetchText(new URL(response.headers.location, url).href, redirects + 1));
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`${new URL(url).hostname} returned ${response.statusCode}.`));
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error(`${new URL(url).hostname} timed out.`)));
    request.on("error", reject);
  });
}

function attribute(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function discoverDealPages(html, home, limit = 3) {
  const links = [];
  for (const match of String(html).matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)) {
    const raw = decodeHtml(match[1] || match[2]);
    let url;
    try { url = new URL(raw, home); } catch { continue; }
    if (url.origin !== new URL(home).origin) continue;
    if (!/(?:costco-(?:flyer|sale-items)|weekend-update|unadvertised-sales)/i.test(url.pathname)) continue;
    url.hash = "";
    const href = url.href;
    if (!links.includes(href)) links.push(href);
    if (links.length >= limit) break;
  }
  return links;
}

function parseCaption(caption) {
  const text = decodeHtml(caption).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const match = text.match(/^(\d{4,})\s+(.+?)\s+\(\$?([\d,]+(?:\.\d{1,2})?)\s+(?:INSTANT\s+)?(?:SAVINGS|OFF)(?:\s+EXPIRES(?:\s+ON)?\s+(\d{4}-\d{2}-\d{2}))?\)\s+\$?([\d,]+(?:\.\d{1,2})?)(?:\s|$)/i);
  if (!match) return null;
  const savings = Number(match[3].replace(/,/g, ""));
  const salePrice = Number(match[5].replace(/,/g, ""));
  if (!Number.isFinite(savings) || !Number.isFinite(salePrice)) return null;
  return {
    itemNumber: match[1],
    name: match[2].trim(),
    savings: roundMoney(savings),
    salePrice: roundMoney(salePrice),
    regularPrice: roundMoney(salePrice + savings),
    expiresOn: match[4] || null,
    caption: text
  };
}

function parseDealPage(html, pageUrl, source = {}) {
  const deals = [];
  for (const imageMatch of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const tag = imageMatch[0];
    const parsed = parseCaption(attribute(tag, "alt"));
    if (!parsed) continue;
    const imageUrl = attribute(tag, "data-src") || attribute(tag, "src");
    const id = crypto.createHash("sha256").update(`${source.name}|${parsed.itemNumber}|${parsed.salePrice}|${parsed.expiresOn || pageUrl}`).digest("hex").slice(0, 20);
    deals.push({
      id: `deal-${id}`,
      ...parsed,
      imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
      pageUrl,
      source: source.name || "Costco deal source",
      regions: source.regions || [],
      market: source.market || "CA",
      scannedAt: new Date().toISOString()
    });
  }
  return deals;
}

function isoUsDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

function textContent(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseUsWarehouseSavings(html, pageUrl = US_WAREHOUSE_SAVINGS.page) {
  const source = US_WAREHOUSE_SAVINGS;
  const pageText = textContent(html);
  const validity = pageText.match(/\bValid\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const expiresOn = isoUsDate(validity?.[2]);
  const blocks = String(html).split(/<div\b[^>]*data-testid=["']Grid["'][^>]*>/i).slice(1);
  const deals = [];

  for (const block of blocks) {
    const itemNumber = block.match(/>\s*Item\s+(\d{4,})\s*</i)?.[1];
    if (!itemNumber) continue;
    const priceBlock = block.match(/data-testid=["']Text_prices_and_percentages_prices["'][^>]*>([\s\S]{0,1200}?)<\/p>/i)?.[1] || "";
    const salePriceMatch = textContent(priceBlock).replace(/\s+/g, "").match(/\$([\d,]+(?:\.\d{1,2})?)/);
    const appendBlock = block.match(/data-testid=["']Text_prices_and_percentages_append_text["'][^>]*>([\s\S]{0,500}?)<\/div>/i)?.[1] || "";
    const savingsMatch = textContent(appendBlock).match(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*OFF\b/i);
    if (!salePriceMatch || !savingsMatch) continue;
    const salePrice = Number(salePriceMatch[1].replace(/,/g, ""));
    const savings = Number(savingsMatch[1].replace(/,/g, ""));
    if (!Number.isFinite(salePrice) || !Number.isFinite(savings) || savings <= 0) continue;

    const imageTag = block.match(/<img\b[^>]*>/i)?.[0] || "";
    const name = attribute(imageTag, "alt") || textContent(block.match(/data-testid=["']Text["'][^>]*>([^<]{3,180})<\/div>/i)?.[1]);
    if (!name) continue;
    const imageUrl = attribute(imageTag, "src");
    const productLink = decodeHtml(block.match(/\bhref=["'](https:\/\/www\.costco\.com\/p\/[^"']+)["']/i)?.[1] || "");
    const id = crypto.createHash("sha256").update(`${source.name}|${itemNumber}|${salePrice}|${expiresOn || pageUrl}`).digest("hex").slice(0, 20);
    deals.push({
      id: `deal-${id}`,
      itemNumber,
      name: textContent(name),
      savings: roundMoney(savings),
      salePrice: roundMoney(salePrice),
      regularPrice: roundMoney(salePrice + savings),
      expiresOn,
      caption: `${textContent(name)} · ${textContent(appendBlock)}`,
      imageUrl: /^https?:\/\//i.test(imageUrl) ? imageUrl : "",
      productUrl: productLink,
      pageUrl,
      source: source.name,
      regions: [],
      market: "US",
      scannedAt: new Date().toISOString()
    });
  }
  return deals;
}

function dedupeDeals(deals) {
  const byKey = new Map();
  for (const deal of deals) {
    const key = `${deal.market || "CA"}|${deal.itemNumber}|${deal.salePrice}|${deal.expiresOn || ""}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.imageUrl && deal.imageUrl)) byKey.set(key, deal);
  }
  return [...byKey.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function scanDeals(options = DEFAULT_SOURCES) {
  const market = Array.isArray(options) ? "CA" : String(options?.market || "CA").toUpperCase() === "US" ? "US" : "CA";
  const sources = Array.isArray(options) ? options : DEFAULT_SOURCES;
  const deals = [];
  const pages = [];
  const errors = [];
  if (market === "US") {
    try {
      const pageDeals = parseUsWarehouseSavings(await fetchText(US_WAREHOUSE_SAVINGS.page), US_WAREHOUSE_SAVINGS.page);
      deals.push(...pageDeals);
      pages.push({ source: US_WAREHOUSE_SAVINGS.name, url: US_WAREHOUSE_SAVINGS.page, dealCount: pageDeals.length });
    } catch (error) {
      errors.push({ source: US_WAREHOUSE_SAVINGS.name, url: US_WAREHOUSE_SAVINGS.page, error: error.message });
    }
  }
  for (const source of market === "CA" ? sources : []) {
    try {
      const homepage = await fetchText(source.home);
      const sourcePages = discoverDealPages(homepage, source.home);
      if (!sourcePages.length) throw new Error(`No current deal pages were found on ${source.name}.`);
      for (const pageUrl of sourcePages) {
        try {
          const pageDeals = parseDealPage(await fetchText(pageUrl), pageUrl, source);
          deals.push(...pageDeals);
          pages.push({ source: source.name, url: pageUrl, dealCount: pageDeals.length });
        } catch (error) {
          errors.push({ source: source.name, url: pageUrl, error: error.message });
        }
      }
    } catch (error) {
      errors.push({ source: source.name, url: source.home, error: error.message });
    }
  }
  const uniqueDeals = dedupeDeals(deals);
  if (!uniqueDeals.length) throw new Error(errors[0]?.error || "No current Costco deals could be read.");
  return { deals: uniqueDeals, pages, errors, scannedAt: new Date().toISOString(), market };
}

const STOP_WORDS = new Set(["and", "the", "with", "pack", "case", "each", "of", "x", "g", "kg", "ml", "l"]);

function nameTokens(value) {
  return new Set(String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(token => token.length > 1 && !STOP_WORDS.has(token)));
}

function nameScore(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter(token => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

function receiptDateValue(receipt) {
  const value = Date.parse(`${receipt.date || ""}T12:00:00`);
  return Number.isNaN(value) ? 0 : value;
}

function receiptMarket(receipt) {
  const country = String(receipt?.country || "").toUpperCase();
  if (country === "US" || country === "CA") return country;
  if (!receipt?.state) return "CA";
  return /^(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/i.test(String(receipt?.state || "")) ? "CA" : "US";
}

function dealAppliesToReceipt(deal, receipt, market) {
  if (market && receiptMarket(receipt) !== market) return false;
  if (deal.market && deal.market !== receiptMarket(receipt)) return false;
  const regions = Array.isArray(deal.regions) ? deal.regions : [];
  return !regions.length || !receipt.state || regions.includes(String(receipt.state).toUpperCase());
}

function buildPriceMatches(receipts = [], deals = [], options = {}) {
  const today = options.today ? new Date(`${options.today}T12:00:00`) : new Date();
  const horizonDays = Number(options.days || 30);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - horizonDays);
  const market = String(options.market || "").toUpperCase() === "US" ? "US" : String(options.market || "").toUpperCase() === "CA" ? "CA" : null;
  const activeDeals = deals.filter(deal => (!market || !deal.market || deal.market === market) && (!deal.expiresOn || Date.parse(`${deal.expiresOn}T23:59:59`) >= today.valueOf()));
  const matches = [];
  const alreadySaved = [];

  for (const receipt of receipts) {
    if (market && receiptMarket(receipt) !== market) continue;
    if (receiptDateValue(receipt) < cutoff.valueOf() || receiptDateValue(receipt) > today.valueOf() + 86400000) continue;
    const applicableDeals = activeDeals.filter(deal => dealAppliesToReceipt(deal, receipt, market));
    const exactDeals = new Map(applicableDeals.map(deal => [String(deal.itemNumber || "").replace(/^0+/, ""), deal]));
    for (const item of receipt.items || []) {
      if (item.eventType !== "purchase" || Number(item.amount || 0) <= 0) continue;
      const purchasedQuantity = Math.max(1, Number(item.quantity || 1));
      const quantity = Math.max(0, Number(item.remainingQuantity ?? purchasedQuantity));
      if (quantity <= 0) continue;
      const paidPerUnit = roundMoney(Number(item.amount || 0) / purchasedQuantity);
      if (Number(item.discount || 0) < 0) {
        alreadySaved.push({ receiptId: receipt.id, itemId: item.id, itemNumber: item.itemNumber, name: item.name, date: receipt.date, saved: roundMoney((Math.abs(item.discount) / purchasedQuantity) * quantity), quantity });
      }
      const itemNumber = String(item.itemNumber || "").replace(/^0+/, "");
      let deal = exactDeals.get(itemNumber);
      let confidence = "exact item number";
      let score = 1;
      if (!deal && item.name) {
        const ranked = applicableDeals.map(candidate => ({ candidate, score: nameScore(item.name, candidate.name) })).sort((a, b) => b.score - a.score)[0];
        if (ranked?.score >= 0.75) {
          deal = ranked.candidate;
          confidence = "name match — review";
          score = ranked.score;
        }
      }
      if (!deal || Number(deal.salePrice) >= paidPerUnit - 0.01) continue;
      const potentialPerUnit = roundMoney(paidPerUnit - Number(deal.salePrice));
      matches.push({
        id: `${receipt.id}:${item.id}:${deal.id}`,
        receiptId: receipt.id,
        itemId: item.id,
        itemNumber: item.itemNumber,
        name: item.name,
        date: receipt.date,
        store: receipt.store,
        quantity,
        paidPerUnit,
        salePrice: Number(deal.salePrice),
        potentialPerUnit,
        potentialSavings: roundMoney(potentialPerUnit * quantity),
        confidence,
        confidenceScore: score,
        deal
      });
    }
  }

  matches.sort((a, b) => b.potentialSavings - a.potentialSavings);
  alreadySaved.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    matches,
    alreadySaved,
    potentialSavings: roundMoney(matches.reduce((sum, match) => sum + match.potentialSavings, 0)),
    appliedSavings: roundMoney(alreadySaved.reduce((sum, item) => sum + item.saved, 0)),
    scannedDealCount: activeDeals.length,
    horizonDays,
    market: market || null,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  DEFAULT_SOURCES,
  buildPriceMatches,
  decodeHtml,
  dedupeDeals,
  discoverDealPages,
  fetchText,
  nameScore,
  parseCaption,
  parseDealPage,
  parseUsWarehouseSavings,
  scanDeals
};
