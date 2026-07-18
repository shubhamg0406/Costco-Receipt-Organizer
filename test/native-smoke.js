const assert = require("assert");
const http = require("http");
const { app, BrowserWindow } = require("electron");
const { injectSyncToolbar } = require("../electron/costco-sync");

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const PRODUCT_URL = "https://www.costco.ca/p/-/licensed-womens-pajama-set-2-piece/4000442449";
const IMAGE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const mockServer = http.createServer((request, response) => {
  if (request.url.startsWith("/image.png")) {
    response.writeHead(200, { "Content-Type": "image/png", "Content-Length": IMAGE_PNG.length });
    return response.end(IMAGE_PNG);
  }
  if (request.url.startsWith("/search")) {
    const origin = `http://127.0.0.1:${mockServer.address().port}`;
    const page = `<!doctype html><html><body><main><a href="${PRODUCT_URL}"><article><img src="${origin}/image.png" width="160" height="120" alt="Product"><h3>Licensed Women's Pajama Set, 2-piece</h3></article></a></main></body></html>`;
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(page) });
    return response.end(page);
  }
  const page = "<!doctype html><html><body><main><h1>Costco account fixture</h1></main></body></html>";
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(page) });
  response.end(page);
});

async function waitFor(callback, label, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await callback().catch(() => null);
    if (value) return value;
    await pause(150);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function run() {
  require("../electron/main");
  await app.whenReady();

  const mainWindow = await waitFor(async () => {
    const candidate = BrowserWindow.getAllWindows().find(window => /Costco Receipt Organizer/.test(window.getTitle()) && /^http:\/\/127\.0\.0\.1:/.test(window.webContents.getURL()));
    if (!candidate) return null;
    const ready = await candidate.webContents.executeJavaScript(`Boolean(window.receiptDesktop?.openCostcoSyncBrowser && document.querySelector('[data-view="receipts"]'))`);
    return ready ? candidate : null;
  }, "the Costco Receipt Organizer desktop window");

  const runs = [];
  for (const market of ["CA", "US"]) {
    const marketLabel = market === "US" ? "United States" : "Canada";
    const result = await mainWindow.webContents.executeJavaScript(`window.receiptDesktop.openCostcoSyncBrowser({ market: ${JSON.stringify(market)} })`);
    assert.equal(result.market, market);
    const syncWindow = await waitFor(async () => BrowserWindow.getAllWindows().find(window => window !== mainWindow && !window.isDestroyed()), `the Costco ${marketLabel} sync window`);
    await waitFor(async () => await syncWindow.webContents.executeJavaScript(`Boolean(document.querySelector("#receipt-costco-sync-bar"))`), `the Costco ${marketLabel} sync toolbar`);
    const loadedUrl = syncWindow.webContents.getURL();

    const toolbar = await waitFor(async () => {
      await injectSyncToolbar(syncWindow.webContents, {
        market,
        status: "105 receipts are now in Costco Receipt Organizer. Sync is up to date; choose Done to close.",
        accountLabel: "member@example.com · Member 123456789012",
        progress: 100,
        complete: true
      });
      const current = await syncWindow.webContents.executeJavaScript(`(() => {
        const bar = document.querySelector("#receipt-costco-sync-bar");
        return bar ? { text: bar.innerText, buttons: [...bar.querySelectorAll("button")].map(button => button.textContent) } : null;
      })()`);
      return current?.text.includes("member@example.com") ? current : null;
    }, `the settled Costco ${marketLabel} sync toolbar`);
    assert(toolbar.text.includes(`Costco ${marketLabel}`));
    assert(toolbar.text.includes("member@example.com"));
    assert(toolbar.text.includes("Member 123456789012"));
    assert(toolbar.text.includes("Sync is up to date"));
    assert(toolbar.buttons.includes("Done"));

    await syncWindow.webContents.executeJavaScript(`[...document.querySelectorAll("#receipt-costco-sync-bar button")].find(button => button.textContent === "Done").click()`);
    await waitFor(async () => syncWindow.isDestroyed(), `the Costco ${marketLabel} sync window to close`);
    assert.equal(BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).length, 1);
    runs.push({ opened: result, loadedUrl, toolbar, closed: true });
  }

  const productResult = await mainWindow.webContents.executeJavaScript(`window.receiptDesktop.openProductBrowser({ itemNumber: "1969525", name: "K.SPADE PJ", domain: "Costco.ca" })`);
  const productWindow = await waitFor(async () => BrowserWindow.getAllWindows().find(window => window !== mainWindow && !window.isDestroyed()), "the product-details mini browser");
  await waitFor(async () => await productWindow.webContents.executeJavaScript(`document.querySelector("#receipt-product-browser-bar")?.innerText.includes("Saved first Costco result")`), "the first Costco result to be saved");
  const productToolbar = await productWindow.webContents.executeJavaScript(`(() => {
    const bar = document.querySelector("#receipt-product-browser-bar");
    return { text: bar.innerText, buttons: [...bar.querySelectorAll("button")].map(button => button.textContent) };
  })()`);
  const productLoadedUrl = productWindow.webContents.getURL();
  assert(productResult.query.includes("1969525"));
  assert(productToolbar.text.includes("Saved first Costco result"));
  assert(productToolbar.buttons.includes("Done"));
  const savedProduct = await mainWindow.webContents.executeJavaScript(`fetch("/api/products").then(response => response.json()).then(data => data.products.find(product => String(product.key) === "1969525"))`);
  assert.equal(savedProduct.productUrl, PRODUCT_URL);
  assert.equal(savedProduct.canonicalName, "Licensed Women's Pajama Set, 2-piece");
  assert(savedProduct.imageUrl.includes("/image.png"));
  assert.equal(savedProduct.source, "In-app Google Costco match");
  await productWindow.webContents.executeJavaScript(`[...document.querySelectorAll("#receipt-product-browser-bar button")].find(button => button.textContent === "Done").click()`);
  await waitFor(async () => productWindow.isDestroyed(), "the product-details mini browser to close");

  console.log(JSON.stringify({ runs, productBrowser: { opened: productResult, loadedUrl: productLoadedUrl, toolbar: productToolbar, saved: { name: savedProduct.canonicalName, hasImage: Boolean(savedProduct.imageUrl), source: savedProduct.source }, closed: true } }, null, 2));
  mainWindow.destroy();
}

mockServer.listen(0, "127.0.0.1", async () => {
  const origin = `http://127.0.0.1:${mockServer.address().port}`;
  process.env.COSTCO_RECEIPT_ORGANIZER_PRODUCT_SEARCH_URL = `${origin}/search`;
  process.env.COSTCO_RECEIPT_ORGANIZER_COSTCO_CA_URL = `${origin}/account?market=CA`;
  process.env.COSTCO_RECEIPT_ORGANIZER_COSTCO_US_URL = `${origin}/account?market=US`;
  try {
    await run();
    await new Promise(resolve => mockServer.close(resolve));
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    mockServer.close();
    app.exit(1);
  }
});
