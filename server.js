const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const childProcess = require("child_process");
const pdf = require("pdfdataextract");
const { CostcoReceiptParser } = require("./src/CostcoReceiptParser");
const {
  convertDigitalReceipt,
  inferQuantity,
  matchesExistingReceipt,
  rebaseItemIds
} = require("./src/DigitalReceiptImporter");
const { buildPriceMatches, scanDeals } = require("./src/DealScanner");
const { normalizeHistoryName, reconcileHistory } = require("./src/ReceiptHistory");
const SCHEMA_VERSION = 14;

console.debug = function() {};

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = process.env.COSTCO_RECEIPTS_DIR || path.join(ROOT, ".costco-data");
const RECEIPTS_DIR = path.join(DATA_DIR, "receipts");
const RAW_RECEIPTS_DIR = path.join(DATA_DIR, "raw-receipts");
const INDEX_PATH = path.join(DATA_DIR, "index.json");
const OCR_SOURCE_PATH = process.env.COSTCO_RECEIPT_ORGANIZER_OCR_SOURCE || path.join(ROOT, "ocr.swift");

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
fs.mkdirSync(RAW_RECEIPTS_DIR, { recursive: true });

function readIndex() {
  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch {
    index = { schemaVersion: SCHEMA_VERSION, receipts: [] };
  }
  ensureLibraryData(index);
  return index;
}

function writeIndex(index) {
  ensureLibraryData(index);
  fs.writeFileSync(INDEX_PATH, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...index }, null, 2));
}

function ensureLibraryData(index) {
  if (!Array.isArray(index.receipts)) index.receipts = [];
  const legacyDeals = Array.isArray(index.deals) ? index.deals : [];
  const legacyDealScan = index.dealScan && typeof index.dealScan === "object" ? index.dealScan : null;
  const legacySync = index.sync && typeof index.sync === "object" ? index.sync : null;
  if (!index.settings || typeof index.settings !== "object") index.settings = {};
  index.settings.market = normalizeMarket(index.settings.market);
  if (!index.dealsByMarket || typeof index.dealsByMarket !== "object") {
    index.dealsByMarket = { CA: legacyDeals.map(deal => ({ ...deal, market: deal.market || "CA" })), US: [] };
  }
  if (!Array.isArray(index.dealsByMarket.CA)) index.dealsByMarket.CA = [];
  if (!Array.isArray(index.dealsByMarket.US)) index.dealsByMarket.US = [];
  if (!index.dealScans || typeof index.dealScans !== "object") {
    index.dealScans = { CA: legacyDealScan || emptyDealScan("CA"), US: emptyDealScan("US") };
  }
  if (!index.dealScans.CA) index.dealScans.CA = emptyDealScan("CA");
  if (!index.dealScans.US) index.dealScans.US = emptyDealScan("US");
  if (!index.syncByMarket || typeof index.syncByMarket !== "object") {
    index.syncByMarket = { CA: legacySync || emptySync("CA"), US: emptySync("US") };
  }
  if (!index.syncByMarket.CA) index.syncByMarket.CA = emptySync("CA");
  if (!index.syncByMarket.US) index.syncByMarket.US = emptySync("US");
  delete index.deals;
  delete index.dealScan;
  delete index.sync;
  ensureProductCatalog(index);
  return index;
}

function normalizeMarket(value) {
  return ["US", "USA", "UNITED STATES"].includes(String(value || "").trim().toUpperCase()) ? "US" : "CA";
}

function emptySync(market) {
  return { market, status: "never", lastSyncedAt: null, receiptCount: 0, lastError: null, identity: { email: "", membershipNumber: "" } };
}

function emptyDealScan(market) {
  return { market, status: "never", scannedAt: null, pages: [], errors: [] };
}

function productKey(item) {
  return item.itemNumber || `name:${normalizeHistoryName(item.name)}`;
}

function ensureProductCatalog(index) {
  if (!index.products || typeof index.products !== "object") index.products = {};
  for (const receipt of index.receipts || []) {
    for (const item of receipt.items || []) {
      const key = productKey(item);
      if (!index.products[key]) {
        index.products[key] = {
          key,
          itemNumber: item.itemNumber,
          canonicalName: item.name,
          brand: "",
          category: "",
          imageUrl: "",
          productUrl: "",
          source: "Receipt name",
          enrichmentStatus: "needs-enrichment",
          lookupStatus: "pending",
          lookupAttemptedAt: null,
          updatedAt: null
        };
      }
      const product = index.products[key];
      if (!product.lookupStatus) product.lookupStatus = product.productUrl ? "matched" : "pending";
      if (product.lookupAttemptedAt === undefined) product.lookupAttemptedAt = null;
      product.enrichmentStatus = product.source === "Receipt name" ? "needs-enrichment" : "enriched";
    }
  }
  return index;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatDate(dateString) {
  if (!dateString) return null;
  const match = String(dateString).trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!match) return dateString;
  const year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : "2024";
  return `${year}-${String(match[1]).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

function safeStore(parser) {
  try { return parser.getStore(); } catch { return {}; }
}

function parsePages(parser, pages) {
  const transactions = [];
  pages.forEach((page, pageIndex) => page.split("\n").forEach((line, lineNumber) => {
    if (!line) return;
    const transaction = parser.parseLine(line);
    if (transaction) transactions.push({ ...transaction, sourceLine: line, pageNumber: pageIndex + 1, lineNumber: lineNumber + 1 });
  }));
  return transactions;
}

function finalizeItem(item) {
  const adjustmentTotal = item.adjustments.reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
  item.discount = roundMoney(item.adjustments.filter(adjustment => adjustment.type === "discount").reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0));
  item.fees = roundMoney(item.adjustments.filter(adjustment => adjustment.type === "fee" || adjustment.type === "surcharge").reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0));
  item.otherAdjustments = roundMoney(item.adjustments.filter(adjustment => !["discount", "fee", "surcharge"].includes(adjustment.type)).reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0));
  item.amount = roundMoney(item.grossAmount + adjustmentTotal);
  item.adjustmentTotal = roundMoney(adjustmentTotal);
  return item;
}

function adjustmentFrom(raw) {
  const source = `${raw.sourceLine || ""} ${raw.itemName || ""}`.toUpperCase();
  const isFee = /DEPOSIT|FEE|ENVIRO|ENVIRONMENT|CLN|CLT/.test(source);
  const amount = Number(raw.amount || 0);
  return {
    amount,
    type: isFee ? "fee" : (amount < 0 ? "discount" : "surcharge"),
    label: isFee ? "Fee / deposit" : (amount < 0 ? "Discount" : "Adjustment"),
    sourceLine: raw.sourceLine
  };
}

function isPriceAdjustment(raw) {
  const name = String(raw.itemName || "").trim().toUpperCase();
  const source = String(raw.sourceLine || "").toUpperCase();
  return name.startsWith("TPD/") || source.includes(" TPD/") || /CPN\/E\/(RETUNR|RETURN)/.test(`${name} ${source}`);
}

function findAdjustmentTarget(items, raw) {
  const preferredType = Number(raw.amount || 0) > 0 ? "refund" : "purchase";
  return [...items].reverse().find(item => item.eventType === preferredType)
    || [...items].reverse().find(item => item.eventType === "refund" || item.eventType === "purchase");
}

function attachAdjustment(target, raw, type, label) {
  target.adjustments.push({ amount: Number(raw.amount || 0), type, label, sourceLine: raw.sourceLine });
  return finalizeItem(target);
}

function makeItem(raw, identifier, isReturn) {
  const item = {
    itemNumber: identifier,
    name: String(raw.itemName || "Unidentified item").trim(),
    quantity: Number(raw.quantity || 1),
    unitAmount: Number(raw.unitAmount ?? raw.amount ?? 0),
    grossAmount: Number(raw.amount || 0),
    amount: Number(raw.amount || 0),
    discount: 0,
    fees: 0,
    adjustmentTotal: 0,
    adjustments: [],
    taxable: raw.isTaxable !== false,
    eventType: isReturn ? "refund" : "purchase",
    status: isReturn ? "returned" : "active",
    pageNumber: raw.pageNumber,
    lineNumber: raw.lineNumber,
    sourceLine: raw.sourceLine
  };
  return finalizeItem(item);
}

function ocrPages(buffer, id) {
  const sourcePath = path.join(DATA_DIR, `${id}-ocr.pdf`);
  const helperPath = path.join(DATA_DIR, "receipt-ocr");
  try {
    fs.writeFileSync(sourcePath, buffer);
    if (!fs.existsSync(helperPath)) {
      childProcess.execFileSync("swiftc", [OCR_SOURCE_PATH, "-o", helperPath], { stdio: "ignore", timeout: 120000 });
    }
    const output = childProcess.execFileSync(helperPath, [sourcePath], { encoding: "utf8", timeout: 120000 });
    return output.split("\n---PAGE---\n").filter(Boolean);
  } catch (error) {
    console.warn("OCR fallback unavailable:", error.message);
    return [];
  } finally {
    try { fs.unlinkSync(sourcePath); } catch {}
  }
}

async function parseReceipt(buffer, fileName, id, hash) {
    let pages = [];
    try {
      const data = await pdf.PdfData.extract(buffer);
      pages = data.text || [];
    } catch (error) {
      console.warn("PDF text extraction unavailable; trying OCR.", error.message);
    }
    let parser = new CostcoReceiptParser();
    let transactions = parsePages(parser, pages);
    let usedOcr = false;
    if (!transactions.length) {
      pages = ocrPages(buffer, id);
      if (pages.length) {
        parser = new CostcoReceiptParser();
        transactions = parsePages(parser, pages);
        usedOcr = true;
      }
    }

    const taxLine = transactions.find(item => item.itemIdentifier === "TAX");
    const rawItems = transactions.filter(item => item.itemIdentifier !== "TAX");
    const items = [];
    const byIdentifier = new Map();

    for (const raw of rawItems) {
      const identifier = String(raw.itemIdentifier || "");
      if (isPriceAdjustment(raw)) {
        const target = findAdjustmentTarget(items, raw);
        if (target) attachAdjustment(target, raw, target.eventType === "refund" ? "refund-adjustment" : "discount", target.eventType === "refund" ? "Return adjustment" : "Discount");
        else items.push(finalizeItem({
          ...makeItem({ ...raw, amount: 0 }, identifier, false),
          name: String(raw.itemName || "Return adjustment").trim(),
          eventType: "adjustment",
          status: "adjustment",
          grossAmount: 0,
          adjustments: [{ amount: Number(raw.amount || 0), type: "discount", label: "Discount / return adjustment", sourceLine: raw.sourceLine }]
        }));
        continue;
      }
      if (identifier.startsWith("D-")) {
        const base = identifier.slice(2);
        const targets = byIdentifier.get(base) || [];
        const target = targets[targets.length - 1];
        if (target) {
          target.adjustments.push(adjustmentFrom(raw));
          finalizeItem(target);
        } else {
          const adjustment = adjustmentFrom(raw);
          items.push(finalizeItem({
            ...makeItem({ ...raw, amount: 0 }, base, false),
            name: String(raw.itemName || "Receipt adjustment").trim(),
            eventType: "adjustment",
            status: "adjustment",
            grossAmount: 0,
            adjustments: [adjustment]
          }));
        }
        continue;
      }

      const isReturn = identifier.startsWith("R-");
      const itemNumber = isReturn ? identifier.slice(2) : identifier;
      const item = makeItem(raw, itemNumber, isReturn);
      items.push(item);
      const targets = byIdentifier.get(itemNumber) || [];
      targets.push(item);
      byIdentifier.set(itemNumber, targets);
    }

    const total = Number(parser.getTotal() || 0);
    const tax = Number(parser.getTax() || taxLine?.amount || 0);
    const subtotal = Number(parser.getSubtotal() || (total - tax));
    const taxableItems = items.filter(item => item.taxable && item.amount !== 0);
    const taxableBase = taxableItems.reduce((sum, item) => sum + Math.abs(item.amount), 0);
    const allocationItems = taxableBase ? taxableItems : items.filter(item => item.amount !== 0);
    const allocationBase = allocationItems.reduce((sum, item) => sum + Math.abs(item.amount), 0);
    const lastAllocationIndex = items.reduce((last, item, index) => allocationItems.includes(item) ? index : last, -1);
    let allocatedTax = 0;
    items.forEach((item, index) => {
      const share = allocationItems.includes(item) && allocationBase ? Math.abs(item.amount) / allocationBase : 0;
      item.allocatedTax = index === lastAllocationIndex
        ? roundMoney(tax - allocatedTax)
        : roundMoney(tax * share);
      allocatedTax = roundMoney(allocatedTax + item.allocatedTax);
      item.total = roundMoney(item.amount + item.allocatedTax);
      item.taxLabel = taxLine ? "Allocated tax" : "Allocated tax";
      item.id = `${id}-${index}`;
    });

    const store = safeStore(parser);
    const receipt = {
      id,
      fileName,
      hash,
      date: formatDate(parser.getDate()),
      store: store.store || "Costco warehouse",
      city: store.city,
      state: store.state,
      country: store.country,
      transactionNumber: parser.getReceiptIdentifier() || "—",
      subtotal: roundMoney(subtotal),
      tax: roundMoney(tax),
      total: roundMoney(total),
      items,
      itemCount: items.reduce((sum, item) => sum + Number(item.quantity || 1), 0),
      receiptType: total < 0 ? "refund" : "purchase",
      status: "indexed",
      confidence: Math.abs(roundMoney(items.reduce((sum, item) => sum + item.total, 0) - total)) < 0.02 ? "high" : "review",
      extractionMethod: usedOcr ? "OCR" : "PDF text",
      importedAt: new Date().toISOString()
    };
    return receipt;
}

function storedDigitalRaw(receipt) {
  const storedName = receipt?.source?.rawStoredName;
  if (!storedName) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(RAW_RECEIPTS_DIR, path.basename(storedName)), "utf8"));
  } catch {
    return null;
  }
}

function storedMembershipNumber(receipt, raw = storedDigitalRaw(receipt)) {
  return String(receipt?.membershipNumber || raw?.membershipNumber || "").trim();
}

async function migrateLibrary() {
  const index = readIndex();
  if (index.schemaVersion >= SCHEMA_VERSION) return;
  const receipts = (index.receipts || []).map(existing => {
    const raw = storedDigitalRaw(existing);
    const items = (existing.items || []).map(item => {
      const grossAmount = item.grossAmount ?? item.amount;
      const rawItem = Number.isInteger(item.sourceIndex) ? raw?.itemArray?.[item.sourceIndex] : null;
      const quantity = rawItem
        ? inferQuantity(rawItem, Number(grossAmount || 0), Number(rawItem.itemUnitPriceAmount || 0))
        : Number(item.quantity || 1);
      return {
        ...item,
        grossAmount,
        quantity,
        unitAmount: quantity > 0 ? roundMoney(Number(grossAmount || 0) / quantity) : item.amount,
        eventType: item.eventType || (item.status === "returned" || Number(item.amount) < 0 ? "refund" : "purchase"),
        adjustments: item.adjustments || (item.discount ? [{ amount: item.discount, type: "discount", label: "Discount" }] : []),
        adjustmentTotal: item.adjustmentTotal ?? item.discount ?? 0,
        fees: item.fees ?? 0
      };
    });
    const rawItemCount = Math.abs(Number(raw?.totalItemCount || 0));
    return {
      ...existing,
      schemaVersion: SCHEMA_VERSION,
      country: normalizeMarket(existing.country || (costcoDomainForReceipt(existing) === "Costco.ca" ? "CA" : "US")),
      membershipNumber: storedMembershipNumber(existing, raw),
      receiptType: existing.receiptType || (Number(existing.total) < 0 ? "refund" : "purchase"),
      itemCount: rawItemCount || items.reduce((sum, item) => sum + Number(item.quantity || 1), 0),
      items
    };
  });
  for (const market of ["CA", "US"]) {
    const sync = index.syncByMarket[market] || emptySync(market);
    const membershipNumber = receipts.find(receipt => receipt.country === market && receipt.membershipNumber)?.membershipNumber || sync.identity?.membershipNumber || "";
    index.syncByMarket[market] = {
      ...sync,
      market,
      identity: { email: String(sync.identity?.email || ""), membershipNumber: String(membershipNumber) }
    };
  }
  reconcileHistory(receipts);
  writeIndex({ ...index, schemaVersion: SCHEMA_VERSION, receipts });
  if (receipts.length) console.log(`Updated ${receipts.length} receipt${receipts.length === 1 ? "" : "s"} to library schema ${SCHEMA_VERSION}.`);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function bodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) reject(new Error("Receipt is larger than 30 MB."));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing upload boundary.");
  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const start = buffer.indexOf(Buffer.from("\r\n\r\n"));
  if (start === -1) throw new Error("Invalid upload.");
  const headerStart = buffer.indexOf(boundary) + boundary.length + 2;
  const headers = buffer.slice(headerStart, start).toString("utf8");
  const fileNameMatch = headers.match(/filename="([^"]+)"/i);
  const fileStart = start + 4;
  const fileEnd = buffer.indexOf(Buffer.from(`\r\n${boundary.toString("utf8")}`), fileStart);
  if (!fileNameMatch || fileEnd === -1) throw new Error("No PDF file found.");
  return { fileName: path.basename(fileNameMatch[1]), buffer: buffer.slice(fileStart, fileEnd) };
}

function publicReceipt(receipt, index) {
  return {
    ...receipt,
    items: (receipt.items || []).map(item => ({ ...item, product: index.products[productKey(item)] || null })),
    hasDocument: Boolean(receiptFilePath(receipt)),
    pdfUrl: receiptFilePath(receipt) ? `/api/receipts/${receipt.id}/file` : null
  };
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function fetchSearchRss(query) {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "Costco Receipt Organizer local library" } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Search returned ${response.statusCode}.`));
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.setTimeout(12000, () => request.destroy(new Error("Search timed out.")));
    request.on("error", reject);
  });
}

function costcoDomainForReceipt(receipt) {
  if (receipt?.country === "US") return "Costco.com";
  if (receipt?.country === "CA") return "Costco.ca";
  const location = `${receipt?.store || ""} ${receipt?.state || ""}`.toUpperCase();
  const canadianProvince = /\b(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/.test(location);
  return canadianProvince ? "Costco.ca" : "Costco.com";
}

function firstCostcoSearchResult(xml, domain) {
  const expectedDomain = String(domain || "Costco.ca").toLowerCase();
  const results = [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => {
    const block = match[1];
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
    const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1]).trim();
    const description = decodeXml(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1]);
    return { title, link, description };
  });
  return results.find(result => {
    try {
      const parsed = new URL(result.link);
      const hostname = parsed.hostname.toLowerCase();
      const domainMatches = hostname === expectedDomain || hostname.endsWith(`.${expectedDomain}`);
      return domainMatches
        && (/\/p\//i.test(parsed.pathname) || /\/products?\//i.test(parsed.pathname) || /\.product\./i.test(parsed.pathname));
    } catch {
      return false;
    }
  }) || null;
}

async function findCostcoProduct(item, receipt) {
  const itemNumber = String(item.itemNumber || "").trim();
  const name = String(item.name || "").trim();
  const domain = costcoDomainForReceipt(receipt);
  const queries = itemNumber
    ? [`${domain} Item ${itemNumber} ${name}`]
    : [`${domain} ${name}`];
  for (const query of queries) {
    try {
      const result = firstCostcoSearchResult(await fetchSearchRss(query), domain);
      if (result) return { ...result, query, domain };
    } catch (error) {
      console.warn("Automatic product lookup failed:", error.message);
    }
  }
  return null;
}

function receiptFilePath(receipt) {
  if (!receipt?.storedName) return null;
  const filePath = path.join(RECEIPTS_DIR, path.basename(receipt.storedName));
  return fs.existsSync(filePath) ? filePath : null;
}

function saveDigitalReceipt(index, raw, market) {
  const syncMarket = normalizeMarket(market || raw.warehouseCountry);
  const normalizedRaw = {
    ...raw,
    warehouseCountry: raw.warehouseCountry || syncMarket,
    currencyCode: raw.currencyCode || (syncMarket === "US" ? "USD" : "CAD")
  };
  const candidate = convertDigitalReceipt(normalizedRaw);
  candidate.source.market = syncMarket;
  const rawStoredName = `${candidate.id}.json`;
  fs.writeFileSync(path.join(RAW_RECEIPTS_DIR, rawStoredName), JSON.stringify(normalizedRaw, null, 2));
  candidate.source.rawStoredName = rawStoredName;

  const existingIndex = index.receipts.findIndex(receipt => (!receipt.country || receipt.country === candidate.country) && matchesExistingReceipt(receipt, candidate));
  const existing = existingIndex >= 0 ? index.receipts[existingIndex] : null;
  let action = "added";
  let receipt = candidate;

  if (existing) {
    const existingPdf = receiptFilePath(existing);
    const wasCostcoDigital = Boolean(existing.source?.key);
    const generatedPdf = Boolean(existing.source?.generatedPdf);
    receipt = rebaseItemIds({
      ...candidate,
      id: existing.id,
      fileName: existingPdf ? existing.fileName : candidate.fileName,
      hash: existingPdf ? existing.hash : candidate.hash,
      storedName: existingPdf ? existing.storedName : undefined,
      importedAt: existing.importedAt || candidate.importedAt,
      extractionMethod: existingPdf && !generatedPdf
        ? "Costco digital receipt + original PDF"
        : candidate.extractionMethod,
      source: {
        ...candidate.source,
        type: existingPdf && !generatedPdf ? "manual+costco-digital" : "costco-digital",
        generatedPdf: existingPdf ? generatedPdf : true,
        originalFileName: existingPdf && !generatedPdf ? existing.fileName : undefined
      }
    }, existing.id);
    index.receipts[existingIndex] = receipt;
    action = wasCostcoDigital ? "updated" : "merged";
  } else {
    index.receipts.unshift(receipt);
  }

  index.syncByMarket[syncMarket] = {
    ...(index.syncByMarket[syncMarket] || emptySync(syncMarket)),
    market: syncMarket,
    status: "syncing",
    lastError: null,
    currentReceiptDate: receipt.date
  };
  reconcileHistory(index.receipts);
  ensureProductCatalog(index);
  const needsPdf = !receiptFilePath(receipt);
  return { receipt, action, needsPdf };
}

function updateSyncStatus(index, market, updates) {
  const normalized = normalizeMarket(market);
  index.syncByMarket[normalized] = { ...(index.syncByMarket[normalized] || emptySync(normalized)), market: normalized, ...updates };
  return index.syncByMarket[normalized];
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    const index = readIndex();

    if (pathname === "/api/settings" && req.method === "GET") {
      return json(res, 200, { settings: index.settings });
    }

    if (pathname === "/api/settings" && req.method === "PATCH") {
      const updates = JSON.parse((await bodyBuffer(req)).toString("utf8") || "{}");
      if (updates.market !== undefined && !["CA", "US"].includes(String(updates.market).toUpperCase())) {
        return json(res, 400, { error: "Market must be CA or US." });
      }
      if (updates.market !== undefined) index.settings.market = normalizeMarket(updates.market);
      writeIndex(index);
      return json(res, 200, { settings: index.settings });
    }

    if (pathname === "/api/sync/status" && req.method === "GET") {
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      return json(res, 200, { sync: index.syncByMarket[market], syncByMarket: index.syncByMarket, settings: index.settings });
    }

    if (pathname === "/api/sync/costco-receipt" && req.method === "POST") {
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      const raw = JSON.parse((await bodyBuffer(req)).toString("utf8") || "{}");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "A Costco digital receipt is required." });
      const result = saveDigitalReceipt(index, raw, market);
      writeIndex(index);
      return json(res, result.action === "added" ? 201 : 200, {
        ...result,
        receipt: publicReceipt(result.receipt, index)
      });
    }

    const syncPdfMatch = pathname.match(/^\/api\/sync\/costco-receipt\/([^/]+)\/pdf$/);
    if (syncPdfMatch && req.method === "PUT") {
      const id = decodeURIComponent(syncPdfMatch[1]);
      const receipt = index.receipts.find(candidate => candidate.id === id);
      if (!receipt) return json(res, 404, { error: "Receipt not found." });
      const buffer = await bodyBuffer(req);
      if (buffer.slice(0, 4).toString("ascii") !== "%PDF") return json(res, 400, { error: "The generated receipt document is not a PDF." });
      const storedName = `${id}.pdf`;
      fs.writeFileSync(path.join(RECEIPTS_DIR, storedName), buffer);
      receipt.storedName = storedName;
      receipt.hash = crypto.createHash("sha256").update(buffer).digest("hex");
      receipt.source = { ...(receipt.source || {}), generatedPdf: true, pdfGeneratedAt: new Date().toISOString() };
      writeIndex(index);
      return json(res, 200, { receipt: publicReceipt(receipt, index) });
    }

    if (pathname === "/api/sync/complete" && req.method === "POST") {
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      const summary = JSON.parse((await bodyBuffer(req)).toString("utf8") || "{}");
      const currentIdentity = index.syncByMarket[market]?.identity || {};
      const identity = {
        email: String(summary.identity?.email || currentIdentity.email || "").trim(),
        membershipNumber: String(summary.identity?.membershipNumber || currentIdentity.membershipNumber || "").trim()
      };
      const sync = updateSyncStatus(index, market, {
        status: summary.failed ? "completed-with-errors" : "complete",
        lastSyncedAt: new Date().toISOString(),
        receiptCount: Number(summary.total || index.receipts.filter(receipt => receipt.source?.key && normalizeMarket(receipt.country) === market).length),
        added: Number(summary.added || 0),
        updated: Number(summary.updated || 0),
        merged: Number(summary.merged || 0),
        failed: Number(summary.failed || 0),
        lastError: summary.lastError ? String(summary.lastError) : null,
        currentReceiptDate: null,
        identity
      });
      writeIndex(index);
      return json(res, 200, { sync });
    }

    if (pathname === "/api/deals" && req.method === "GET") {
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      return json(res, 200, { market, deals: index.dealsByMarket[market], scan: index.dealScans[market] });
    }

    if (pathname === "/api/deals/scan" && req.method === "POST") {
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      try {
        const result = await scanDeals({ market });
        // A CA and US refresh can run at the same time. Reload after the network
        // scan so one market cannot overwrite the other market's newer result.
        const latestIndex = readIndex();
        latestIndex.dealsByMarket[market] = result.deals;
        latestIndex.dealScans[market] = { market, status: result.errors.length ? "partial" : "complete", scannedAt: result.scannedAt, pages: result.pages, errors: result.errors };
        writeIndex(latestIndex);
        return json(res, 200, { market, deals: latestIndex.dealsByMarket[market], scan: latestIndex.dealScans[market] });
      } catch (error) {
        const latestIndex = readIndex();
        latestIndex.dealScans[market] = { ...(latestIndex.dealScans[market] || emptyDealScan(market)), market, status: "error", attemptedAt: new Date().toISOString(), errors: [{ error: error.message }] };
        writeIndex(latestIndex);
        return json(res, 502, { error: error.message, market, deals: latestIndex.dealsByMarket[market], scan: latestIndex.dealScans[market] });
      }
    }

    if (pathname === "/api/price-matches" && req.method === "GET") {
      const days = Math.min(90, Math.max(1, Number(requestUrl.searchParams.get("days") || 30)));
      const market = normalizeMarket(requestUrl.searchParams.get("market") || index.settings.market);
      return json(res, 200, buildPriceMatches(index.receipts, index.dealsByMarket[market], { days, market }));
    }

    if (pathname === "/api/receipts" && req.method === "GET") {
      const query = (requestUrl.searchParams.get("q") || "").toLowerCase().trim();
      const receipts = index.receipts.filter(receipt => !query || JSON.stringify(receipt).toLowerCase().includes(query));
      return json(res, 200, { receipts: receipts.map(receipt => publicReceipt(receipt, index)), dataDirectory: DATA_DIR });
    }

    if (pathname === "/api/products" && req.method === "GET") {
      return json(res, 200, { products: Object.values(index.products) });
    }

    const autoProductMatch = pathname.match(/^\/api\/products\/([^/]+)\/auto-enrich$/);
    if (autoProductMatch && req.method === "POST") {
      const key = decodeURIComponent(autoProductMatch[1]);
      let sourceReceipt;
      let sourceItem;
      for (const receipt of index.receipts || []) {
        const match = (receipt.items || []).find(item => String(item.itemNumber || "") === key);
        if (match) {
          sourceReceipt = receipt;
          sourceItem = match;
          break;
        }
      }
      sourceItem ||= { itemNumber: key, name: key };
      const existing = index.products[key] || { key, itemNumber: key, canonicalName: sourceItem.name, brand: "", category: "", imageUrl: "", productUrl: "", source: "Receipt name" };
      const result = await findCostcoProduct(sourceItem, sourceReceipt);
      if (!result) {
        existing.lookupStatus = "not-found";
        existing.lookupAttemptedAt = new Date().toISOString();
        index.products[key] = existing;
        writeIndex(index);
        return json(res, 404, { error: "No Costco product result was found.", product: existing });
      }
      const canonicalName = result.title.replace(/\s*(?:[-|]\s*)?Costco\s*$/i, "").trim();
      existing.canonicalName = canonicalName || existing.canonicalName || sourceItem.name;
      existing.productUrl = result.link;
      existing.source = "Automatic Costco search match";
      existing.enrichmentStatus = "enriched";
      existing.autoMatched = true;
      existing.matchQuery = result.query;
      existing.costcoDomain = result.domain;
      existing.lookupStatus = "matched";
      existing.lookupAttemptedAt = new Date().toISOString();
      existing.updatedAt = new Date().toISOString();
      index.products[key] = existing;
      writeIndex(index);
      return json(res, 200, { product: existing, result: { title: canonicalName, url: result.link, query: result.query, domain: result.domain } });
    }

    const productMatch = pathname.match(/^\/api\/products\/(.+)$/);
    if (productMatch && req.method === "PATCH") {
      const key = decodeURIComponent(productMatch[1]);
      const updates = JSON.parse((await bodyBuffer(req)).toString("utf8") || "{}");
      const existing = index.products[key] || { key, itemNumber: key, canonicalName: "", brand: "", category: "", imageUrl: "", productUrl: "", source: "Manual" };
      const allowed = ["canonicalName", "brand", "category", "imageUrl", "productUrl", "source", "matchQuery", "costcoDomain", "lookupStatus", "lookupAttemptedAt"];
      allowed.forEach(field => { if (updates[field] !== undefined) existing[field] = String(updates[field] || "").trim(); });
      if (updates.autoMatched !== undefined) existing.autoMatched = Boolean(updates.autoMatched);
      existing.enrichmentStatus = existing.source === "Receipt name" ? "needs-enrichment" : "enriched";
      existing.updatedAt = new Date().toISOString();
      index.products[key] = existing;
      writeIndex(index);
      return json(res, 200, { product: existing });
    }

    if (pathname === "/api/export" && req.method === "GET") {
      const body = JSON.stringify(index, null, 2);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=receipt-library-backup.json" });
      return res.end(body);
    }

    if (pathname === "/api/import" && req.method === "POST") {
      const upload = parseMultipart(await bodyBuffer(req), req.headers["content-type"] || "");
      const hash = crypto.createHash("sha256").update(upload.buffer).digest("hex");
      const duplicate = index.receipts.find(receipt => receipt.hash === hash);
      if (duplicate) return json(res, 409, { error: "This receipt is already in your library.", receipt: publicReceipt(duplicate, index) });
      const id = `${Date.now().toString(36)}-${hash.slice(0, 8)}`;
      const storedName = `${id}.pdf`;
      const receipt = await parseReceipt(upload.buffer, upload.fileName, id, hash);
      const digitalMatchIndex = index.receipts.findIndex(existing => existing.source?.key && matchesExistingReceipt(existing, receipt));
      if (digitalMatchIndex >= 0) {
        const existing = index.receipts[digitalMatchIndex];
        const originalStoredName = `${existing.id}.pdf`;
        fs.writeFileSync(path.join(RECEIPTS_DIR, originalStoredName), upload.buffer);
        existing.fileName = upload.fileName;
        existing.hash = hash;
        existing.storedName = originalStoredName;
        existing.source = {
          ...(existing.source || {}),
          type: "manual+costco-digital",
          generatedPdf: false,
          originalFileName: upload.fileName,
          originalImportedAt: new Date().toISOString()
        };
        existing.extractionMethod = "Costco digital receipt + original PDF";
        writeIndex(index);
        return json(res, 200, { receipt: publicReceipt(existing, index), merged: true });
      }
      fs.writeFileSync(path.join(RECEIPTS_DIR, storedName), upload.buffer);
      receipt.storedName = storedName;
      index.schemaVersion = SCHEMA_VERSION;
      index.receipts.unshift(receipt);
      reconcileHistory(index.receipts);
      writeIndex(index);
      return json(res, 201, { receipt: publicReceipt(receipt, index) });
    }

    const receiptMatch = pathname.match(/^\/api\/receipts\/([^/]+)$/);
    if (receiptMatch && req.method === "GET") {
      const receipt = index.receipts.find(item => item.id === receiptMatch[1]);
      return receipt ? json(res, 200, { receipt: publicReceipt(receipt, index) }) : json(res, 404, { error: "Receipt not found." });
    }

    if (receiptMatch && req.method === "PATCH") {
      const receipt = index.receipts.find(item => item.id === receiptMatch[1]);
      if (!receipt) return json(res, 404, { error: "Receipt not found." });
      const updates = JSON.parse((await bodyBuffer(req)).toString("utf8") || "{}");
      if (Array.isArray(updates.items)) {
        updates.items.forEach(update => {
          const item = receipt.items.find(candidate => candidate.id === update.id);
          if (item) {
            if (update.name) item.name = String(update.name).trim();
            if (update.itemNumber) item.itemNumber = String(update.itemNumber).trim();
          }
        });
      }
      receipt.confidence = "reviewed";
      writeIndex(index);
      return json(res, 200, { receipt: publicReceipt(receipt, index) });
    }

    const fileMatch = pathname.match(/^\/api\/receipts\/([^/]+)\/file$/);
    if (fileMatch && req.method === "GET") {
      const receipt = index.receipts.find(item => item.id === fileMatch[1]);
      if (!receipt) return json(res, 404, { error: "Receipt not found." });
      const filePath = receiptFilePath(receipt);
      if (!filePath) return json(res, 404, { error: "The receipt document has not been created yet. Run Costco Sync again." });
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${String(receipt.fileName || "Costco receipt.pdf").replace(/"/g, "")}"` });
      return fs.createReadStream(filePath).pipe(res);
    }

    if (pathname === "/api/health") return json(res, 200, { ok: true });

    const requested = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.normalize(path.join(APP_DIR, requested));
    if (!filePath.startsWith(APP_DIR)) return json(res, 403, { error: "Forbidden" });
    const ext = path.extname(filePath);
    const type = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    if (!fs.existsSync(filePath)) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": type });
    return fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 400, { error: error.message || "Request failed." });
  }
});

migrateLibrary()
  .then(() => server.listen(PORT, HOST, () => console.log(`Costco Receipt Organizer running at http://${HOST}:${PORT}`)))
  .catch(error => {
    console.error("Library migration failed:", error);
    server.listen(PORT, HOST, () => console.log(`Costco Receipt Organizer running at http://${HOST}:${PORT}`));
  });
