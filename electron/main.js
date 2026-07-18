const { app, BrowserWindow, shell, ipcMain, dialog, ShareMenu } = require("electron");
const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const os = require("os");
const childProcess = require("child_process");
const { hasReceiptLibrary, migrateLegacyUserData } = require("./user-data");
const {
  createPdfRenderer,
  fetchReceiptsFromPage,
  injectSyncToolbar,
  readCostcoIdentity,
  renderReceiptPdf,
  syncDateRange
} = require("./costco-sync");

let port;
let localURL;
let localServerReady;
let mainWindow;
let localDataDirectory;
let costcoSyncWindow;
let costcoSyncRunning = false;
let costcoSyncToolbar = {};
let costcoSyncMarket = "CA";
const PRODUCT_NAME = "Costco Receipt Organizer";
const LEGACY_PRODUCT_NAME = "Receipt";
const CHROME_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

// Keep the library in a predictable, user-visible macOS application folder.
// This is separate from the app bundle, so reinstalling the app does not erase receipts.
const configuredUserDataDirectory = process.env.COSTCO_RECEIPT_ORGANIZER_USER_DATA_DIR || process.env.RECEIPT_USER_DATA_DIR;
const legacyUserDataDirectory = path.join(app.getPath("appData"), LEGACY_PRODUCT_NAME);
let defaultUserDataDirectory = path.join(app.getPath("appData"), PRODUCT_NAME);
if (!configuredUserDataDirectory && hasReceiptLibrary(legacyUserDataDirectory) && !hasReceiptLibrary(defaultUserDataDirectory)) {
  const migrated = migrateLegacyUserData(legacyUserDataDirectory, defaultUserDataDirectory);
  if (!migrated) defaultUserDataDirectory = legacyUserDataDirectory;
}
app.setPath("userData", configuredUserDataDirectory || defaultUserDataDirectory);

const hasAppLock = app.requestSingleInstanceLock();
if (!hasAppLock) app.quit();

function appSourceDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app.asar")
    : path.resolve(__dirname, "..");
}

function seedDataDirectory(sourceDirectory, dataDirectory) {
  if (fs.existsSync(path.join(dataDirectory, "index.json"))) return;

  const legacyDirectory = path.dirname(dataDirectory);
  const seedDirectory = fs.existsSync(path.join(legacyDirectory, "index.json"))
    ? legacyDirectory
    : !app.isPackaged
    ? path.join(sourceDirectory, ".costco-data")
    : null;

  fs.mkdirSync(dataDirectory, { recursive: true });
  if (seedDirectory && fs.existsSync(seedDirectory)) {
    for (const entry of ["index.json", "receipts"]) {
      const source = path.join(seedDirectory, entry);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(dataDirectory, entry), { recursive: true });
    }
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const selectedPort = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selectedPort));
    });
  });
}

ipcMain.handle("open-receipt-folder", (_event, receiptId) => {
  if (!localDataDirectory) throw new Error("The receipt library is still starting.");
  const indexPath = path.join(localDataDirectory, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const receipt = (index.receipts || []).find(item => item.id === receiptId);
  if (!receipt) throw new Error("Receipt not found.");
  const filePath = path.join(localDataDirectory, "receipts", receipt.storedName || `${receipt.id}.pdf`);
  if (!fs.existsSync(filePath)) throw new Error("The original PDF is missing from the local library.");
  shell.showItemInFolder(filePath);
  return { ok: true };
});

function readLocalIndex() {
  if (!localDataDirectory) throw new Error("The receipt library is still starting.");
  return JSON.parse(fs.readFileSync(path.join(localDataDirectory, "index.json"), "utf8"));
}

function selectedReceiptFiles(receiptIds) {
  const selected = new Set((receiptIds || []).map(String));
  if (!selected.size) throw new Error("Choose at least one receipt first.");
  const index = readLocalIndex();
  const files = [];
  for (const receipt of index.receipts || []) {
    if (!selected.has(String(receipt.id))) continue;
    const filePath = path.join(localDataDirectory, "receipts", receipt.storedName || `${receipt.id}.pdf`);
    if (fs.existsSync(filePath)) files.push({ receipt, filePath });
  }
  if (!files.length) throw new Error("None of the selected receipt documents could be found.");
  return files;
}

function safeReceiptName(receipt, usedNames) {
  const original = String(receipt.fileName || `${receipt.id}.pdf`).replace(/[/:\\]/g, "-").replace(/^\.+/, "").trim() || `${receipt.id}.pdf`;
  const extension = path.extname(original) || ".pdf";
  const base = path.basename(original, path.extname(original));
  let name = `${base}${extension}`;
  let copy = 2;
  while (usedNames.has(name.toLowerCase())) name = `${base} (${copy++})${extension}`;
  usedNames.add(name.toLowerCase());
  return name;
}

function copyReceiptFiles(files, destination) {
  const usedNames = new Set();
  return files.map(({ receipt, filePath }) => {
    const name = safeReceiptName(receipt, usedNames);
    const outputPath = path.join(destination, name);
    fs.copyFileSync(filePath, outputPath);
    return outputPath;
  });
}

ipcMain.handle("copy-receipts-to-folder", async (event, receiptIds) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showOpenDialog(owner, {
    title: "Choose a folder for the selected receipts",
    buttonLabel: "Copy Receipts",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const copied = copyReceiptFiles(selectedReceiptFiles(receiptIds), result.filePaths[0]);
  shell.showItemInFolder(copied[0]);
  return { canceled: false, count: copied.length, directory: result.filePaths[0] };
});

ipcMain.handle("zip-receipts", async (event, receiptIds) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const date = new Date().toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog(owner, {
    title: "Save receipt bundle",
    defaultPath: path.join(app.getPath("downloads"), `Costco receipts ${date}.zip`),
    buttonLabel: "Create ZIP",
    filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-bundle-"));
  const bundleDirectory = path.join(stagingRoot, "Costco receipts");
  fs.mkdirSync(bundleDirectory);
  try {
    const copied = copyReceiptFiles(selectedReceiptFiles(receiptIds), bundleDirectory);
    if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath);
    childProcess.execFileSync("/usr/bin/zip", ["-q", "-r", result.filePath, path.basename(bundleDirectory)], { cwd: stagingRoot });
    shell.showItemInFolder(result.filePath);
    return { canceled: false, count: copied.length, filePath: result.filePath };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

ipcMain.handle("share-receipts", (event, receiptIds) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const files = selectedReceiptFiles(receiptIds);
  const menu = new ShareMenu({ filePaths: files.map(file => file.filePath) });
  menu.popup({ window: owner });
  return { ok: true, count: files.length };
});

function isCostcoProductUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "costco.ca" || hostname.endsWith(".costco.ca")
      || hostname === "costco.com" || hostname.endsWith(".costco.com");
  } catch {
    return false;
  }
}

function normalizeCostcoDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  if (domain === "costco.com") return "Costco.com";
  return "Costco.ca";
}

function productMetadataScript() {
  return `(() => {
    const readJsonLd = () => {
      const values = [];
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(script.textContent || '{}');
          values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {}
      }
      const flattened = values.flatMap(value => Array.isArray(value?.['@graph']) ? value['@graph'] : [value]);
      return flattened.find(value => {
        const type = value?.['@type'];
        return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      });
    };
    const product = readJsonLd();
    const meta = selector => document.querySelector(selector)?.content?.trim() || '';
    const productImage = product?.image;
    const structuredImage = Array.isArray(productImage)
      ? productImage[0]
      : typeof productImage === 'object' ? productImage?.url || productImage?.contentUrl : productImage;
    const imageCandidate = [...document.images]
      .filter(image => image.complete && image.naturalWidth >= 240 && image.naturalHeight >= 180)
      .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
    const structuredBrand = typeof product?.brand === 'object' ? product.brand?.name : product?.brand;
    const title = String(product?.name || meta('meta[property="og:title"]') || document.querySelector('h1')?.textContent || document.title || '').trim();
    const imageUrl = String(structuredImage || meta('meta[property="og:image"]') || imageCandidate?.currentSrc || imageCandidate?.src || '').trim();
    const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const brand = String(structuredBrand || '').trim();
    const category = String(product?.category || '').trim();
    const blocked = /access denied|forbidden|not found|not able to find a match|we(?:'|’)re sorry|not available|page unavailable/i.test(title);
    return blocked ? {} : { title, imageUrl, canonicalUrl, brand, category };
  })()`;
}

function googleCostcoResultScript(domain) {
  return `(() => {
    const expectedDomain = ${JSON.stringify(String(domain || "Costco.ca").toLowerCase())};
    const normalizeHref = rawHref => {
      try {
        const parsed = new URL(rawHref, location.href);
        if (parsed.hostname.endsWith('google.com') && parsed.pathname === '/url') {
          return parsed.searchParams.get('q') || parsed.searchParams.get('url') || '';
        }
        return parsed.href;
      } catch { return ''; }
    };
    const nearbyImage = anchor => {
      let node = anchor;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const image = [...node.querySelectorAll('img')].find(candidate => /^https?:/i.test(candidate.currentSrc || candidate.src || '') && candidate.width >= 60 && candidate.height >= 45);
        if (image) return image.currentSrc || image.src || '';
      }
      return '';
    };
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = normalizeHref(anchor.href);
      if (!url) continue;
      try {
        const parsed = new URL(url);
        const hostname = parsed.hostname.toLowerCase();
        const domainMatches = hostname === expectedDomain || hostname.endsWith('.' + expectedDomain);
        const excluded = parsed.pathname === '/' || /\\/(?:search|category|warehouse-locations?)(?:\\/|$)/i.test(parsed.pathname);
        if (!domainMatches || excluded) continue;
        const title = String(anchor.querySelector('h3')?.textContent || anchor.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!title) continue;
        return { title, url: parsed.href, imageUrl: nearbyImage(anchor) };
      } catch {}
    }
    return null;
  })()`;
}

function productSearchUrl(query, includeBrowserMarker = false) {
  const configured = process.env.COSTCO_RECEIPT_ORGANIZER_PRODUCT_SEARCH_URL;
  const url = configured ? new URL(configured) : new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  if (includeBrowserMarker) url.hash = "receipt-product-browser";
  return url.href;
}

async function extractProductMetadataFromContents(contents) {
  return await contents.executeJavaScript(productMetadataScript()) || {};
}

async function saveProductFromBrowser(item, metadata, query, domain) {
  if (!localURL || !item.itemNumber) throw new Error("The receipt library is still starting.");
  const updates = {
    canonicalName: metadata.title || item.name,
    productUrl: metadata.canonicalUrl,
    source: metadata.source || "In-app Costco browser",
    autoMatched: Boolean(metadata.autoMatched),
    matchQuery: query,
    costcoDomain: domain,
    lookupStatus: "matched",
    lookupAttemptedAt: new Date().toISOString()
  };
  if (metadata.brand) updates.brand = metadata.brand;
  if (metadata.category) updates.category = metadata.category;
  if (metadata.imageUrl) updates.imageUrl = metadata.imageUrl;
  const response = await fetch(`${localURL}/api/products/${encodeURIComponent(item.itemNumber)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates)
  });
  if (!response.ok) throw new Error("Product details could not be saved.");
  return (await response.json()).product;
}

async function injectProductBrowserToolbar(contents, query, status, statusKind = "neutral", complete = false) {
  const model = { query, status, statusKind, complete };
  try {
    await contents.executeJavaScript(`(() => {
      const model = ${JSON.stringify(model)};
      let bar = document.getElementById('receipt-product-browser-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'receipt-product-browser-bar';
        document.documentElement.appendChild(bar);
      }
      bar.replaceChildren();
      bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;height:44px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#ffffff;border-bottom:1px solid #dfe5e2;color:#172023;font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 8px rgba(23,32,35,.08)';
      const button = (label, action) => {
        const element = document.createElement('button');
        element.textContent = label;
        element.style.cssText = 'border:1px solid #dfe5e2;background:#fff;color:#35423e;border-radius:6px;padding:5px 9px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer';
        element.addEventListener('click', action);
        return element;
      };
      bar.append(button('Back', () => history.back()), button('Reload', () => location.reload()));
      const query = document.createElement('span');
      query.textContent = model.query;
      query.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#687873';
      bar.append(query);
      const status = document.createElement('strong');
      status.textContent = model.status;
      status.style.cssText = 'margin-left:auto;white-space:nowrap;color:' + (model.statusKind === 'success' ? '#216a57' : model.statusKind === 'error' ? '#a94d43' : '#35423e');
      bar.append(status);
      bar.append(button(model.complete ? 'Done' : 'Close', () => { location.href = 'receipt-product://close'; }));
      if (document.body) document.body.style.paddingTop = '44px';
    })()`);
  } catch {}
}

ipcMain.handle("open-product-browser", async (event, item = {}) => {
  await localServerReady;
  const domain = normalizeCostcoDomain(item.domain);
  const itemNumber = String(item.itemNumber || "").replace(/\s+/g, " ").trim();
  const name = String(item.name || "").replace(/\s+/g, " ").trim();
  if (!itemNumber && !name) throw new Error("An item number or name is required.");
  const query = `${domain} Item ${itemNumber} ${name}`.replace(/\s+/g, " ").trim();
  const searchUrl = productSearchUrl(query, true);
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const browser = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 620,
    show: false,
    parent: owner && !owner.isDestroyed() ? owner : undefined,
    title: `Find Product Details — ${name || itemNumber}`,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  browser.webContents.setUserAgent(CHROME_USER_AGENT);
  let lastCapturedUrl = "";
  let savedGoogleResultUrl = "";
  let googleFallbackProduct = null;

  const interceptProductBrowser = (navigationEvent, url) => {
    if (!url.startsWith("receipt-product://close")) return false;
    navigationEvent?.preventDefault?.();
    if (!browser.isDestroyed()) browser.close();
    return true;
  };
  browser.webContents.on("will-navigate", interceptProductBrowser);
  browser.webContents.setWindowOpenHandler(({ url }) => {
    if (interceptProductBrowser(null, url)) return { action: "deny" };
    if (/^https?:\/\//i.test(url)) browser.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  browser.webContents.on("did-finish-load", async () => {
    const currentUrl = browser.webContents.getURL();
    if (!isCostcoProductUrl(currentUrl)) {
      await injectProductBrowserToolbar(browser.webContents, query, "Finding the first Costco result…");
      try {
        const result = await browser.webContents.executeJavaScript(googleCostcoResultScript(domain));
        if (result?.url && result.url !== savedGoogleResultUrl) {
          savedGoogleResultUrl = result.url;
          googleFallbackProduct = await saveProductFromBrowser({ ...item, itemNumber, name }, {
            title: result.title || name,
            imageUrl: result.imageUrl || "",
            canonicalUrl: result.url,
            source: "In-app Google Costco match",
            autoMatched: true
          }, query, domain);
          if (owner && !owner.isDestroyed()) owner.webContents.send("product-metadata-saved", { itemNumber, product: googleFallbackProduct });
          await injectProductBrowserToolbar(browser.webContents, query, "Saved first Costco result · open it to verify", "success", true);
          return;
        }
      } catch {}
      await injectProductBrowserToolbar(browser.webContents, query, googleFallbackProduct ? "First Costco result saved" : "Open a Costco result to save it", googleFallbackProduct ? "success" : "neutral", Boolean(googleFallbackProduct));
      return;
    }
    if (currentUrl === lastCapturedUrl) return;
    lastCapturedUrl = currentUrl;
    await injectProductBrowserToolbar(browser.webContents, query, "Reading product details…");
    try {
      const metadata = await extractProductMetadataFromContents(browser.webContents);
      if (!metadata.title && !metadata.imageUrl) throw new Error("This page did not expose product details.");
      metadata.canonicalUrl ||= currentUrl;
      const product = await saveProductFromBrowser({ ...item, itemNumber, name }, metadata, query, domain);
      if (owner && !owner.isDestroyed()) owner.webContents.send("product-metadata-saved", { itemNumber, product });
      await injectProductBrowserToolbar(browser.webContents, query, `Saved to ${PRODUCT_NAME}`, "success", true);
    } catch (error) {
      lastCapturedUrl = "";
      if (googleFallbackProduct) {
        await injectProductBrowserToolbar(browser.webContents, query, "Listing saved · Costco blocked the extra page details", "success", true);
      } else {
        await injectProductBrowserToolbar(browser.webContents, query, error.message || "Details could not be read", "error");
      }
    }
  });

  let productLoadTimeout;
  try {
    const timeout = new Promise((_, reject) => {
      productLoadTimeout = setTimeout(() => {
        const error = new Error("Product search timed out.");
        error.code = "ERR_TIMED_OUT";
        reject(error);
      }, 20000);
    });
    await Promise.race([browser.loadURL(searchUrl), timeout]);
  } catch (error) {
    if (error?.code !== "ERR_ABORTED") {
      if (!browser.isDestroyed()) browser.destroy();
      throw error;
    }
  } finally {
    clearTimeout(productLoadTimeout);
  }
  if (!browser.isDestroyed()) {
    browser.show();
    browser.focus();
  }
  return { ok: true, query };
});

ipcMain.handle("find-costco-product", async (_event, item = {}) => {
  const domain = normalizeCostcoDomain(item.domain);
  const itemNumber = String(item.itemNumber || "").replace(/\s+/g, " ").trim();
  const name = String(item.name || "").replace(/\s+/g, " ").trim();
  if (!itemNumber && !name) throw new Error("An item number or name is required.");

  const query = `${domain} Item ${itemNumber} ${name}`.replace(/\s+/g, " ").trim();
  const searchUrl = productSearchUrl(query);
  const inspector = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  inspector.webContents.setUserAgent(CHROME_USER_AGENT);

  try {
    await Promise.race([
      inspector.loadURL(searchUrl).catch(error => {
        if (error?.code !== "ERR_ABORTED") throw error;
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Product search timed out.")), 20000))
    ]);
    await new Promise(resolve => setTimeout(resolve, 1400));
    const result = await inspector.webContents.executeJavaScript(googleCostcoResultScript(domain));
    return result ? { ...result, query, domain } : null;
  } finally {
    if (!inspector.isDestroyed()) inspector.destroy();
  }
});

ipcMain.handle("extract-product-metadata", async (_event, productUrl) => {
  if (!isCostcoProductUrl(productUrl)) throw new Error("Only Costco product pages can be inspected.");
  const inspector = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  inspector.webContents.setUserAgent(CHROME_USER_AGENT);
  try {
    await Promise.race([
      inspector.loadURL(productUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Product page timed out.")), 20000))
    ]);
    await new Promise(resolve => setTimeout(resolve, 1800));
    return await extractProductMetadataFromContents(inspector.webContents);
  } finally {
    if (!inspector.isDestroyed()) inspector.destroy();
  }
});

function sendSyncProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("receipt-sync-progress", payload);
}

async function setSyncToolbar(model) {
  costcoSyncToolbar = model;
  if (costcoSyncWindow && !costcoSyncWindow.isDestroyed()) {
    await injectSyncToolbar(costcoSyncWindow.webContents, model);
  }
}

async function localApi(pathname, options = {}) {
  await localServerReady;
  const response = await fetch(`${localURL}${pathname}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Receipt service returned ${response.status}.`);
  return data;
}

function normalizeMarket(value) {
  return String(value || "").toUpperCase() === "US" || String(value || "").toLowerCase() === "costco.com" ? "US" : "CA";
}

function costcoAccountUrl(market) {
  const override = market === "US"
    ? process.env.COSTCO_RECEIPT_ORGANIZER_COSTCO_US_URL
    : process.env.COSTCO_RECEIPT_ORGANIZER_COSTCO_CA_URL;
  return override || (market === "US" ? "https://www.costco.com/accounthome" : "https://www.costco.ca/myaccount/");
}

async function loadCostcoSyncAccountPage() {
  if (!costcoSyncWindow || costcoSyncWindow.isDestroyed()) return { loaded: false };
  const market = costcoSyncMarket;
  let loadTimeout;
  try {
    const timeout = new Promise((_, reject) => {
      loadTimeout = setTimeout(() => {
        const error = new Error("Costco page load timed out.");
        error.code = "ERR_TIMED_OUT";
        reject(error);
      }, 15000);
    });
    await Promise.race([costcoSyncWindow.loadURL(costcoAccountUrl(market)), timeout]);
    return { loaded: true };
  } catch (error) {
    if (error?.code === "ERR_ABORTED") return { loaded: false, aborted: true };
    costcoSyncWindow.webContents.stop();
    const marketLabel = market === "US" ? "United States" : "Canada";
    costcoSyncToolbar = {
      status: `Costco ${marketLabel} did not load. Choose Reload to try again.`,
      statusKind: "error",
      disabled: false,
      market
    };
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:96px 48px;color:#172023;background:#f7f8f5;font:15px -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:620px;margin:auto}h1{font-size:28px;letter-spacing:-.03em}p{color:#667873;line-height:1.55}</style></head><body><main><h1>Costco ${marketLabel} could not load.</h1><p>The Costco page had a temporary network error. Use Reload in the ${PRODUCT_NAME} toolbar to try the account page again. Your local receipt library was not changed.</p></main></body></html>`;
    await costcoSyncWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).catch(() => {});
    return { loaded: false, error: error.message };
  } finally {
    clearTimeout(loadTimeout);
  }
}

function syncAccountLabel(identity = {}) {
  if (identity.email && identity.membershipNumber) return `${identity.email} · Member ${identity.membershipNumber}`;
  if (identity.email) return identity.email;
  if (identity.membershipNumber) return `Member ${identity.membershipNumber}`;
  return "";
}

async function performCostcoSync() {
  if (costcoSyncRunning || !costcoSyncWindow || costcoSyncWindow.isDestroyed()) return;
  costcoSyncRunning = true;
  const market = costcoSyncMarket;
  let renderer;
  let identity = { email: "", membershipNumber: "", market };
  const summary = { total: 0, added: 0, updated: 0, merged: 0, failed: 0, lastError: null, market };
  try {
    const range = syncDateRange();
    await setSyncToolbar({ status: `Reading Costco receipts from ${range.startDate}…`, disabled: true, progress: 2, market });
    sendSyncProgress({ phase: "fetching", current: 0, total: 0, market, message: `Reading your authenticated Costco ${market === "US" ? "United States" : "Canada"} receipt history…` });
    const receipts = await fetchReceiptsFromPage(costcoSyncWindow.webContents, range);
    identity = await readCostcoIdentity(costcoSyncWindow.webContents, receipts, market);
    summary.total = receipts.length;
    sendSyncProgress({ phase: "importing", current: 0, total: receipts.length, market, identity, message: `${receipts.length} Costco receipts found for ${syncAccountLabel(identity) || "this account"}.` });

    for (let index = 0; index < receipts.length; index += 1) {
      const raw = receipts[index];
      const current = index + 1;
      const date = raw.transactionDate || raw.transactionDateTime || `receipt ${current}`;
      try {
        const result = await localApi(`/api/sync/costco-receipt?market=${market}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(raw)
        });
        summary[result.action] = Number(summary[result.action] || 0) + 1;
        if (result.needsPdf) {
          renderer ||= await createPdfRenderer();
          const pdfBuffer = await renderReceiptPdf(renderer, raw);
          await localApi(`/api/sync/costco-receipt/${encodeURIComponent(result.receipt.id)}/pdf`, {
            method: "PUT",
            headers: { "Content-Type": "application/pdf" },
            body: pdfBuffer
          });
        }
      } catch (error) {
        summary.failed += 1;
        summary.lastError = error.message;
      }
      const progress = Math.round(5 + (current / Math.max(1, receipts.length)) * 94);
      const message = `Saving ${current} of ${receipts.length} · ${date}`;
      sendSyncProgress({ phase: "importing", current, total: receipts.length, market, identity, message, summary: { ...summary } });
      await setSyncToolbar({ status: message, disabled: true, progress, market, accountLabel: syncAccountLabel(identity) });
    }

    const completed = await localApi(`/api/sync/complete?market=${market}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...summary, identity })
    });
    const message = summary.failed
      ? `${summary.total - summary.failed} receipts saved; ${summary.failed} need another try`
      : `${summary.total} receipts are now in ${PRODUCT_NAME}`;
    await setSyncToolbar({ status: `${message}. Sync is up to date; choose Done to close.`, statusKind: summary.failed ? "error" : "success", disabled: false, progress: 100, market, accountLabel: syncAccountLabel(identity), complete: true });
    sendSyncProgress({ phase: "complete", current: summary.total, total: summary.total, market, identity, message, summary, sync: completed.sync });
  } catch (error) {
    summary.failed = Math.max(1, summary.failed);
    summary.lastError = error.message;
    try {
      await localApi(`/api/sync/complete?market=${market}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...summary, identity })
      });
    } catch {}
    await setSyncToolbar({ status: error.message || "Costco Sync could not finish", statusKind: "error", disabled: false, market, accountLabel: syncAccountLabel(identity) });
    sendSyncProgress({ phase: "error", current: 0, total: summary.total, market, identity, message: error.message || "Costco Sync could not finish", summary });
  } finally {
    if (renderer && !renderer.isDestroyed()) renderer.destroy();
    costcoSyncRunning = false;
  }
}

ipcMain.handle("open-costco-sync-browser", async (event, options = {}) => {
  await localServerReady;
  const requestedMarket = normalizeMarket(options.market || options.domain);
  if (costcoSyncWindow && !costcoSyncWindow.isDestroyed()) {
    if (requestedMarket !== costcoSyncMarket) {
      if (costcoSyncRunning) throw new Error("Finish the current Costco sync before switching markets.");
      costcoSyncMarket = requestedMarket;
      costcoSyncToolbar = { status: "Sign in, then click Sync all receipts", disabled: false, market: costcoSyncMarket };
      await loadCostcoSyncAccountPage();
      costcoSyncWindow.setTitle(`Costco ${costcoSyncMarket === "US" ? "United States" : "Canada"} Sync — ${PRODUCT_NAME}`);
    }
    costcoSyncWindow.show();
    costcoSyncWindow.focus();
    return { ok: true, reused: true, market: costcoSyncMarket };
  }
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  costcoSyncMarket = requestedMarket;
  costcoSyncToolbar = { status: "Sign in, then click Sync all receipts", disabled: false, market: costcoSyncMarket };
  costcoSyncWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 900,
    minHeight: 650,
    show: false,
    parent: owner && !owner.isDestroyed() ? owner : undefined,
    title: `Costco ${costcoSyncMarket === "US" ? "United States" : "Canada"} Sync — ${PRODUCT_NAME}`,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  costcoSyncWindow.webContents.setUserAgent(CHROME_USER_AGENT);

  const interceptSync = (event, url) => {
    if (url.startsWith("receipt-sync://start")) {
      event?.preventDefault?.();
      performCostcoSync().catch(error => sendSyncProgress({ phase: "error", market: costcoSyncMarket, message: error.message }));
      return true;
    }
    if (url.startsWith("receipt-sync://close")) {
      event?.preventDefault?.();
      if (!costcoSyncRunning && costcoSyncWindow && !costcoSyncWindow.isDestroyed()) costcoSyncWindow.close();
      return true;
    }
    if (url.startsWith("receipt-sync://reload")) {
      event?.preventDefault?.();
      if (!costcoSyncRunning) loadCostcoSyncAccountPage().catch(error => sendSyncProgress({ phase: "error", market: costcoSyncMarket, message: error.message }));
      return true;
    }
    return false;
  };
  costcoSyncWindow.webContents.on("will-navigate", interceptSync);
  costcoSyncWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("receipt-sync://start") || url.startsWith("receipt-sync://close") || url.startsWith("receipt-sync://reload")) {
      interceptSync(null, url);
      return { action: "deny" };
    }
    if (/^https?:\/\//i.test(url)) costcoSyncWindow.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  costcoSyncWindow.webContents.on("did-finish-load", () => {
    if (costcoSyncWindow && !costcoSyncWindow.isDestroyed()) injectSyncToolbar(costcoSyncWindow.webContents, costcoSyncToolbar);
  });
  costcoSyncWindow.on("closed", () => {
    costcoSyncWindow = null;
    if (costcoSyncRunning) sendSyncProgress({ phase: "error", market: costcoSyncMarket, message: "Costco Sync was closed before it finished." });
    else sendSyncProgress({ phase: "browser-closed", market: costcoSyncMarket, message: "Costco window closed." });
  });

  await loadCostcoSyncAccountPage();
  if (costcoSyncWindow && !costcoSyncWindow.isDestroyed()) {
    costcoSyncWindow.show();
    costcoSyncWindow.focus();
  }
  return { ok: true, reused: false, market: costcoSyncMarket };
});

function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${localURL}/api/health`, response => {
      response.resume();
      if (response.statusCode === 200) return resolve();
      retryOrFail(attempt, reject, resolve);
    });
    request.on("error", () => retryOrFail(attempt, reject, resolve));
    request.setTimeout(1000, () => request.destroy());
  });
}

function retryOrFail(attempt, reject, resolve) {
  if (attempt >= 80) return reject(new Error("The local receipt service did not start."));
  setTimeout(() => waitForServer(attempt + 1).then(resolve, reject), 125);
}

async function createWindow() {
  if (!localServerReady) {
    localServerReady = (async () => {
      const sourceDirectory = appSourceDirectory();
      const dataDirectory = process.env.COSTCO_RECEIPTS_DIR || path.join(app.getPath("userData"), "data");

      port = await findAvailablePort();
      localURL = `http://127.0.0.1:${port}`;
      localDataDirectory = dataDirectory;
      seedDataDirectory(sourceDirectory, dataDirectory);
      process.env.PORT = String(port);
      process.env.COSTCO_RECEIPTS_DIR = dataDirectory;
      if (app.isPackaged) process.env.COSTCO_RECEIPT_ORGANIZER_OCR_SOURCE = path.join(process.resourcesPath, "app.asar.unpacked", "ocr.swift");
      require(path.join(sourceDirectory, "server.js"));
      await waitForServer();
    })();
  }
  await localServerReady;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: "#f7f8f5",
    title: PRODUCT_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(localURL)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(localURL);
  mainWindow.show();
  mainWindow.focus();
}

if (hasAppLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return createWindow().catch(console.error);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => createWindow()).catch(error => {
    console.error(error);
    app.quit();
  });

  app.on("activate", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow().catch(console.error);
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
