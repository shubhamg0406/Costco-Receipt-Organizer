const PRODUCT_NAME = "Costco Receipt Organizer";
let activeCurrency = "CAD";
const money = (value, currency = activeCurrency) => new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-CA", { style: "currency", currency }).format(Number(value || 0));
const shortDate = value => value ? new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "Unknown date";
const PAGE_SIZE = { items: 60, receipts: 50, price: 30 };

const demoReceipts = [
  { id: "demo-1", date: "2025-09-25", store: "Costco Surrey", transactionNumber: "9281", subtotal: 214.48, tax: 4.21, total: 218.69, itemCount: 6, confidence: "high", fileName: "Surrey 25-09-25.pdf", items: [
    { id: "demo-1-1", itemNumber: "1715924", name: "KIRKLAND SIGNATURE PAPER TOWELS", amount: 28.99, allocatedTax: .57, total: 29.56, taxable: true },
    { id: "demo-1-2", itemNumber: "1455231", name: "ORGANIC AVOCADOS", amount: 12.99, allocatedTax: 0, total: 12.99, taxable: false },
    { id: "demo-1-3", itemNumber: "1897722", name: "DYSON V15 DETECT", amount: 169.99, allocatedTax: 3.64, total: 173.63, taxable: true },
    { id: "demo-1-4", itemNumber: "112233", name: "KIRKLAND COFFEE", amount: 2.51, allocatedTax: 0, total: 2.51, taxable: false }
  ]},
  { id: "demo-2", date: "2025-08-13", store: "Costco Richmond", transactionNumber: "5614", subtotal: 81.92, tax: .42, total: 82.34, itemCount: 8, confidence: "high", fileName: "Richmond 13-08-25.pdf", items: [
    { id: "demo-2-1", itemNumber: "1154961", name: "KIRKLAND MOZZARELLA", amount: 15.99, allocatedTax: .08, total: 16.07, taxable: true },
    { id: "demo-2-2", itemNumber: "319376", name: "PANEER", amount: 20.99, allocatedTax: .11, total: 21.10, taxable: true },
    { id: "demo-2-3", itemNumber: "1447957", name: "ROSE ONIONS", amount: 7.99, allocatedTax: 0, total: 7.99, taxable: false }
  ]},
  { id: "demo-3", date: "2025-07-15", store: "Costco Vancouver", transactionNumber: "2076", subtotal: 143.12, tax: 7.16, total: 150.28, itemCount: 9, confidence: "review", fileName: "Vancouver 15-07-25.pdf", items: [
    { id: "demo-3-1", itemNumber: "1660213", name: "KITCHENAID MIXER", amount: 129.99, allocatedTax: 6.50, total: 136.49, taxable: true },
    { id: "demo-3-2", itemNumber: "430", name: "XL EGGS", amount: 13.13, allocatedTax: .66, total: 13.79, taxable: true }
  ]}
];

const state = {
  receipts: [],
  deals: [],
  dealScan: { status: "never", scannedAt: null },
  priceMatches: { matches: [], alreadySaved: [], potentialSavings: 0, appliedSavings: 0, scannedDealCount: 0, horizonDays: 30 },
  sync: { status: "never", lastSyncedAt: null, receiptCount: 0 },
  syncByMarket: {},
  syncProgress: null,
  market: "CA",
  receiptCart: new Set(),
  activeView: "items",
  query: "",
  itemFilter: "all",
  itemSort: { key: "date", direction: "desc" },
  itemFilters: { from: "", to: "", minPaid: "", maxPaid: "", discountedOnly: false },
  receiptFilter: "all",
  receiptSort: { key: "date", direction: "desc" },
  receiptFilters: { store: "", from: "", to: "", minTotal: "", maxTotal: "" },
  listLimits: { items: PAGE_SIZE.items, receipts: PAGE_SIZE.receipts, price: PAGE_SIZE.price },
  usingDemo: false,
  selectedItem: null
};
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const enrichmentQueue = [];
const queuedProducts = new Set();
let enrichmentWorkerRunning = false;

async function loadReceipts() {
  try {
    const [receiptResponse, settingsResponse] = await Promise.all([fetch("/api/receipts"), fetch("/api/settings")]);
    const data = await receiptResponse.json();
    const settings = settingsResponse.ok ? (await settingsResponse.json()).settings : null;
    state.receipts = data.receipts || [];
    state.market = settings?.market === "US" ? "US" : "CA";
    activeCurrency = state.market === "US" ? "USD" : "CAD";
    state.usingDemo = state.receipts.length === 0;
  } catch {
    state.receipts = demoReceipts;
    state.usingDemo = true;
  }
  state.receiptCart = new Set([...state.receiptCart].filter(id => state.receipts.some(receipt => receipt.id === id)));
  await loadSupplementalData();
  render();
  maybeScanDeals();
}

async function loadSupplementalData() {
  if (state.usingDemo) return;
  const market = state.market;
  const [syncResult, dealResult, matchResult] = await Promise.allSettled([
    fetch(`/api/sync/status?market=${market}`).then(response => response.json()),
    fetch(`/api/deals?market=${market}`).then(response => response.json()),
    fetch(`/api/price-matches?days=30&market=${market}`).then(response => response.json())
  ]);
  if (state.market !== market) return;
  if (syncResult.status === "fulfilled") {
    state.sync = syncResult.value.sync || state.sync;
    state.syncByMarket = syncResult.value.syncByMarket || state.syncByMarket;
  }
  if (dealResult.status === "fulfilled") {
    state.deals = dealResult.value.deals || [];
    state.dealScan = dealResult.value.scan || state.dealScan;
  }
  if (matchResult.status === "fulfilled") state.priceMatches = { ...state.priceMatches, ...matchResult.value };
}

function receiptMarket(receipt) {
  const country = String(receipt?.country || "").toUpperCase();
  if (country === "CA" || country === "US") return country;
  if (!receipt?.state) return state.market;
  return /^(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/i.test(String(receipt?.state || "")) ? "CA" : "US";
}

function marketName(market = state.market) {
  return market === "US" ? "United States" : "Canada";
}

function receiptMoney(receipt, value) {
  return money(value, receipt?.currency || (receiptMarket(receipt) === "US" ? "USD" : "CAD"));
}

function marketReceipts() {
  return state.receipts.filter(receipt => receiptMarket(receipt) === state.market);
}

function libraryItems() {
  return state.receipts.flatMap(receipt => receipt.items.map(item => ({ ...item, receipt })));
}

function allItems() {
  return marketReceipts().flatMap(receipt => receipt.items.map(item => ({ ...item, receipt })));
}

function filteredItems() {
  const query = state.query.toLowerCase().trim();
  const items = allItems().filter(item => {
    const matchesQuery = !query || `${item.name} ${item.itemNumber} ${item.discount} ${item.product?.canonicalName || ""} ${item.product?.brand || ""} ${item.product?.category || ""} ${item.receipt.store} ${item.receipt.transactionNumber}`.toLowerCase().includes(query);
    const matchesType = state.itemFilter === "all" || eventType(item) === state.itemFilter;
    const matchesDate = inDateRange(item.receipt.date, state.itemFilters.from, state.itemFilters.to);
    const matchesPaid = inNumberRange(item.total, state.itemFilters.minPaid, state.itemFilters.maxPaid);
    const matchesDiscount = !state.itemFilters.discountedOnly || Number(item.discount || 0) !== 0;
    return matchesQuery && matchesType && matchesDate && matchesPaid && matchesDiscount;
  });
  const direction = state.itemSort.direction === "asc" ? 1 : -1;
  return items.sort((a, b) => {
    const key = state.itemSort.key;
    if (key === "date") return String(a.receipt.date || "").localeCompare(String(b.receipt.date || "")) * direction;
    if (key === "item") return String(a.name || "").localeCompare(String(b.name || "")) * direction;
    if (key === "suggested") return String(a.product?.canonicalName || "").localeCompare(String(b.product?.canonicalName || "")) * direction;
    if (key === "type") return eventLabel(a).localeCompare(eventLabel(b)) * direction;
    return (Number(a[key] || 0) - Number(b[key] || 0)) * direction;
  });
}

function filteredReceipts() {
  const query = state.query.toLowerCase().trim();
  const receipts = marketReceipts().filter(receipt => {
    const matchesQuery = !query || `${receipt.store} ${receipt.fileName} ${receipt.transactionNumber} ${receipt.date} ${receipt.subtotal} ${receipt.tax} ${receipt.total} ${receipt.itemCount} ${receiptIsRefund(receipt) ? "refund" : "purchase"}`.toLowerCase().includes(query);
    const matchesType = state.receiptFilter === "all" || (receiptIsRefund(receipt) ? "refund" : "purchase") === state.receiptFilter;
    const matchesStore = !state.receiptFilters.store || String(receipt.store || "").toLowerCase().includes(state.receiptFilters.store.toLowerCase());
    const matchesDate = inDateRange(receipt.date, state.receiptFilters.from, state.receiptFilters.to);
    const matchesTotal = inNumberRange(receipt.total, state.receiptFilters.minTotal, state.receiptFilters.maxTotal);
    return matchesQuery && matchesType && matchesStore && matchesDate && matchesTotal;
  });
  const direction = state.receiptSort.direction === "asc" ? 1 : -1;
  return receipts.sort((a, b) => {
    const key = state.receiptSort.key;
    if (key === "date") return (String(a.date || "").localeCompare(String(b.date || ""))) * direction;
    if (key === "store") return String(a.store || "").localeCompare(String(b.store || "")) * direction;
    if (key === "items") return (Number(a.itemCount || a.items.length) - Number(b.itemCount || b.items.length)) * direction;
    if (key === "type") return (Number(receiptIsRefund(a)) - Number(receiptIsRefund(b))) * direction;
    return (Number(a[key] || 0) - Number(b[key] || 0)) * direction;
  });
}

function eventType(item) {
  if (item.eventType) return item.eventType;
  return item.status === "returned" || Number(item.amount) < 0 ? "refund" : "purchase";
}

function eventLabel(item) {
  if (eventType(item) === "refund") return "Returned";
  if (eventType(item) === "adjustment") return "Receipt adjustment";
  return "Purchased";
}

function eventClass(item) {
  return eventType(item) === "refund" ? "refund" : eventType(item) === "adjustment" ? "adjustment" : "purchase";
}

function adjustmentText(item) {
  const parts = [];
  if (Number(item.discount || 0) !== 0) parts.push(`discount ${money(item.discount)}`);
  if (Number(item.fees || 0) !== 0) parts.push(`fees ${money(item.fees)}`);
  if (Number(item.otherAdjustments || 0) !== 0) parts.push(`return adjustment ${money(item.otherAdjustments)}`);
  return parts.join(" · ");
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function displayName(item) {
  return item.product?.canonicalName || item.name || "Unidentified item";
}

function quantityLabel(item) {
  const quantity = Number(item.quantity || 1);
  return quantity > 1 ? ` ×${quantity}` : "";
}

function quantityCell(item) {
  if (eventType(item) === "adjustment") return `<div class="quantity-stack"><strong>—</strong><small>adjustment</small></div>`;
  const quantity = Math.max(1, Number(item.quantity || 1));
  const returned = Math.max(0, Number(item.returnedQuantity || 0));
  const remaining = Math.max(0, Number(item.remainingQuantity ?? quantity - returned));
  const detail = eventType(item) === "refund"
    ? "returned"
    : returned > 0
      ? `${remaining} remaining`
      : quantity === 1 ? "unit" : "units";
  return `<div class="quantity-stack"><strong>${quantity}</strong><small>${detail}</small></div>`;
}

function enrichmentLabel(item) {
  return item.product?.enrichmentStatus === "enriched" ? "Enriched" : "Receipt name only";
}

function enrichmentDescription(item) {
  if (item.product?.autoMatched) return "The first matching Costco result was saved automatically. The original receipt name remains visible beside the suggestion.";
  if (item.product?.lookupStatus === "not-found") return `No automatic match was found. Use Find Product Details, open a Costco result in the mini browser, and ${PRODUCT_NAME} will save it.`;
  return item.product?.enrichmentStatus === "enriched"
    ? "This item has saved product metadata in your local library."
    : `${PRODUCT_NAME} is looking for a likely Costco listing in the background. The original receipt data is never replaced.`;
}

function productImage(item) {
  const imageUrl = item.product?.imageUrl;
  return imageUrl ? `<img class="product-image" src="${escapeHtml(imageUrl)}" alt="" onerror="this.style.display='none'" />` : "";
}

function suggestedProductMarkup(item) {
  const product = item.product || {};
  const matched = Boolean(product.productUrl);
  const status = matched ? (product.autoMatched ? "Auto-matched" : "Matched") : product.lookupStatus === "not-found" ? "No match found" : "Searching…";
  const name = matched ? (product.canonicalName || item.name) : "Not available";
  const thumbnail = product.imageUrl
    ? `<span class="product-thumbnail"><img src="${escapeHtml(product.imageUrl)}" alt="" onerror="this.parentElement.classList.add('missing');this.remove()" /></span>`
    : `<span class="product-thumbnail missing">—</span>`;
  return `${thumbnail}<span class="suggested-product-copy"><strong>${escapeHtml(name)}</strong><small>${status}</small></span>`;
}

function linkedHistoryText(item) {
  if (Number(item.returnedQuantity || 0) > 0) {
    const refund = libraryItems().find(candidate => candidate.id === item.refundEventId);
    const purchased = Number(item.quantity || 1);
    const returned = Number(item.returnedQuantity || 0);
    if (returned < purchased) return `${returned} of ${purchased} returned${refund ? ` ${shortDate(refund.receipt.date)}` : ""}`;
    return refund ? `fully returned ${shortDate(refund.receipt.date)}` : "fully returned later";
  }
  if (item.returnedPurchaseId) return `${item.matchConfidence || "matched to purchase"}${item.matchedQuantity ? ` · ${item.matchedQuantity} unit${Number(item.matchedQuantity) === 1 ? "" : "s"}` : ""}`;
  return "";
}

function receiptIsRefund(receipt) {
  return receipt.receiptType === "refund" || Number(receipt.total) < 0;
}

function costcoDomainForItem(item) {
  if (item.receipt?.country === "US") return "Costco.com";
  if (item.receipt?.country === "CA") return "Costco.ca";
  const location = `${item.receipt?.store || ""} ${item.receipt?.state || ""}`.toUpperCase();
  return /\b(?:AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/.test(location) ? "Costco.ca" : "Costco.com";
}

function googleProductSearchUrl(item) {
  const query = `${costcoDomainForItem(item)} Item ${item.itemNumber || ""} ${item.name || ""}`.replace(/\s+/g, " ").trim();
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function cleanProductTitle(value) {
  const title = String(value || "").replace(/\s*(?:[-|]\s*)?Costco(?: Wholesale)?\s*$/i, "").trim();
  return /access denied|forbidden|not found|not able to find a match|we(?:'|’)re sorry|not available|page unavailable/i.test(title) ? "" : title;
}

function applyProductToState(itemNumber, product) {
  state.receipts.forEach(receipt => (receipt.items || []).forEach(item => {
    if (String(item.itemNumber || "") === String(itemNumber || "")) item.product = product;
  }));
}

async function saveExtractedMetadata(item, product) {
  if (!product?.productUrl || !window.receiptDesktop?.extractProductMetadata || product.imageUrl) return product;
  try {
    const metadata = await window.receiptDesktop.extractProductMetadata(product.productUrl);
    if (!metadata?.title && !metadata?.imageUrl) return product;
    const response = await fetch(`/api/products/${encodeURIComponent(item.itemNumber)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canonicalName: cleanProductTitle(metadata.title) || product.canonicalName,
        brand: metadata.brand || product.brand,
        category: metadata.category || product.category,
        imageUrl: metadata.imageUrl || product.imageUrl,
        productUrl: metadata.canonicalUrl || product.productUrl,
        source: "Automatic Costco page metadata"
      })
    });
    if (!response.ok) return product;
    return (await response.json()).product || product;
  } catch {
    return product;
  }
}

async function saveAutomaticMatch(item, result) {
  if (!result?.url) return null;
  const response = await fetch(`/api/products/${encodeURIComponent(item.itemNumber)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      canonicalName: cleanProductTitle(result.title) || item.name,
      productUrl: result.url,
      source: "Automatic Google Costco match",
      autoMatched: true,
      matchQuery: result.query,
      costcoDomain: result.domain,
      lookupStatus: "matched",
      lookupAttemptedAt: new Date().toISOString()
    })
  });
  if (!response.ok) return null;
  return (await response.json()).product || null;
}

async function enrichProduct(item, inspectProductPage = false) {
  let product = item.product || null;
  if (!product?.productUrl) {
    const response = await fetch(`/api/products/${encodeURIComponent(item.itemNumber)}/auto-enrich`, { method: "POST" });
    const data = await response.json();
    product = data.product || product;
    if (!response.ok && !inspectProductPage) return product;
  }
  if (!product?.productUrl && inspectProductPage && window.receiptDesktop?.findCostcoProduct) {
    try {
      const result = await window.receiptDesktop.findCostcoProduct({
        itemNumber: item.itemNumber,
        name: item.name,
        domain: costcoDomainForItem(item)
      });
      product = await saveAutomaticMatch(item, result) || product;
    } catch {}
  }
  if (inspectProductPage) product = await saveExtractedMetadata(item, product);
  if (product) applyProductToState(item.itemNumber, product);
  return product;
}

function shouldEnrichProduct(item) {
  if (state.usingDemo || !item.itemNumber) return false;
  if (item.product?.productUrl && item.product?.imageUrl) return false;
  if (item.product?.productUrl) return true;
  if (item.product?.lookupStatus !== "not-found") return true;
  const attempted = Date.parse(item.product?.lookupAttemptedAt || "");
  return !attempted || Date.now() - attempted > 7 * 24 * 60 * 60 * 1000;
}

function updateSuggestedProductCells(itemNumber) {
  const item = allItems().find(candidate => String(candidate.itemNumber || "") === String(itemNumber || ""));
  if (!item) return;
  $$('[data-suggested-product]').forEach(cell => {
    if (cell.dataset.suggestedProduct === String(itemNumber)) cell.innerHTML = suggestedProductMarkup(item);
  });
}

async function runEnrichmentQueue() {
  if (enrichmentWorkerRunning) return;
  enrichmentWorkerRunning = true;
  while (enrichmentQueue.length) {
    const job = enrichmentQueue.shift();
    const item = job.item;
    try {
      await enrichProduct(item, job.inspectProductPage);
      updateSuggestedProductCells(item.itemNumber);
      if (state.selectedItem?.itemNumber === String(item.itemNumber || "")) {
        openItem(state.selectedItem.itemId, state.selectedItem.receiptId, true);
      }
    } catch {}
    queuedProducts.delete(String(item.itemNumber || ""));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  enrichmentWorkerRunning = false;
}

function queueProductEnrichment(items, prioritize = false) {
  for (const item of items) {
    const key = String(item.itemNumber || "");
    if (!key || (!prioritize && !shouldEnrichProduct(item))) continue;
    if (!prioritize && item.product?.productUrl) continue;
    if (queuedProducts.has(key)) {
      if (prioritize) {
        const queuedIndex = enrichmentQueue.findIndex(job => String(job.item.itemNumber || "") === key);
        if (queuedIndex >= 0) {
          const job = enrichmentQueue.splice(queuedIndex, 1)[0];
          job.inspectProductPage = true;
          enrichmentQueue.unshift(job);
        }
      }
      continue;
    }
    queuedProducts.add(key);
    const job = { item, inspectProductPage: prioritize };
    if (prioritize) enrichmentQueue.unshift(job); else enrichmentQueue.push(job);
  }
  runEnrichmentQueue();
}

async function openReceiptFolder(receipt) {
  if (!window.receiptDesktop?.openReceiptFolder) return toast("Open containing folder is available in the desktop app.");
  try {
    await window.receiptDesktop.openReceiptFolder(receipt.id);
  } catch (error) {
    toast(error.message || "The receipt folder could not be opened.");
  }
}

function openReceiptPdf(receipt) {
  if (!receipt?.pdfUrl) return toast("The original PDF is not available for this receipt.");
  window.open(new URL(receipt.pdfUrl, window.location.origin).href, "_blank");
}

function inDateRange(value, from, to) {
  const date = String(value || "");
  return (!from || date >= from) && (!to || date <= to);
}

function inNumberRange(value, min, max) {
  const number = Number(value || 0);
  const minimum = min === "" ? null : Number(min);
  const maximum = max === "" ? null : Number(max);
  return (minimum === null || number >= minimum) && (maximum === null || number <= maximum);
}

function activeItemFilterCount() {
  return Object.values(state.itemFilters).filter(value => value !== "" && value !== false).length;
}

function activeReceiptFilterCount() {
  return Object.values(state.receiptFilters).filter(Boolean).length;
}

function relativeTime(value) {
  const timestamp = Date.parse(value || "");
  if (!timestamp) return "Never";
  const difference = Date.now() - timestamp;
  const minutes = Math.max(0, Math.round(difference / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function fullDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.valueOf())) return "Never";
  return new Intl.DateTimeFormat(state.market === "US" ? "en-US" : "en-CA", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  }).format(date);
}

function listKey(view = state.activeView) {
  if (view === "price-match") return "price";
  return view === "receipts" ? "receipts" : "items";
}

function resetListLimit(view = state.activeView) {
  const key = listKey(view);
  state.listLimits[key] = PAGE_SIZE[key];
}

function infiniteSentinel(key, visible, total) {
  if (visible >= total) return `<div class="list-end">${total} ${key === "receipts" ? "receipts" : key === "price" ? "results" : "item events"}</div>`;
  return `<div class="infinite-sentinel" data-list-key="${key}" data-total="${total}">Showing ${visible} of ${total} · scroll for more</div>`;
}

let infiniteObserver;
let infiniteLoading = false;
function bindInfiniteScroll() {
  infiniteObserver?.disconnect();
  const root = $("#view-content .data-scroll");
  const sentinel = root?.querySelector(".infinite-sentinel");
  if (!root || !sentinel) return;
  infiniteObserver = new IntersectionObserver(entries => {
    if (infiniteLoading || !entries.some(entry => entry.isIntersecting)) return;
    const key = sentinel.dataset.listKey;
    const total = Number(sentinel.dataset.total || 0);
    if (!PAGE_SIZE[key] || state.listLimits[key] >= total) return;
    infiniteLoading = true;
    state.listLimits[key] = Math.min(total, state.listLimits[key] + PAGE_SIZE[key]);
    render({ preserveScroll: true });
    requestAnimationFrame(() => { infiniteLoading = false; });
  }, { root, rootMargin: "240px 0px" });
  infiniteObserver.observe(sentinel);
}

function updateCartUi() {
  const count = state.receiptCart.size;
  $("#top-cart-count").textContent = count;
  $("#top-cart-button").classList.toggle("has-items", count > 0);
}

function render(options = {}) {
  const priorScroll = options.preserveScroll ? $("#view-content .data-scroll")?.scrollTop || 0 : 0;
  const viewName = { overview: "Library", items: "Items", receipts: "Receipts", imports: "Import", "price-match": "Price Match" }[state.activeView] || "Items";
  $("#view-label").textContent = viewName;
  $("#market-select").value = state.market;
  $("#search-input").value = state.query;
  $("#receipt-count-side").textContent = state.receipts.length;
  $("#import-button").hidden = state.activeView !== "receipts";
  $(".search-bar-shell").hidden = state.activeView === "price-match" || state.activeView === "imports";
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === state.activeView));
  if (state.activeView === "overview") renderOverview();
  if (state.activeView === "items") renderItems();
  if (state.activeView === "receipts") renderReceipts();
  if (state.activeView === "imports") renderImports();
  if (state.activeView === "price-match") renderPriceMatch();
  bindRows();
  updateCartUi();
  bindInfiniteScroll();
  if (options.preserveScroll) requestAnimationFrame(() => {
    const nextScroll = $("#view-content .data-scroll");
    if (nextScroll) nextScroll.scrollTop = priorScroll;
  });
}

function renderOverview() {
  $("#page-title").textContent = state.query ? "Search results" : "Receipt library";
  $(".page-intro").textContent = state.query ? `${filteredItems().length} matching purchase${filteredItems().length === 1 ? "" : "s"} for “${state.query}”.` : "Search by item number, name, warehouse, or receipt detail.";
  const items = filteredItems();
  const matchedReceipts = new Set(items.map(item => item.receipt.id)).size;
  const totalSpend = state.query ? items.reduce((sum, item) => sum + Number(item.total || 0), 0) : state.receipts.reduce((sum, receipt) => sum + Number(receipt.total || 0), 0);
  const summary = state.query
    ? `<span>${matchedReceipts} receipts matched</span><span>${items.length} items matched</span><span>${money(totalSpend)} matched total</span>`
    : `<span>${state.receipts.length} receipts</span><span>${allItems().length} items searchable</span><span>${money(totalSpend)} receipt total</span>`;
  $("#view-content").innerHTML = `<div class="library-summary">${summary}</div>
    <section class="list-panel"><div class="section-label"><h2>${state.query ? "Matching items" : "Recent receipts"}</h2><p>${state.query ? "Select an item for receipt details" : "Newest first"}</p></div>
      ${state.query ? itemTable(items) : receiptList(state.receipts.slice(0, 7))}
    </section>`;
}

function receiptList(receipts) {
  if (!receipts.length) return emptyState("Your library is empty", "Import a Costco PDF to start building your searchable history.");
  return `<div class="activity-list">${receipts.map(receipt => `<div class="activity-row receipt-row" data-receipt-id="${receipt.id}">
    <div class="receipt-glyph">${receiptIsRefund(receipt) ? "↩" : "▤"}</div><div><div class="row-primary">${escapeHtml(receipt.store || "Costco warehouse")}</div><div class="row-secondary">${shortDate(receipt.date)} · ${receipt.itemCount || receipt.items.length} items · ${receipt.fileName || "Original receipt"}</div></div><div class="row-meta"><span class="tag ${receiptIsRefund(receipt) ? "refund" : ""}">${receiptIsRefund(receipt) ? "Refund" : receipt.confidence === "review" ? "Review" : "Indexed"}</span></div><div class="row-total">${money(receipt.total)}</div>
  </div>`).join("</div>")}`;
}

function itemFilterMenu() {
  return `<details class="filter-menu"><summary>Filters${activeItemFilterCount() ? ` <span>${activeItemFilterCount()}</span>` : ""}</summary><div class="filter-popover"><label>Purchase date from<input type="date" data-item-filter-field="from" value="${escapeHtml(state.itemFilters.from)}" /></label><label>Purchase date to<input type="date" data-item-filter-field="to" value="${escapeHtml(state.itemFilters.to)}" /></label><label>Paid at least<input type="number" step="0.01" placeholder="0.00" data-item-filter-field="minPaid" value="${escapeHtml(state.itemFilters.minPaid)}" /></label><label>Paid at most<input type="number" step="0.01" placeholder="0.00" data-item-filter-field="maxPaid" value="${escapeHtml(state.itemFilters.maxPaid)}" /></label><label class="checkbox-filter"><input type="checkbox" data-item-filter-field="discountedOnly" ${state.itemFilters.discountedOnly ? "checked" : ""} /> Discounted items only</label><button type="button" class="text-button" id="clear-item-filters">Clear filters</button></div></details>`;
}

function receiptFilterMenu() {
  return `<details class="filter-menu"><summary>Filters${activeReceiptFilterCount() ? ` <span>${activeReceiptFilterCount()}</span>` : ""}</summary><div class="filter-popover"><label>Store contains<input type="text" placeholder="Warehouse or city" data-receipt-filter-field="store" value="${escapeHtml(state.receiptFilters.store)}" /></label><label>Receipt date from<input type="date" data-receipt-filter-field="from" value="${escapeHtml(state.receiptFilters.from)}" /></label><label>Receipt date to<input type="date" data-receipt-filter-field="to" value="${escapeHtml(state.receiptFilters.to)}" /></label><label>Total at least<input type="number" step="0.01" placeholder="0.00" data-receipt-filter-field="minTotal" value="${escapeHtml(state.receiptFilters.minTotal)}" /></label><label>Total at most<input type="number" step="0.01" placeholder="0.00" data-receipt-filter-field="maxTotal" value="${escapeHtml(state.receiptFilters.maxTotal)}" /></label><button type="button" class="text-button" id="clear-receipt-filters">Clear filters</button></div></details>`;
}

function itemTable(items) {
  if (!items.length) return emptyState("No matching purchases", "Try another item number, name, or warehouse.");
  const visible = items.slice(0, state.listLimits.items);
  return `<div class="table-shell data-scroll"><div class="table-head"><button data-item-sort="item">Item${itemSortIndicator("item")}</button><button data-item-sort="suggested">Suggested product name${itemSortIndicator("suggested")}</button><button data-item-sort="date">Purchase${itemSortIndicator("date")}</button><button data-item-sort="quantity">Qty${itemSortIndicator("quantity")}</button><button data-item-sort="amount">Pre-tax${itemSortIndicator("amount")}</button><button data-item-sort="discount">Discount${itemSortIndicator("discount")}</button><button data-item-sort="allocatedTax">Tax${itemSortIndicator("allocatedTax")}</button><button data-item-sort="total">Paid${itemSortIndicator("total")}</button></div>${visible.map(item => `<div class="table-row item-row" data-item-id="${item.id}" data-receipt-id="${item.receipt.id}">
    <div><div class="item-name">${escapeHtml(item.name || "Unidentified item")}</div><div class="item-number">#${escapeHtml(item.itemNumber)} · <span class="event-label ${eventClass(item)}">${eventLabel(item)}</span>${adjustmentText(item) ? ` · ${escapeHtml(adjustmentText(item))}` : ""}${linkedHistoryText(item) ? ` · ${escapeHtml(linkedHistoryText(item))}` : ""}</div></div><div class="suggested-product-cell" data-suggested-product="${escapeHtml(item.itemNumber)}">${suggestedProductMarkup(item)}</div><div class="row-meta">${shortDate(item.receipt.date)}</div>${quantityCell(item)}<div class="price-stack"><strong>${money(item.amount)}</strong><small>after adjustments</small></div><div class="price-stack"><strong>${Number(item.discount || 0) ? money(item.discount) : "—"}</strong><small>line discount</small></div><div class="price-stack"><strong>${money(item.allocatedTax)}</strong><small>allocated</small></div><div class="price-stack"><strong>${money(item.total)}</strong><small>${eventType(item) === "refund" ? "refunded" : "paid"}</small></div>
  </div>`).join("")}${infiniteSentinel("items", visible.length, items.length)}</div>`;
}

function renderItems() {
  $("#page-title").textContent = "Item library";
  $(".page-intro").textContent = `${marketName()} purchases, quantities, discounts, and refunds.`;
  const items = filteredItems();
  $("#view-content").innerHTML = `<div class="list-view-layout"><div class="library-table-head"><div class="section-label"><h2>Item library</h2><p>${items.length} item events</p></div></div><div class="table-controls"><div class="filter-tabs"><button class="filter-tab ${state.itemFilter === "all" ? "active" : ""}" data-item-filter="all">All</button><button class="filter-tab ${state.itemFilter === "purchase" ? "active" : ""}" data-item-filter="purchase">Purchases</button><button class="filter-tab ${state.itemFilter === "refund" ? "active" : ""}" data-item-filter="refund">Refunds</button><button class="filter-tab ${state.itemFilter === "adjustment" ? "active" : ""}" data-item-filter="adjustment">Adjustments</button></div><div class="toolbar-actions">${itemFilterMenu()}<label class="sort-control">Sort<select id="item-sort-select"><option value="date-desc" ${state.itemSort.key === "date" && state.itemSort.direction === "desc" ? "selected" : ""}>Newest</option><option value="date-asc" ${state.itemSort.key === "date" && state.itemSort.direction === "asc" ? "selected" : ""}>Oldest</option><option value="item-asc" ${state.itemSort.key === "item" && state.itemSort.direction === "asc" ? "selected" : ""}>Item A–Z</option><option value="item-desc" ${state.itemSort.key === "item" && state.itemSort.direction === "desc" ? "selected" : ""}>Item Z–A</option><option value="quantity-desc" ${state.itemSort.key === "quantity" && state.itemSort.direction === "desc" ? "selected" : ""}>Highest quantity</option><option value="total-desc" ${state.itemSort.key === "total" && state.itemSort.direction === "desc" ? "selected" : ""}>Highest paid</option><option value="total-asc" ${state.itemSort.key === "total" && state.itemSort.direction === "asc" ? "selected" : ""}>Lowest paid</option><option value="allocatedTax-desc" ${state.itemSort.key === "allocatedTax" && state.itemSort.direction === "desc" ? "selected" : ""}>Highest tax</option></select></label></div></div>${itemTable(items)}</div>`;
  queueProductEnrichment(items.slice(0, Math.min(20, state.listLimits.items)));
}

function renderReceipts() {
  const receipts = filteredReceipts();
  $("#page-title").textContent = "Receipt library";
  $(".page-intro").textContent = `${marketName()} receipts, account sync, and manual PDF originals.`;
  const syncing = state.syncProgress?.market === state.market && ["fetching", "importing"].includes(state.syncProgress?.phase);
  const digitalCount = marketReceipts().filter(receipt => receipt.source?.key).length;
  const identity = state.sync.identity || {};
  const syncMessage = syncing
    ? state.syncProgress.message
    : state.sync.status === "completed-with-errors" && state.sync.lastError
      ? `Last sync stopped: ${state.sync.lastError}`
    : state.sync.lastSyncedAt
      ? `Last sync completed ${fullDateTime(state.sync.lastSyncedAt)} · ${digitalCount} digital receipts connected`
      : `Sign in once in ${PRODUCT_NAME}’s Costco window. Your session stays on this Mac.`;
  const identityLine = identity.email || identity.membershipNumber
    ? `<div class="sync-identity"><span>${escapeHtml(identity.email || "Email unavailable")}</span><strong>${identity.membershipNumber ? `Membership ${escapeHtml(identity.membershipNumber)}` : "Membership number unavailable"}</strong></div>`
    : `<div class="sync-identity pending"><span>Costco account</span><strong>Shown here after the first successful sync</strong></div>`;
  const progress = syncing ? Math.round((Number(state.syncProgress.current || 0) / Math.max(1, Number(state.syncProgress.total || 1))) * 100) : 0;
  $("#view-content").innerHTML = `<div class="list-view-layout receipt-view-layout"><section class="sync-band"><div class="sync-copy"><h2>Costco ${marketName()} sync</h2><p>${escapeHtml(syncMessage)}</p>${syncing ? `<div class="sync-progress" aria-label="Sync progress"><span style="width:${progress}%"></span></div>` : ""}</div>${identityLine}<div class="sync-actions"><span>Up to 3 years · local PDFs</span><button class="primary-button" id="costco-sync-button" ${syncing ? "disabled" : ""}>${syncing ? "Syncing…" : `Open Costco ${state.market === "US" ? "US" : "Canada"} & Sync`}</button></div></section><div class="receipt-library-head"><div class="section-label"><div><h2>Receipts</h2><p>${receipts.length} of ${marketReceipts().length} receipts</p></div></div></div><div class="receipt-controls"><div class="filter-tabs"><button class="filter-tab ${state.receiptFilter === "all" ? "active" : ""}" data-receipt-filter="all">All</button><button class="filter-tab ${state.receiptFilter === "purchase" ? "active" : ""}" data-receipt-filter="purchase">Purchases</button><button class="filter-tab ${state.receiptFilter === "refund" ? "active" : ""}" data-receipt-filter="refund">Refunds</button></div><div class="toolbar-actions">${receiptFilterMenu()}<label class="sort-control">Sort<select id="receipt-sort-select"><option value="date-desc" ${state.receiptSort.key === "date" && state.receiptSort.direction === "desc" ? "selected" : ""}>Newest</option><option value="date-asc" ${state.receiptSort.key === "date" && state.receiptSort.direction === "asc" ? "selected" : ""}>Oldest</option><option value="store-asc" ${state.receiptSort.key === "store" ? "selected" : ""}>Store</option><option value="total-desc" ${state.receiptSort.key === "total" && state.receiptSort.direction === "desc" ? "selected" : ""}>Highest total</option><option value="total-asc" ${state.receiptSort.key === "total" && state.receiptSort.direction === "asc" ? "selected" : ""}>Lowest total</option><option value="items-desc" ${state.receiptSort.key === "items" ? "selected" : ""}>Most items</option></select></label></div></div>${receiptTable(receipts)}<div class="receipt-import-note">Missing one? <button class="text-button" id="receipt-import-note-button">Import its PDF</button>. Manual originals merge with matching synced transactions.</div></div>`;
}

function priceMatchRow(match) {
  const exact = match.confidence === "exact item number";
  const image = match.deal?.imageUrl ? `<img src="${escapeHtml(match.deal.imageUrl)}" alt="" onerror="this.style.display='none'" />` : `<span>${escapeHtml((match.name || "?").slice(0, 1))}</span>`;
  return `<div class="match-row"><div class="match-image">${image}</div><div class="match-product"><strong>${escapeHtml(match.deal?.name || match.name)}</strong><small>Item #${escapeHtml(match.itemNumber)} · bought ${shortDate(match.date)} · ${escapeHtml(match.store || "Costco")}</small><span class="match-confidence ${exact ? "" : "review"}">${exact ? "Exact item match" : "Name match — verify item number"}</span></div><div class="match-price"><span>You paid</span><strong>${money(match.paidPerUnit)}</strong></div><div class="match-arrow">→</div><div class="match-price current"><span>Current</span><strong>${money(match.salePrice)}</strong></div><div class="match-saving"><span>Possible adjustment</span><strong>${money(match.potentialSavings)}</strong></div><div class="match-actions"><button class="text-button" data-open-deal="${escapeHtml(match.deal?.pageUrl || "")}">View source</button><button class="secondary-button" data-cart-receipt="${escapeHtml(match.receiptId)}">${state.receiptCart.has(match.receiptId) ? "In cart" : "Add receipt"}</button></div></div>`;
}

function renderPriceMatch() {
  $("#page-title").textContent = "Price match check";
  $(".page-intro").textContent = `Compare recent ${marketName()} purchases with current warehouse sale listings.`;
  const report = state.priceMatches;
  const scanning = state.dealScan.status === "scanning";
  const scanLabel = state.dealScan.scannedAt ? `Deals updated ${relativeTime(state.dealScan.scannedAt)}` : "Deals have not been checked yet";
  const matches = report.matches || [];
  const alreadySaved = report.alreadySaved || [];
  const visibleMatches = matches.slice(0, state.listLimits.price);
  const visibleSaved = alreadySaved.slice(0, state.listLimits.price);
  const priceTotal = Math.max(matches.length, alreadySaved.length);
  const sourceNames = [...new Set((state.dealScan.pages || []).map(page => page.source).filter(Boolean))];
  const sourceLabel = sourceNames.length ? sourceNames.join(" + ") : state.market === "US" ? "Costco US Warehouse Savings" : "CocoWest + CocoEast";
  const sourceErrors = state.dealScan.errors?.length ? `<span class="scan-warning">${state.dealScan.errors.length} source${state.dealScan.errors.length === 1 ? "" : "s"} unavailable</span>` : "";
  const opportunityContent = matches.length
    ? `<div class="match-list">${visibleMatches.map(priceMatchRow).join("")}</div>`
    : `<div class="plain-empty"><h3>No lower prices found.</h3><p>There are no exact lower-price matches for active purchases from the last ${report.horizonDays || 30} days. Run the check again when weekly deals change.</p></div>`;
  const savingsContent = alreadySaved.length
    ? `<div class="savings-list">${visibleSaved.map(item => `<div class="saving-row"><div><strong>${escapeHtml(item.name)}</strong><small>Item #${escapeHtml(item.itemNumber)} · ${shortDate(item.date)}</small></div><strong>${money(item.saved)}</strong></div>`).join("")}</div>`
    : `<p class="muted-copy">No receipt-level instant savings were found in this 30-day window.</p>`;
  $("#view-content").innerHTML = `<div class="list-view-layout price-view-layout"><div class="price-toolbar"><div><strong>${escapeHtml(scanLabel)}</strong><span>${report.scannedDealCount || state.deals.length} active sale items checked · ${escapeHtml(sourceLabel)} ${sourceErrors}</span></div><div class="toolbar-actions"><button class="text-button" id="price-method-button">How this works</button><button class="primary-button" id="scan-deals-button" ${scanning ? "disabled" : ""}>${scanning ? "Checking deals…" : "Check current deals"}</button></div></div><div class="price-summary"><div><span>Possible adjustments</span><strong>${money(report.potentialSavings)}</strong></div><div><span>Receipt matches</span><strong>${matches.length}</strong></div><div><span>Discounts already applied</span><strong>${money(report.appliedSavings)}</strong></div></div><div class="price-data-scroll data-scroll"><section class="price-section"><div class="section-label"><div><h2>Worth checking</h2><p>Recent, unreturned purchases only</p></div></div>${opportunityContent}<p class="policy-note">Price adjustments are not guaranteed. ${PRODUCT_NAME} compares prices and prepares the matching receipt; the warehouse confirms eligibility and final amount.</p></section><section class="price-section applied-section"><div class="section-label"><div><h2>Already saved at checkout</h2><p>Instant savings already present on your receipts</p></div></div>${savingsContent}</section>${infiniteSentinel("price", Math.min(state.listLimits.price, priceTotal), priceTotal)}</div></div>`;
}

const dealScanRequested = new Set();
async function scanCurrentDeals(showFeedback = true) {
  if (state.dealScan.status === "scanning") return;
  const market = state.market;
  state.dealScan = { ...state.dealScan, status: "scanning" };
  if (state.activeView === "price-match") render();
  try {
    const response = await fetch(`/api/deals/scan?market=${market}`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Current deals could not be checked.");
    if (state.market !== market) return;
    state.deals = data.deals || [];
    state.dealScan = data.scan || state.dealScan;
    const matchResponse = await fetch(`/api/price-matches?days=30&market=${market}`);
    state.priceMatches = { ...state.priceMatches, ...(await matchResponse.json()) };
    if (showFeedback) toast(`${state.priceMatches.matches.length} possible price adjustment${state.priceMatches.matches.length === 1 ? "" : "s"} found.`);
  } catch (error) {
    state.dealScan = { ...state.dealScan, status: "error" };
    if (showFeedback) toast(error.message || "Current deals could not be checked.");
  }
  if (state.activeView === "price-match") render();
}

function maybeScanDeals() {
  if (dealScanRequested.has(state.market) || state.usingDemo) return;
  const scannedAt = Date.parse(state.dealScan.scannedAt || "");
  if (scannedAt && Date.now() - scannedAt < 12 * 60 * 60 * 1000) return;
  dealScanRequested.add(state.market);
  scanCurrentDeals(false);
}

function receiptSortIndicator(key) {
  if (state.receiptSort.key !== key) return "";
  return state.receiptSort.direction === "asc" ? " ↑" : " ↓";
}

function itemSortIndicator(key) {
  if (state.itemSort.key !== key) return "";
  return state.itemSort.direction === "asc" ? " ↑" : " ↓";
}

function receiptTable(receipts) {
  if (!receipts.length) return emptyState("No matching receipts", "Change the filter or search term, or import another Costco PDF.");
  const selectable = receipts.filter(receipt => receipt.hasDocument !== false);
  const allSelected = selectable.length > 0 && selectable.every(receipt => state.receiptCart.has(receipt.id));
  const visible = receipts.slice(0, state.listLimits.receipts);
  return `<div class="receipt-table-shell data-scroll"><div class="receipt-table-grid receipt-table-head"><div class="receipt-select"><input id="select-visible-receipts" type="checkbox" aria-label="Select all filtered receipts" ${allSelected ? "checked" : ""} /></div><button data-receipt-sort="store">Store location${receiptSortIndicator("store")}</button><button data-receipt-sort="subtotal">Amount${receiptSortIndicator("subtotal")}</button><button data-receipt-sort="tax">Tax${receiptSortIndicator("tax")}</button><button data-receipt-sort="total">Total${receiptSortIndicator("total")}</button><button data-receipt-sort="items">Qty of items${receiptSortIndicator("items")}</button><button data-receipt-sort="type">Receipt type${receiptSortIndicator("type")}</button><button data-receipt-sort="date">Date${receiptSortIndicator("date")}</button></div>${visible.map(receipt => `<div class="receipt-table-grid receipt-table-row receipt-row ${state.receiptCart.has(receipt.id) ? "selected" : ""}" data-receipt-id="${escapeHtml(receipt.id)}"><div class="receipt-select"><input type="checkbox" data-receipt-cart="${escapeHtml(receipt.id)}" aria-label="Add ${escapeHtml(receipt.fileName || "receipt")} to receipt cart" ${state.receiptCart.has(receipt.id) ? "checked" : ""} ${receipt.hasDocument === false ? "disabled" : ""} /></div><div><strong>${escapeHtml(receipt.store || "Costco warehouse")}</strong><small>${escapeHtml(receipt.fileName || "Receipt document pending")}${receipt.source?.key ? " · Costco Sync" : ""}</small></div><div>${money(receipt.subtotal, receipt.currency)}</div><div>${money(receipt.tax, receipt.currency)}</div><div class="receipt-total">${money(receipt.total, receipt.currency)}</div><div>${receipt.itemCount || receipt.items.length}</div><div><span class="tag ${receiptIsRefund(receipt) ? "refund" : ""}">${receiptIsRefund(receipt) ? "Refund" : "Purchase"}</span></div><div>${shortDate(receipt.date)}</div></div>`).join("")}${infiniteSentinel("receipts", visible.length, receipts.length)}</div>`;
}

function renderImports() {
  $("#page-title").textContent = "Bring in your history.";
  $(".page-intro").textContent = `Import Costco PDFs once. ${PRODUCT_NAME} handles the indexing from there.`;
  $("#view-content").innerHTML = `<div class="import-view"><div class="drop-zone" id="drop-zone"><div><div class="drop-icon">↑</div><h2>Drop Costco PDFs here</h2><p>Text receipts and scanned PDFs are both supported.</p><button class="primary-button" id="choose-files-button">Choose files</button></div></div><div class="import-notes"><div class="note-line"><strong>Originals stay intact</strong>Your PDFs are copied to the local receipt library before indexing.</div><div class="note-line"><strong>Tax is reconciled</strong>Item totals add back up to the total printed on the receipt.</div><div class="note-line"><strong>Keep a backup</strong><button class="text-button" id="export-button">Export library →</button></div><div class="note-line"><strong>Product details are automatic</strong>Likely Costco names, listings, and images are added without changing receipt data.</div></div></div>`;
  bindImportSurface();
  $("#export-button")?.addEventListener("click", () => { window.location.href = "/api/export"; });
}

function emptyState(title, copy) { return `<div class="empty-state"><h2>${title}</h2><p>${copy}</p><button class="primary-button" id="empty-import-button">＋ Import PDF</button></div>`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }

function toggleReceiptCart(receiptId, force) {
  const receipt = state.receipts.find(candidate => candidate.id === receiptId);
  if (!receipt) return;
  if (receipt.hasDocument === false) return toast("This receipt document is still being created. Try again after sync finishes.");
  const shouldAdd = force === undefined ? !state.receiptCart.has(receiptId) : force;
  if (shouldAdd) state.receiptCart.add(receiptId); else state.receiptCart.delete(receiptId);
  render();
}

function selectedReceipts() {
  return state.receipts.filter(receipt => state.receiptCart.has(receipt.id));
}

function openPriceMethod() {
  const source = state.market === "US"
    ? "the official Costco US Warehouse Savings page"
    : "current CocoWest and CocoEast warehouse-sale pages";
  openDrawer(`<button class="drawer-close" id="drawer-close">×</button><div class="drawer-eyebrow">Price Match</div><h2 class="drawer-title">How the check works</h2><div class="drawer-number">Local comparison for Costco ${marketName()}</div><div class="method-steps"><div><strong>1. Read current sales</strong><p>${PRODUCT_NAME} scans ${escapeHtml(source)}. It refreshes automatically every 12 hours or when you choose Check current deals.</p></div><div><strong>2. Match purchases</strong><p>Exact Costco item numbers are matched first. Name-only candidates are clearly marked for manual review.</p></div><div><strong>3. Compare what you actually paid</strong><p>The current sale price is compared with the per-unit amount after receipt discounts, using only remaining quantities purchased within the last 30 days.</p></div></div><div class="drawer-section"><h3>Why there is no setup form</h3><p class="metadata-note method-note">The reference GitHub project uses AWS, Nova, DynamoDB, and email automation. ${PRODUCT_NAME} performs the core deal scan and deterministic comparison locally, so it does not need an AWS account, API key, or cloud database. It also does not claim a guaranteed adjustment—Costco makes the final decision.</p></div>`);
}

function openReceiptCart() {
  const receipts = selectedReceipts();
  if (!receipts.length) {
    openDrawer(`<button class="drawer-close" id="drawer-close">×</button><div class="drawer-eyebrow">Receipt cart</div><h2 class="drawer-title">No receipts selected</h2><div class="drawer-number">Select a receipt in the Receipt Library, or add one from an item’s details.</div>`);
    return;
  }
  openDrawer(`<button class="drawer-close" id="drawer-close">×</button><div class="drawer-eyebrow">Receipt cart</div><h2 class="drawer-title">${receipts.length} receipt${receipts.length === 1 ? "" : "s"} ready</h2><div class="drawer-number">Bundle the documents you need without changing your library.</div><div class="drawer-actions cart-drawer-actions"><button class="primary-button" data-cart-action="zip">Create ZIP</button><button class="secondary-button" data-cart-action="copy">Copy to folder</button><button class="secondary-button" data-cart-action="share">Share</button></div><div class="drawer-section"><h3>Selected receipts</h3>${receipts.map(receipt => `<div class="drawer-receipt cart-receipt"><button class="cart-receipt-main" data-open-cart-receipt="${escapeHtml(receipt.id)}"><span><strong>${escapeHtml(receipt.store || "Costco warehouse")}</strong><small>${shortDate(receipt.date)} · ${marketName(receiptMarket(receipt))} · ${escapeHtml(receipt.fileName || "Receipt PDF")}</small></span><strong>${receiptMoney(receipt, receipt.total)}</strong></button><button class="cart-remove" data-remove-cart-receipt="${escapeHtml(receipt.id)}" aria-label="Remove receipt">×</button></div>`).join("")}</div>`);
  $$('[data-cart-action]').forEach(button => button.addEventListener("click", () => runCartAction(button.dataset.cartAction, button)));
  $$('[data-remove-cart-receipt]').forEach(button => button.addEventListener("click", () => {
    state.receiptCart.delete(button.dataset.removeCartReceipt);
    openReceiptCart();
    render();
  }));
  $$('[data-open-cart-receipt]').forEach(button => button.addEventListener("click", () => openReceipt(button.dataset.openCartReceipt)));
}

async function runCartAction(action, button) {
  const ids = [...state.receiptCart];
  if (!ids.length) return toast("Choose at least one receipt first.");
  const desktop = window.receiptDesktop;
  const handler = action === "zip" ? desktop?.zipReceipts : action === "copy" ? desktop?.copyReceiptsToFolder : desktop?.shareReceipts;
  if (!handler) return toast(`Receipt bundles are available in the ${PRODUCT_NAME} desktop app.`);
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = action === "share" ? "Opening Share…" : "Working…"; }
  try {
    const result = await handler(ids);
    if (!result?.canceled && action !== "share") toast(`${result.count} receipt${result.count === 1 ? "" : "s"} ${action === "zip" ? "added to a ZIP" : "copied"}.`);
  } catch (error) {
    toast(error.message || "The receipt action could not be completed.");
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

function bindRows() {
  $$(".receipt-row").forEach(row => row.addEventListener("click", event => {
    if (event.target.closest("input, button, a")) return;
    openReceipt(row.dataset.receiptId);
  }));
  $$(".item-row").forEach(row => row.addEventListener("click", event => {
    if (event.target.closest("input, button, a")) return;
    openItem(row.dataset.itemId, row.dataset.receiptId);
  }));
  $$('[data-receipt-cart]').forEach(input => input.addEventListener("click", event => {
    event.stopPropagation();
    toggleReceiptCart(input.dataset.receiptCart, input.checked);
  }));
  $("#select-visible-receipts")?.addEventListener("click", event => {
    event.stopPropagation();
    filteredReceipts().filter(receipt => receipt.hasDocument !== false).forEach(receipt => {
      if (event.target.checked) state.receiptCart.add(receipt.id); else state.receiptCart.delete(receipt.id);
    });
    render();
  });
  $$('[data-cart-receipt]').forEach(button => button.addEventListener("click", () => toggleReceiptCart(button.dataset.cartReceipt)));
  $$('[data-open-deal]').forEach(button => button.addEventListener("click", () => { if (button.dataset.openDeal) window.open(button.dataset.openDeal, "_blank"); }));
  $("#costco-sync-button")?.addEventListener("click", async () => {
    if (!window.receiptDesktop?.openCostcoSyncBrowser) return toast("Costco Sync is available in the desktop app.");
    try { await window.receiptDesktop.openCostcoSyncBrowser({ market: state.market, domain: state.market === "US" ? "costco.com" : "costco.ca" }); }
    catch (error) { toast(error.message || "The Costco Sync window could not be opened."); }
  });
  $("#scan-deals-button")?.addEventListener("click", () => scanCurrentDeals(true));
  $("#price-method-button")?.addEventListener("click", openPriceMethod);
  ["#empty-import-button"].forEach(selector => { const button = $(selector); if (button) button.addEventListener("click", () => $("#file-input").click()); });
  $("#receipt-import-button")?.addEventListener("click", () => $("#file-input").click());
  $("#receipt-import-note-button")?.addEventListener("click", () => $("#file-input").click());
  $$('[data-receipt-filter]').forEach(button => button.addEventListener("click", () => { state.receiptFilter = button.dataset.receiptFilter; resetListLimit("receipts"); render(); }));
  $$('[data-receipt-sort]').forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.receiptSort;
    state.receiptSort = state.receiptSort.key === key ? { key, direction: state.receiptSort.direction === "asc" ? "desc" : "asc" } : { key, direction: key === "date" ? "desc" : "asc" };
    resetListLimit("receipts");
    render();
  }));
  $$('[data-item-filter]').forEach(button => button.addEventListener("click", () => { state.itemFilter = button.dataset.itemFilter; resetListLimit("items"); render(); }));
  $$('[data-item-sort]').forEach(button => button.addEventListener("click", () => {
    const key = button.dataset.itemSort;
    state.itemSort = state.itemSort.key === key ? { key, direction: state.itemSort.direction === "asc" ? "desc" : "asc" } : { key, direction: key === "date" ? "desc" : "asc" };
    resetListLimit("items");
    render();
  }));
  $("#receipt-sort-select")?.addEventListener("change", event => {
    const [key, direction] = event.target.value.split("-");
    state.receiptSort = { key, direction };
    resetListLimit("receipts");
    render();
  });
  $("#item-sort-select")?.addEventListener("change", event => {
    const [key, direction] = event.target.value.split("-");
    state.itemSort = { key, direction };
    resetListLimit("items");
    render();
  });
  $$('[data-item-filter-field]').forEach(input => input.addEventListener("change", event => {
    const field = event.target.dataset.itemFilterField;
    state.itemFilters[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    resetListLimit("items");
    render();
  }));
  $$('[data-receipt-filter-field]').forEach(input => input.addEventListener("change", event => {
    state.receiptFilters[event.target.dataset.receiptFilterField] = event.target.value;
    resetListLimit("receipts");
    render();
  }));
  $("#clear-item-filters")?.addEventListener("click", () => { state.itemFilters = { from: "", to: "", minPaid: "", maxPaid: "", discountedOnly: false }; resetListLimit("items"); render(); });
  $("#clear-receipt-filters")?.addEventListener("click", () => { state.receiptFilters = { store: "", from: "", to: "", minTotal: "", maxTotal: "" }; resetListLimit("receipts"); render(); });
}

function bindImportSurface() {
  const zone = $("#drop-zone");
  const choose = $("#choose-files-button");
  if (!zone) return;
  choose?.addEventListener("click", () => $("#file-input").click());
  ["dragenter", "dragover"].forEach(event => zone.addEventListener(event, e => { e.preventDefault(); zone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach(event => zone.addEventListener(event, e => { e.preventDefault(); zone.classList.remove("dragging"); }));
  zone.addEventListener("drop", e => handleFiles(e.dataTransfer.files));
}

async function handleFiles(files) {
  const pdfs = [...files].filter(file => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return toast("Choose one or more PDF receipts.");
  let completed = 0;
  for (const file of pdfs) {
    const formData = new FormData(); formData.append("file", file);
    try {
      const response = await fetch("/api/import", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Import failed.");
      completed += 1;
    } catch (error) { toast(error.message); }
  }
  if (completed) { toast(`${completed} receipt${completed === 1 ? "" : "s"} indexed.`); state.activeView = "receipts"; await loadReceipts(); }
}

function openReceipt(id) {
  const receipt = state.receipts.find(item => item.id === id); if (!receipt) return;
  state.selectedItem = null;
  const isRefund = receiptIsRefund(receipt);
  const generatedDocument = Boolean(receipt.source?.generatedPdf);
  const carted = state.receiptCart.has(receipt.id);
  openDrawer(`<button class="drawer-close" id="drawer-close">×</button><div class="drawer-eyebrow">${isRefund ? "Refund receipt" : "Purchase receipt"}</div><h2 class="drawer-title">${escapeHtml(receipt.store || "Costco warehouse")}</h2><div class="drawer-number">${shortDate(receipt.date)} · ${marketName(receiptMarket(receipt))} · Transaction ${escapeHtml(receipt.transactionNumber || "—")}</div><div class="detail-price"><div><span>${isRefund ? "Refunded" : "Total paid"}</span><strong>${receiptMoney(receipt, receipt.total)}</strong></div><span>${receipt.items.length} item lines · ${receipt.itemCount || receipt.items.length} units</span></div><div class="detail-grid"><div class="detail-field"><label>Subtotal</label><strong>${receiptMoney(receipt, receipt.subtotal)}</strong></div><div class="detail-field"><label>Tax</label><strong>${receiptMoney(receipt, receipt.tax)}</strong></div><div class="detail-field"><label>Receipt type</label><strong>${isRefund ? "Refund / return" : "Purchase"}</strong></div><div class="detail-field"><label>Source</label><strong>${receipt.source?.key ? generatedDocument ? "Costco Sync · local PDF" : "Costco Sync · original PDF" : "Manual PDF"}</strong></div></div><div class="drawer-actions"><button class="primary-button" id="open-pdf-button" ${receipt.hasDocument === false ? "disabled" : ""}>${generatedDocument ? "Open receipt PDF" : "Open original PDF"}</button><button class="secondary-button" id="open-receipt-folder-button" ${receipt.hasDocument === false ? "disabled" : ""}>Open containing folder</button><button class="secondary-button" id="drawer-cart-button" ${receipt.hasDocument === false ? "disabled" : ""}>${carted ? "Remove from cart" : "Add to receipt cart"}</button></div><div class="drawer-section"><h3>Events on this receipt</h3>${receipt.items.map(item => `<div class="drawer-receipt item-row" data-item-id="${item.id}" data-receipt-id="${receipt.id}"><div><strong>${escapeHtml(item.name)}${quantityLabel(item)}</strong><small>#${escapeHtml(item.itemNumber)} · ${eventLabel(item)}${adjustmentText(item) ? ` · ${escapeHtml(adjustmentText(item))}` : ""} · ${receiptMoney(receipt, item.allocatedTax)} tax</small></div><strong>${receiptMoney(receipt, item.total)}</strong></div>`).join("")}</div>`);
  $("#open-pdf-button")?.addEventListener("click", () => openReceiptPdf(receipt));
  $("#open-receipt-folder-button")?.addEventListener("click", () => openReceiptFolder(receipt));
  $("#drawer-cart-button")?.addEventListener("click", () => { toggleReceiptCart(receipt.id); openReceipt(receipt.id); });
  $$(".detail-drawer .item-row").forEach(row => row.addEventListener("click", () => openItem(row.dataset.itemId, row.dataset.receiptId)));
}

function openItem(itemId, receiptId, skipEnrichment = false) {
  const item = libraryItems().find(candidate => candidate.id === itemId && candidate.receipt.id === receiptId) || libraryItems().find(candidate => candidate.id === itemId);
  if (!item) return;
  state.selectedItem = { itemId: item.id, receiptId: item.receipt.id, itemNumber: String(item.itemNumber || "") };
  const matches = libraryItems().filter(candidate => candidate.itemNumber === item.itemNumber || (item.name && normalizeName(candidate.name) === normalizeName(item.name)));
  const boughtTotal = matches.filter(match => eventType(match) === "purchase").reduce((sum, match) => sum + Number(match.total || 0), 0);
  const refundedTotal = matches.filter(match => eventType(match) === "refund").reduce((sum, match) => sum + Number(match.total || 0), 0);
  const lifetimeNet = boughtTotal + refundedTotal;
  const costcoLinkAction = item.product?.productUrl ? `<button class="secondary-button" id="open-costco-link-button">Open Costco Link</button>` : "";
  const receiptCartAction = `<button class="secondary-button" id="add-item-receipt-cart" ${item.receipt.hasDocument === false ? "disabled" : ""}>${state.receiptCart.has(item.receipt.id) ? "Remove receipt from cart" : "Add receipt to cart"}</button>`;
  const suggestedLabel = item.product?.productUrl ? displayName(item) : item.product?.lookupStatus === "not-found" ? "No automatic match" : "Searching automatically";
  openDrawer(`<button class="drawer-close" id="drawer-close">×</button><div class="drawer-eyebrow">${eventType(item) === "refund" ? "Refund event" : "Purchase event"}</div>${productImage(item)}<h2 class="drawer-title">${escapeHtml(displayName(item))}${quantityLabel(item)}</h2><div class="drawer-number">Item #${escapeHtml(item.itemNumber)} · Receipt name: ${escapeHtml(item.name)}</div><div class="detail-price"><div><span>${eventType(item) === "refund" ? "Refunded" : "Total paid"}</span><strong>${money(item.total)}</strong></div><span>${enrichmentLabel(item)}</span></div><p class="metadata-note">${escapeHtml(enrichmentDescription(item))}</p><div class="detail-grid"><div class="detail-field"><label>Suggested product</label><strong>${escapeHtml(suggestedLabel)}</strong></div><div class="detail-field"><label>Costco listing</label><strong>${item.product?.productUrl ? "Matched" : "Not matched yet"}</strong></div><div class="detail-field"><label>Quantity</label><strong>${Number(item.quantity || 1)}</strong></div><div class="detail-field"><label>Unit price</label><strong>${money(item.unitAmount ?? (Number(item.grossAmount || item.amount || 0) / Number(item.quantity || 1)))}</strong></div><div class="detail-field"><label>Gross item amount</label><strong>${money(item.grossAmount ?? item.amount)}</strong></div><div class="detail-field"><label>Discount</label><strong>${Number(item.discount || 0) ? money(item.discount) : "None"}</strong></div><div class="detail-field"><label>Allocated tax</label><strong>${money(item.allocatedTax)}</strong></div><div class="detail-field"><label>Receipt date</label><strong>${shortDate(item.receipt.date)}</strong></div></div><div class="drawer-actions"><button class="primary-button" id="open-item-pdf" ${item.receipt.hasDocument === false ? "disabled" : ""}>Open Receipt</button><button class="secondary-button" id="open-item-folder-button" ${item.receipt.hasDocument === false ? "disabled" : ""}>Open Folder</button>${receiptCartAction}<button class="secondary-button" id="find-product-details-button">Find Product Details</button>${costcoLinkAction}</div><div class="drawer-section"><h3>Item position</h3><div class="detail-grid"><div class="detail-field"><label>Purchases</label><strong>${money(boughtTotal)}</strong></div><div class="detail-field"><label>Refunds</label><strong>${money(refundedTotal)}</strong></div><div class="detail-field"><label>Net position</label><strong>${money(lifetimeNet)}</strong></div><div class="detail-field"><label>Events</label><strong>${matches.length}</strong></div></div></div><div class="drawer-section"><h3>Purchase history · ${matches.length} events</h3>${matches.map(match => `<div class="drawer-receipt"><div><strong><span class="event-label ${eventClass(match)}">${eventLabel(match)}</span> · ${shortDate(match.receipt.date)}</strong><small>${escapeHtml(match.receipt.store || "Costco warehouse")} · ${adjustmentText(match) || "No adjustment"}${linkedHistoryText(match) ? ` · ${escapeHtml(linkedHistoryText(match))}` : ""} · ${money(match.allocatedTax)} tax allocated</small></div><strong>${money(match.total)}</strong></div>`).join("")}</div>`);
  $("#open-item-pdf")?.addEventListener("click", () => openReceiptPdf(item.receipt));
  $("#open-item-folder-button")?.addEventListener("click", () => openReceiptFolder(item.receipt));
  $("#add-item-receipt-cart")?.addEventListener("click", () => { toggleReceiptCart(item.receipt.id); openItem(item.id, item.receipt.id, true); });
  $("#find-product-details-button")?.addEventListener("click", async () => {
    if (!window.receiptDesktop?.openProductBrowser) return window.open(googleProductSearchUrl(item), "_blank");
    try {
      await window.receiptDesktop.openProductBrowser({ itemNumber: item.itemNumber, name: item.name, domain: costcoDomainForItem(item) });
      toast(`Open a Costco result. ${PRODUCT_NAME} will save its details automatically.`);
    } catch (error) {
      toast(error.message || "The product browser could not be opened.");
    }
  });
  $("#open-costco-link-button")?.addEventListener("click", () => window.open(item.product.productUrl, "_blank"));
  if (!skipEnrichment) queueProductEnrichment([item], true);
}

function openDrawer(content) { const drawer = $("#detail-drawer"); drawer.innerHTML = content; drawer.classList.add("open"); $("#drawer-backdrop").classList.add("open"); drawer.setAttribute("aria-hidden", "false"); $("#drawer-close")?.addEventListener("click", closeDrawer); }
function closeDrawer() { state.selectedItem = null; $("#detail-drawer").classList.remove("open"); $("#drawer-backdrop").classList.remove("open"); $("#detail-drawer").setAttribute("aria-hidden", "true"); }
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(window.__toast); window.__toast = setTimeout(() => element.classList.remove("show"), 2800); }

async function changeMarket(nextMarket) {
  const market = nextMarket === "US" ? "US" : "CA";
  if (market === state.market) return;
  const previous = state.market;
  const select = $("#market-select");
  select.disabled = true;
  state.market = market;
  activeCurrency = market === "US" ? "USD" : "CAD";
  state.query = "";
  state.syncProgress = null;
  state.sync = state.syncByMarket[market] || { market, status: "never", lastSyncedAt: null, receiptCount: 0, identity: {} };
  state.deals = [];
  state.dealScan = { market, status: "never", scannedAt: null, pages: [], errors: [] };
  state.priceMatches = { matches: [], alreadySaved: [], potentialSavings: 0, appliedSavings: 0, scannedDealCount: 0, horizonDays: 30, market };
  state.listLimits = { items: PAGE_SIZE.items, receipts: PAGE_SIZE.receipts, price: PAGE_SIZE.price };
  closeDrawer();
  render();
  try {
    const response = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market }) });
    if (!response.ok) throw new Error((await response.json()).error || "Market could not be saved.");
    await loadSupplementalData();
    render();
    maybeScanDeals();
  } catch (error) {
    state.market = previous;
    activeCurrency = previous === "US" ? "USD" : "CAD";
    toast(error.message || "Market could not be changed.");
    await loadSupplementalData();
    render();
  } finally {
    select.disabled = false;
  }
}

$$('.nav-item').forEach(button => button.addEventListener("click", () => { state.activeView = button.dataset.view; state.query = ""; resetListLimit(state.activeView); render(); }));
$("#search-input").addEventListener("input", event => { state.query = event.target.value; resetListLimit(state.activeView); render(); });
$("#market-select").addEventListener("change", event => changeMarket(event.target.value));
$("#import-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", event => handleFiles(event.target.files));
$("#refresh-button").addEventListener("click", loadReceipts);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
$("#top-cart-button").addEventListener("click", openReceiptCart);
document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search-input").focus(); } if (event.key === "Escape") closeDrawer(); });

window.receiptDesktop?.onProductMetadataSaved?.(({ itemNumber, product }) => {
  if (!itemNumber || !product) return;
  applyProductToState(itemNumber, product);
  updateSuggestedProductCells(itemNumber);
  if (state.selectedItem?.itemNumber === String(itemNumber)) openItem(state.selectedItem.itemId, state.selectedItem.receiptId, true);
  toast(`Saved product details for ${product.canonicalName || `item ${itemNumber}`}.`);
});

window.receiptDesktop?.onReceiptSyncProgress?.(payload => {
  const appliesToCurrentMarket = !payload.market || payload.market === state.market;
  if (appliesToCurrentMarket) state.syncProgress = payload.phase === "browser-closed" ? null : payload;
  if (appliesToCurrentMarket && state.activeView === "receipts") render();
  if (payload.phase === "complete") {
    toast(payload.message || "Costco receipt sync finished.");
    loadReceipts();
  } else if (payload.phase === "error") {
    toast(payload.message || "Costco receipt sync could not finish.");
    loadSupplementalData().then(() => { if (state.activeView === "receipts") render(); });
  } else if (payload.phase === "browser-closed" && appliesToCurrentMarket) {
    loadSupplementalData().then(() => { if (state.activeView === "receipts") render(); });
  }
});

loadReceipts();
