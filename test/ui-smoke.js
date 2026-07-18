const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const UI_URL = process.env.COSTCO_RECEIPT_ORGANIZER_UI_URL || process.env.RECEIPT_UI_URL || "http://127.0.0.1:8901";
const SCREENSHOT_DIR = process.env.COSTCO_RECEIPT_ORGANIZER_QA_SCREENSHOT_DIR || process.env.RECEIPT_QA_SCREENSHOT_DIR || "";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(contents, expression, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await contents.executeJavaScript(`Boolean(${expression})`)) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function viewMetrics(contents, rowSelector, fixedSelector) {
  return contents.executeJavaScript(`(() => {
    const scroll = document.querySelector("#view-content .data-scroll");
    const fixed = document.querySelector(${JSON.stringify(fixedSelector)});
    const sidebar = document.querySelector(".sidebar");
    const sentinel = scroll?.querySelector(".infinite-sentinel");
    return {
      rows: document.querySelectorAll(${JSON.stringify(rowSelector)}).length,
      total: Number(sentinel?.dataset.total || document.querySelectorAll(${JSON.stringify(rowSelector)}).length),
      scrollTop: scroll?.scrollTop || 0,
      scrollHeight: scroll?.scrollHeight || 0,
      clientHeight: scroll?.clientHeight || 0,
      overflowY: scroll ? getComputedStyle(scroll).overflowY : "",
      fixedTop: fixed?.getBoundingClientRect().top,
      sidebarTop: sidebar?.getBoundingClientRect().top,
      bodyOverflow: getComputedStyle(document.body).overflow,
      hasBottomBar: Boolean(document.querySelector(".selection-bar")),
      hasTopCart: Boolean(document.querySelector("#top-cart-button")),
      hasQtyColumn: [...document.querySelectorAll(".table-head button")].some(button => button.textContent.trim().startsWith("Qty"))
    };
  })()`);
}

async function loadMore(contents) {
  await contents.executeJavaScript(`(() => {
    const scroll = document.querySelector("#view-content .data-scroll");
    scroll.scrollTop = scroll.scrollHeight;
  })()`);
  await pause(900);
}

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await window.loadURL(UI_URL);
  await waitFor(window.webContents, `document.querySelectorAll(".item-row").length > 0`);
  const capture = async name => {
    if (!SCREENSHOT_DIR) return;
    await pause(300);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const image = await window.webContents.capturePage();
    fs.writeFileSync(path.join(SCREENSHOT_DIR, `${name}.png`), image.toPNG());
  };

  const itemsBefore = await viewMetrics(window.webContents, ".table-shell > .item-row", ".search-bar-shell");
  await capture("items");
  assert.equal(itemsBefore.bodyOverflow, "hidden");
  assert.equal(itemsBefore.hasBottomBar, false);
  assert.equal(itemsBefore.hasTopCart, true);
  assert.equal(itemsBefore.hasQtyColumn, true);
  assert(["auto", "scroll"].includes(itemsBefore.overflowY));
  assert(itemsBefore.scrollHeight > itemsBefore.clientHeight);
  await loadMore(window.webContents);
  const itemsAfter = await viewMetrics(window.webContents, ".table-shell > .item-row", ".search-bar-shell");
  assert(itemsAfter.rows > itemsBefore.rows, `Expected item infinite scroll to load beyond ${itemsBefore.rows} rows`);
  assert(Math.abs(itemsAfter.fixedTop - itemsBefore.fixedTop) < 1);
  assert(Math.abs(itemsAfter.sidebarTop - itemsBefore.sidebarTop) < 1);

  await window.webContents.executeJavaScript(`document.querySelector('[data-view="receipts"]').click()`);
  await waitFor(window.webContents, `document.querySelectorAll(".receipt-table-row").length > 0`);
  const receiptsBefore = await viewMetrics(window.webContents, ".receipt-table-row", ".receipt-controls");
  await capture("receipts");
  assert(receiptsBefore.scrollHeight > receiptsBefore.clientHeight);
  await loadMore(window.webContents);
  const receiptsAfter = await viewMetrics(window.webContents, ".receipt-table-row", ".receipt-controls");
  if (receiptsBefore.total > receiptsBefore.rows) {
    assert(receiptsAfter.rows > receiptsBefore.rows, `Expected receipt infinite scroll to load beyond ${receiptsBefore.rows} rows`);
  }
  assert(Math.abs(receiptsAfter.fixedTop - receiptsBefore.fixedTop) < 1);
  assert(Math.abs(receiptsAfter.sidebarTop - receiptsBefore.sidebarTop) < 1);
  await window.webContents.executeJavaScript(`document.querySelector('[data-receipt-cart]:not(:disabled)').click()`);
  await waitFor(window.webContents, `document.querySelector("#top-cart-count")?.textContent.trim() === "1"`);
  await window.webContents.executeJavaScript(`document.querySelector("#top-cart-button").click()`);
  await waitFor(window.webContents, `document.querySelector("#detail-drawer.open")`);
  const cartText = await window.webContents.executeJavaScript(`document.querySelector("#detail-drawer").innerText`);
  assert(cartText.includes("Create ZIP"));
  assert(cartText.includes("Copy to folder"));
  assert(cartText.includes("Share"));
  await window.webContents.executeJavaScript(`document.querySelector("#drawer-close").click()`);

  await window.webContents.executeJavaScript(`document.querySelector('[data-view="price-match"]').click()`);
  await waitFor(window.webContents, `document.querySelector(".price-data-scroll")`);
  await capture("price-match");
  const priceLayout = await window.webContents.executeJavaScript(`(() => ({
    scrollable: ["auto", "scroll"].includes(getComputedStyle(document.querySelector(".price-data-scroll")).overflowY),
    toolbarVisible: Boolean(document.querySelector(".price-toolbar")),
    summaryVisible: Boolean(document.querySelector(".price-summary")),
    methodButton: Boolean(document.querySelector("#price-method-button"))
  }))()`);
  assert.deepEqual(priceLayout, { scrollable: true, toolbarVisible: true, summaryVisible: true, methodButton: true });

  await window.webContents.executeJavaScript(`(() => {
    state.priceMatches = {
      matches: Array.from({ length: 45 }, (_, index) => ({
        id: "qa-match-" + index,
        receiptId: state.receipts[0].id,
        itemId: "qa-item-" + index,
        itemNumber: String(900000 + index),
        name: "QA price match " + (index + 1),
        date: "2026-07-10",
        store: "QA warehouse",
        quantity: 1,
        paidPerUnit: 19.99,
        salePrice: 14.99,
        potentialSavings: 5,
        confidence: "exact item number",
        deal: { name: "QA sale item " + (index + 1), pageUrl: "https://www.costco.ca/", source: "QA" }
      })),
      alreadySaved: [],
      potentialSavings: 225,
      appliedSavings: 0,
      scannedDealCount: 45,
      horizonDays: 30,
      market: state.market
    };
    state.listLimits.price = 30;
    render();
  })()`);
  await waitFor(window.webContents, `document.querySelectorAll(".match-row").length === 30`);
  const priceBefore = await viewMetrics(window.webContents, ".match-row", ".price-toolbar");
  await loadMore(window.webContents);
  const priceAfter = await viewMetrics(window.webContents, ".match-row", ".price-toolbar");
  assert(priceAfter.rows > priceBefore.rows, `Expected Price Match infinite scroll to load beyond ${priceBefore.rows} rows`);
  assert(Math.abs(priceAfter.fixedTop - priceBefore.fixedTop) < 1);
  assert(Math.abs(priceAfter.sidebarTop - priceBefore.sidebarTop) < 1);

  await window.webContents.executeJavaScript(`document.querySelector("#price-method-button").click()`);
  await waitFor(window.webContents, `document.querySelector("#detail-drawer.open")`);
  const methodText = await window.webContents.executeJavaScript(`document.querySelector("#detail-drawer").innerText`);
  assert(methodText.includes("no setup form"));
  assert(methodText.includes("locally"));
  await window.webContents.executeJavaScript(`document.querySelector("#drawer-close").click()`);

  await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#market-select");
    select.value = "US";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(window.webContents, `document.querySelector("#market-select").value === "US" && document.querySelector(".page-intro")?.textContent.includes("United States")`);
  const settings = await (await fetch(`${UI_URL}/api/settings`)).json();
  assert.equal(settings.settings.market, "US");
  await window.webContents.executeJavaScript(`(() => {
    const select = document.querySelector("#market-select");
    select.value = "CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(window.webContents, `document.querySelector("#market-select").value === "CA"`);

  console.log(JSON.stringify({ itemsBefore, itemsAfter, receiptsBefore, receiptsAfter, priceLayout, priceBefore, priceAfter }, null, 2));
  window.destroy();
  app.quit();
}

run().catch(error => {
  console.error(error.stack || error);
  app.exit(1);
});
