const { BrowserWindow } = require("electron");
const { convertDigitalReceipt } = require("../src/DigitalReceiptImporter");
const PRODUCT_NAME = "Costco Receipt Organizer";

const LIST_RECEIPTS_QUERY = `
  query receipts($startDate: String!, $endDate: String!) {
    receipts(startDate: $startDate, endDate: $endDate) {
      documentType
      receiptType
      membershipNumber
      transactionType
      transactionDateTime
      transactionDate
      warehouseShortName
      warehouseNumber
      warehouseName
      warehouseAddress1
      warehouseAddress2
      warehouseCity
      warehouseState
      warehouseCountry
      warehousePostalCode
      warehouseAreaCode
      warehousePhone
      companyNumber
      invoiceNumber
      sequenceNumber
      transactionBarcode
      totalItemCount
      instantSavings
      subTotal
      taxes
      total
      currencyCode
      registerNumber
      transactionNumber
      operatorNumber
      itemArray {
        itemNumber
        itemUPCNumber
        itemDescription01
        itemDescription02
        frenchItemDescription1
        frenchItemDescription2
        itemIdentifier
        itemDepartmentNumber
        transDepartmentNumber
        itemUnitPriceAmount
        unit
        amount
        taxFlag
        refundFlag
        resaleFlag
        voidFlag
        merchantID
        entryMethod
        fuelUnitQuantity
        fuelUomCode
        fuelUomDescription
        fuelUomDescriptionFr
        fuelGradeCode
        fuelGradeDescription
        fuelGradeDescriptionFr
      }
      couponArray {
        couponNumber
        upcnumberCoupon
        associatedItemNumber
        unitCoupon
        amountCoupon
        taxflagCoupon
        voidflagCoupon
        refundflagCoupon
      }
      subTaxes {
        tax1
        tax2
        tax3
        tax4
        aTaxPercent
        aTaxLegend
        aTaxAmount
        aTaxPrintCode
        aTaxPrintCodeFR
        aTaxIdentifierCode
        bTaxPercent
        bTaxLegend
        bTaxAmount
        bTaxPrintCode
        bTaxPrintCodeFR
        bTaxIdentifierCode
        cTaxPercent
        cTaxLegend
        cTaxAmount
        cTaxIdentifierCode
        dTaxPercent
        dTaxLegend
        dTaxAmount
        dTaxPrintCode
        dTaxPrintCodeFR
        dTaxIdentifierCode
        uTaxLegend
        uTaxAmount
        uTaxableAmount
      }
      tenderArray {
        tenderTypeCode
        tenderSubTypeCode
        tenderTypeName
        tenderTypeNameFr
        tenderDescription
        amountTender
        displayAccountNumber
        sequenceNumber
        approvalNumber
        responseCode
        transactionID
        merchantID
        entryMethod
        storedValueBucket
        tenderAcctTxnNumber
        tenderAuthorizationCode
        tenderEntryMethodDescription
        walletType
        walletId
      }
    }
  }
`.replace(/\s+/g, " ").trim();

function syncDateRange(today = new Date()) {
  const end = new Date(today);
  const start = new Date(today);
  start.setFullYear(start.getFullYear() - 3);
  start.setMonth(start.getMonth() - 1);
  start.setDate(1);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

async function fetchReceiptsFromPage(contents, range = syncDateRange()) {
  const model = { query: LIST_RECEIPTS_QUERY, ...range };
  return contents.executeJavaScript(`(async () => {
    const model = ${JSON.stringify(model)};
    const clientID = localStorage.getItem('clientID');
    const idToken = localStorage.getItem('idToken');
    if (!clientID || !idToken) {
      throw new Error('Please sign in to Costco, then return to Account and click Sync all receipts again.');
    }
    const response = await fetch('https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Costco.Env': 'ecom',
        'Costco.Service': 'restOrders',
        'Costco-X-Wcs-Clientid': clientID,
        'Client-Identifier': '481b1aec-aa3b-454b-b81b-48187e28f205',
        'Costco-X-Authorization': 'Bearer ' + idToken
      },
      body: JSON.stringify({ query: model.query, variables: { startDate: model.startDate, endDate: model.endDate } })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result?.context?.statusMessage?.description?.value || result?.message || response.statusText;
      throw new Error('Costco receipt request failed (' + response.status + '): ' + String(detail || 'Unknown error'));
    }
    if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
    if (!Array.isArray(result?.data?.receipts)) throw new Error('Costco did not return a receipt list. Open Orders & Purchases and try again.');
    return result.data.receipts;
  })()`);
}

function identityFromClaims(claims = {}, receipts = [], market = "CA") {
  const values = Object.entries(claims || {});
  const email = String(
    claims.email
    || claims.preferred_username
    || claims.upn
    || values.find(([key, value]) => /email|user.?name/i.test(key) && /@/.test(String(value)))?.[1]
    || ""
  ).trim();
  const membershipNumber = String(
    receipts.find(receipt => receipt?.membershipNumber)?.membershipNumber
    || claims.membershipNumber
    || claims.memberNumber
    || values.find(([key, value]) => /membership|member.?number/i.test(key) && /\d{4,}/.test(String(value)))?.[1]
    || ""
  ).trim();
  return { email, membershipNumber, market: String(market).toUpperCase() === "US" ? "US" : "CA" };
}

async function readCostcoIdentity(contents, receipts = [], market = "CA") {
  let claims = {};
  try {
    claims = await contents.executeJavaScript(`(() => {
      const found = {};
      const inspect = value => {
        if (!value || typeof value !== 'object') return;
        for (const [key, nested] of Object.entries(value)) {
          if (typeof nested === 'string') {
            if (!found.email && /email|user.?name/i.test(key) && nested.includes('@')) found.email = nested;
            if (!found.membershipNumber && /membership|member.?number/i.test(key) && /\\d{4,}/.test(nested)) found.membershipNumber = nested;
          }
        }
      };
      try {
        const token = localStorage.getItem('idToken') || '';
        const segment = token.split('.')[1] || '';
        if (segment) {
          const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
          const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
          inspect(JSON.parse(decodeURIComponent(escape(atob(padded)))));
        }
      } catch {}
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) || '';
        if (!/profile|account|member|user|email/i.test(key) || /token/i.test(key)) continue;
        const value = localStorage.getItem(key) || '';
        try { inspect(JSON.parse(value)); } catch {
          if (!found.email && value.includes('@')) found.email = value;
          if (!found.membershipNumber && /member/i.test(key) && /\\d{4,}/.test(value)) found.membershipNumber = value;
        }
      }
      if (!found.email) found.email = document.querySelector('input[type="email"]')?.value || '';
      return found;
    })()`);
  } catch {}
  return identityFromClaims(claims, receipts, market);
}

async function injectSyncToolbar(contents, model = {}) {
  const toolbar = {
    status: model.status || "Sign in, then sync your Costco history",
    statusKind: model.statusKind || "neutral",
    disabled: Boolean(model.disabled),
    progress: Number.isFinite(model.progress) ? model.progress : null,
    market: String(model.market || "CA").toUpperCase() === "US" ? "US" : "CA",
    accountLabel: String(model.accountLabel || ""),
    complete: Boolean(model.complete)
  };
  try {
    await contents.executeJavaScript(`(() => {
      const model = ${JSON.stringify(toolbar)};
      let bar = document.getElementById('receipt-costco-sync-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'receipt-costco-sync-bar';
        document.documentElement.appendChild(bar);
      }
      bar.replaceChildren();
      bar.style.cssText = 'position:fixed;z-index:2147483647;left:0;right:0;top:0;height:52px;display:flex;align-items:center;gap:10px;padding:0 16px;background:#fff;border-bottom:1px solid #dfe5e2;color:#172023;font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 10px rgba(23,32,35,.08)';
      const smallButton = (label, action) => {
        const button = document.createElement('button');
        button.textContent = label;
        button.style.cssText = 'border:1px solid #dfe5e2;background:#fff;color:#35423e;border-radius:6px;padding:6px 9px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer';
        button.addEventListener('click', action);
        return button;
      };
      bar.append(smallButton('Back', () => history.back()), smallButton('Reload', () => { location.href = 'receipt-sync://reload'; }));
      const brand = document.createElement('strong');
      brand.textContent = ${JSON.stringify(PRODUCT_NAME)};
      brand.style.cssText = 'color:#17654f;margin-left:4px';
      bar.append(brand);
      const market = document.createElement('span');
      market.textContent = model.market === 'US' ? 'Costco United States' : 'Costco Canada';
      market.style.cssText = 'color:#35423e;font-weight:600;padding-right:2px';
      bar.append(market);
      const status = document.createElement('span');
      status.textContent = model.status + (model.accountLabel ? ' · ' + model.accountLabel : '');
      status.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (model.statusKind === 'success' ? '#17654f' : model.statusKind === 'error' ? '#a4473e' : '#667873');
      bar.append(status);
      if (model.progress !== null) {
        const progress = document.createElement('progress');
        progress.max = 100;
        progress.value = model.progress;
        progress.style.cssText = 'width:110px;height:6px;margin-left:auto;accent-color:#17654f';
        bar.append(progress);
      }
      const sync = document.createElement('button');
      sync.textContent = model.disabled ? 'Syncing…' : 'Sync all receipts';
      sync.disabled = model.disabled;
      sync.style.cssText = 'margin-left:' + (model.progress === null ? 'auto' : '0') + ';border:0;background:#17654f;color:#fff;border-radius:7px;padding:8px 13px;font:700 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:' + (model.disabled ? 'default' : 'pointer') + ';opacity:' + (model.disabled ? '.65' : '1');
      sync.addEventListener('click', () => { location.href = 'receipt-sync://start'; });
      bar.append(sync);
      const close = smallButton(model.complete ? 'Done' : 'Close', () => { location.href = 'receipt-sync://close'; });
      close.disabled = model.disabled;
      close.style.opacity = model.disabled ? '.45' : '1';
      close.style.cursor = model.disabled ? 'default' : 'pointer';
      bar.append(close);
      if (document.body) document.body.style.paddingTop = '52px';
    })()`);
  } catch {}
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function money(value, currency = "CAD") {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: currency === "USD" ? "USD" : "CAD" }).format(Number(value || 0));
}

function digitalReceiptHtml(raw = {}) {
  const receipt = convertDigitalReceipt(raw);
  const items = receipt.items.filter(item => item.eventType !== "adjustment");
  const coupons = (raw.couponArray || []).filter(coupon => !/^(?:1|y|yes|true)$/i.test(String(coupon.voidflagCoupon || "")));
  const currency = receipt.currency;
  const warehouse = receipt.store;
  const address = [raw.warehouseAddress1, raw.warehouseAddress2, [raw.warehouseCity, raw.warehouseState, raw.warehousePostalCode].filter(Boolean).join(" ")].filter(Boolean);
  const itemRows = items.map(item => {
    const refund = item.eventType === "refund";
    return `<tr><td><strong>${escapeHtml(item.name || "Costco item")}</strong><small>Item ${escapeHtml(item.itemNumber || "—")}${refund ? " · Return" : ""}</small></td><td class="number">${escapeHtml(item.quantity || "1")}</td><td class="number">${money(item.grossAmount, currency)}</td></tr>`;
  }).join("");
  const couponPrefix = receipt.receiptType === "refund" ? "+" : "−";
  const couponRows = coupons.map(coupon => `<tr class="coupon"><td><strong>${receipt.receiptType === "refund" ? "Returned instant savings" : "Instant savings"}</strong><small>Applied to item ${escapeHtml(coupon.associatedItemNumber || coupon.upcnumberCoupon || "—")}</small></td><td class="number"></td><td class="number">${couponPrefix}${money(Math.abs(Number(coupon.amountCoupon || coupon.unitCoupon || 0)), currency)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:Letter;margin:42px}*{box-sizing:border-box}body{margin:0;color:#172023;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #17654f;padding-bottom:18px;margin-bottom:20px}.brand{font-size:26px;font-weight:800;letter-spacing:-.04em}.archive{color:#17654f;font-size:10px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;margin-bottom:6px}.meta{text-align:right;color:#5f706b;line-height:1.55}.warehouse{font-size:17px;font-weight:750;margin-bottom:4px}.address{color:#5f706b;line-height:1.45}.receipt-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0}.field{border-top:1px solid #dfe5e2;padding-top:9px}.field label{display:block;color:#71817c;font-size:9px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}.field strong{font-size:12px}table{width:100%;border-collapse:collapse;margin-top:12px}th{color:#71817c;font-size:9px;letter-spacing:.08em;text-transform:uppercase;text-align:left;border-bottom:1px solid #cfd8d4;padding:9px 0}th.number,td.number{text-align:right}td{padding:10px 0;border-bottom:1px solid #e5eae7;vertical-align:top}td strong,td small{display:block}td small{color:#71817c;font-size:9px;margin-top:3px}.coupon td{color:#17654f}.totals{width:280px;margin:22px 0 0 auto}.total-line{display:flex;justify-content:space-between;padding:5px 0}.total-line.final{font-size:17px;font-weight:800;border-top:1px solid #172023;margin-top:5px;padding-top:10px}footer{margin-top:34px;border-top:1px solid #dfe5e2;padding-top:12px;color:#71817c;font-size:9px;line-height:1.5}
  </style></head><body><header><div><div class="archive">${PRODUCT_NAME} archive</div><div class="brand">Costco receipt</div></div><div class="meta">${escapeHtml(raw.transactionDateTime || raw.transactionDate || "")}</div></header><div class="warehouse">${escapeHtml(warehouse)}</div><div class="address">${address.map(escapeHtml).join("<br>")}</div><section class="receipt-meta"><div class="field"><label>Transaction</label><strong>${escapeHtml(receipt.transactionNumber || "—")}</strong></div><div class="field"><label>Register</label><strong>${escapeHtml(raw.registerNumber || "—")}</strong></div><div class="field"><label>Receipt barcode</label><strong>${escapeHtml(raw.transactionBarcode || "—")}</strong></div></section><table><thead><tr><th>Item</th><th class="number">Qty</th><th class="number">Amount</th></tr></thead><tbody>${itemRows}${couponRows}</tbody></table><div class="totals"><div class="total-line"><span>Subtotal</span><strong>${money(receipt.subtotal, currency)}</strong></div><div class="total-line"><span>Tax</span><strong>${money(receipt.tax, currency)}</strong></div><div class="total-line final"><span>Total</span><span>${money(receipt.total, currency)}</span></div></div><footer>This PDF is a local archive copy generated by ${PRODUCT_NAME} from the digital transaction data available in your authenticated Costco account. Your Costco login credentials are never stored by ${PRODUCT_NAME}.</footer></body></html>`;
}

async function createPdfRenderer() {
  return new BrowserWindow({
    width: 900,
    height: 1200,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
}

async function renderReceiptPdf(renderer, raw) {
  const html = digitalReceiptHtml(raw);
  await renderer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return renderer.webContents.printToPDF({
    printBackground: true,
    pageSize: "Letter",
    margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 }
  });
}

module.exports = {
  LIST_RECEIPTS_QUERY,
  createPdfRenderer,
  digitalReceiptHtml,
  fetchReceiptsFromPage,
  identityFromClaims,
  injectSyncToolbar,
  readCostcoIdentity,
  renderReceiptPdf,
  syncDateRange
};
