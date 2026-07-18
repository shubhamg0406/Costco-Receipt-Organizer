const crypto = require("crypto");

const DIGITAL_SCHEMA_VERSION = "1.0.7";

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function numberValue(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const source = String(value).trim();
  const negative = /-$/.test(source) || /^\(.*\)$/.test(source);
  const parsed = Number(source.replace(/[^0-9.-]/g, "").replace(/-$/, ""));
  if (!Number.isFinite(parsed)) return fallback;
  return negative ? -Math.abs(parsed) : parsed;
}

function truthyFlag(value) {
  return value === true || /^(?:1|y|yes|true|r|refund|void)$/i.test(String(value || "").trim());
}

function normalizeDate(value) {
  if (!value) return null;
  const source = String(value).trim();
  const iso = source.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const northAmerican = source.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (northAmerican) {
    const year = northAmerican[3].length === 2 ? `20${northAmerican[3]}` : northAmerican[3];
    return `${year}-${northAmerican[1].padStart(2, "0")}-${northAmerican[2].padStart(2, "0")}`;
  }
  const parsed = new Date(source);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString().slice(0, 10);
}

function cleanText(...values) {
  return values.map(value => String(value || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
}

function stableHash(value, length = 24) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function digitalReceiptKey(raw = {}) {
  const identity = [
    raw.membershipNumber,
    raw.transactionBarcode,
    raw.invoiceNumber,
    raw.sequenceNumber,
    raw.transactionDateTime || raw.transactionDate,
    raw.warehouseNumber,
    raw.registerNumber,
    raw.transactionNumber,
    raw.total
  ].map(value => String(value ?? "").trim()).join("|");
  return `costco:${stableHash(identity)}`;
}

function digitalReceiptId(raw = {}) {
  return `costco-${digitalReceiptKey(raw).slice("costco:".length)}`;
}

function isReceiptRefund(raw = {}) {
  const description = cleanText(raw.documentType, raw.receiptType, raw.transactionType).toLowerCase();
  if (/refund|return|credit/.test(description)) return true;
  const total = numberValue(raw.total, NaN);
  if (Number.isFinite(total) && total < 0) return true;
  const items = Array.isArray(raw.itemArray) ? raw.itemArray : [];
  return items.length > 0 && items.every(item => truthyFlag(item.refundFlag) || numberValue(item.amount) < 0);
}

function signedAmount(value, refund, fallback = 0) {
  const amount = numberValue(value, fallback);
  if (!amount) return 0;
  return refund ? -Math.abs(amount) : amount;
}

function inferQuantity(raw, amount, unitAmount) {
  const explicit = numberValue(raw.unit, NaN);
  if (Number.isFinite(explicit) && Math.abs(explicit) > 0 && Math.abs(explicit) <= 10000) return Math.abs(explicit);
  const isFuel = Boolean(raw.fuelUomCode || raw.fuelUomDescription || raw.fuelGradeCode || raw.fuelGradeDescription);
  const fuel = isFuel ? numberValue(raw.fuelUnitQuantity, NaN) : NaN;
  if (Number.isFinite(fuel) && fuel > 0) return fuel;
  if (unitAmount) {
    const ratio = Math.abs(amount / unitAmount);
    const rounded = Math.round(ratio);
    if (rounded >= 1 && Math.abs(ratio - rounded) < 0.015) return rounded;
  }
  return 1;
}

function isTaxable(raw) {
  const flag = String(raw.taxFlag ?? "").trim().toUpperCase();
  if (!flag || /^(?:0|N|NO|NONE|EXEMPT|FALSE)$/.test(flag)) return false;
  return true;
}

function couponTarget(coupon, items, itemBuckets, couponIndex) {
  const identifiers = [coupon.associatedItemNumber, coupon.upcnumberCoupon]
    .map(value => String(value || "").replace(/^0+/, "").trim())
    .filter(Boolean);
  for (const identifier of identifiers) {
    const bucket = itemBuckets.get(identifier);
    if (bucket?.length) return bucket[bucket.length - 1];
  }
  return items[couponIndex] || [...items].reverse().find(item => item.eventType !== "adjustment") || null;
}

function allocateTax(items, receiptTax) {
  const taxable = items.filter(item => item.eventType !== "adjustment" && item.taxable && item.amount !== 0);
  const candidates = taxable.length ? taxable : items.filter(item => item.amount !== 0);
  const base = candidates.reduce((sum, item) => sum + Math.abs(numberValue(item.amount)), 0);
  let allocated = 0;
  const last = items.reduce((position, item, index) => candidates.includes(item) ? index : position, -1);
  items.forEach((item, index) => {
    const share = candidates.includes(item) && base ? Math.abs(numberValue(item.amount)) / base : 0;
    item.allocatedTax = index === last ? roundMoney(receiptTax - allocated) : roundMoney(receiptTax * share);
    allocated = roundMoney(allocated + item.allocatedTax);
    item.total = roundMoney(item.amount + item.allocatedTax);
    item.taxLabel = "Allocated from receipt tax";
  });
}

function finalizeItem(item) {
  const adjustments = Array.isArray(item.adjustments) ? item.adjustments : [];
  item.adjustments = adjustments;
  item.discount = roundMoney(adjustments.filter(adjustment => adjustment.type === "discount").reduce((sum, adjustment) => sum + numberValue(adjustment.amount), 0));
  item.fees = roundMoney(adjustments.filter(adjustment => ["fee", "surcharge"].includes(adjustment.type)).reduce((sum, adjustment) => sum + numberValue(adjustment.amount), 0));
  item.otherAdjustments = roundMoney(adjustments.filter(adjustment => !["discount", "fee", "surcharge"].includes(adjustment.type)).reduce((sum, adjustment) => sum + numberValue(adjustment.amount), 0));
  item.adjustmentTotal = roundMoney(adjustments.reduce((sum, adjustment) => sum + numberValue(adjustment.amount), 0));
  item.amount = roundMoney(numberValue(item.grossAmount) + item.adjustmentTotal);
  return item;
}

function convertDigitalReceipt(raw = {}) {
  const sourceKey = digitalReceiptKey(raw);
  const id = digitalReceiptId(raw);
  const receiptRefund = isReceiptRefund(raw);
  const items = [];
  const itemBuckets = new Map();
  const rawItems = Array.isArray(raw.itemArray) ? raw.itemArray : [];

  rawItems.forEach((rawItem, rawIndex) => {
    if (truthyFlag(rawItem.voidFlag)) return;
    const itemRefund = receiptRefund || truthyFlag(rawItem.refundFlag) || numberValue(rawItem.amount) < 0;
    const unitPriceRaw = numberValue(rawItem.itemUnitPriceAmount, NaN);
    let grossAmount = signedAmount(rawItem.amount, itemRefund, Number.isFinite(unitPriceRaw) ? unitPriceRaw : 0);
    const quantity = inferQuantity(rawItem, grossAmount, unitPriceRaw);
    if (!grossAmount && Number.isFinite(unitPriceRaw)) grossAmount = signedAmount(unitPriceRaw * quantity, itemRefund);
    const itemNumber = String(rawItem.itemNumber || rawItem.itemIdentifier || rawItem.itemUPCNumber || "").replace(/^0+/, "").trim();
    const name = cleanText(rawItem.itemDescription01, rawItem.itemDescription02)
      || cleanText(rawItem.frenchItemDescription1, rawItem.frenchItemDescription2)
      || `Costco item ${itemNumber || rawIndex + 1}`;
    const item = finalizeItem({
      id: `${id}-${items.length}`,
      itemNumber,
      upc: String(rawItem.itemUPCNumber || "").trim(),
      name,
      quantity,
      unitAmount: roundMoney(grossAmount / (quantity || 1)),
      grossAmount: roundMoney(grossAmount),
      amount: roundMoney(grossAmount),
      discount: 0,
      fees: 0,
      adjustmentTotal: 0,
      adjustments: [],
      taxable: isTaxable(rawItem),
      eventType: itemRefund ? "refund" : "purchase",
      status: itemRefund ? "returned" : "active",
      sourceLine: "Costco digital receipt",
      sourceIndex: rawIndex
    });
    items.push(item);
    for (const identifier of [item.itemNumber, item.upc].filter(Boolean)) {
      const normalized = identifier.replace(/^0+/, "");
      const bucket = itemBuckets.get(normalized) || [];
      bucket.push(item);
      itemBuckets.set(normalized, bucket);
    }
  });

  const coupons = Array.isArray(raw.couponArray) ? raw.couponArray : [];
  coupons.forEach((coupon, couponIndex) => {
    if (truthyFlag(coupon.voidflagCoupon)) return;
    const target = couponTarget(coupon, items, itemBuckets, couponIndex);
    const refundCoupon = receiptRefund || truthyFlag(coupon.refundflagCoupon) || target?.eventType === "refund";
    const rawAmount = numberValue(coupon.amountCoupon, numberValue(coupon.unitCoupon, 0));
    if (!rawAmount) return;
    const amount = refundCoupon ? Math.abs(rawAmount) : -Math.abs(rawAmount);
    const adjustment = {
      amount: roundMoney(amount),
      type: refundCoupon ? "refund-adjustment" : "discount",
      label: refundCoupon ? "Returned instant savings" : "Instant savings",
      couponNumber: String(coupon.couponNumber || "").trim(),
      associatedItemNumber: String(coupon.associatedItemNumber || "").trim(),
      source: "Costco digital receipt"
    };
    if (target) {
      target.adjustments.push(adjustment);
      finalizeItem(target);
      return;
    }
    items.push(finalizeItem({
      id: `${id}-${items.length}`,
      itemNumber: String(coupon.associatedItemNumber || coupon.upcnumberCoupon || coupon.couponNumber || "").replace(/^0+/, "").trim(),
      name: refundCoupon ? "Returned instant savings" : "Instant savings",
      quantity: 1,
      unitAmount: 0,
      grossAmount: 0,
      amount: amount,
      adjustments: [adjustment],
      taxable: false,
      eventType: "adjustment",
      status: "adjustment",
      sourceLine: "Costco digital receipt coupon"
    }));
  });

  const subtotalRaw = numberValue(raw.subTotal, NaN);
  const taxRaw = numberValue(raw.taxes, NaN);
  const totalRaw = numberValue(raw.total, NaN);
  const total = Number.isFinite(totalRaw) ? signedAmount(totalRaw, receiptRefund) : roundMoney(items.reduce((sum, item) => sum + item.amount, 0) + (Number.isFinite(taxRaw) ? signedAmount(taxRaw, receiptRefund) : 0));
  const tax = Number.isFinite(taxRaw) ? signedAmount(taxRaw, receiptRefund) : 0;
  const subtotal = Number.isFinite(subtotalRaw) ? signedAmount(subtotalRaw, receiptRefund) : roundMoney(total - tax);
  const itemSubtotal = roundMoney(items.reduce((sum, item) => sum + item.amount, 0));
  const reconciliation = roundMoney(subtotal - itemSubtotal);
  if (Math.abs(reconciliation) >= 0.02) {
    items.push(finalizeItem({
      id: `${id}-${items.length}`,
      itemNumber: "",
      name: "Receipt-level adjustment",
      quantity: 1,
      unitAmount: reconciliation,
      grossAmount: reconciliation,
      amount: reconciliation,
      adjustments: [],
      taxable: false,
      eventType: "adjustment",
      status: "adjustment",
      sourceLine: "Costco digital receipt reconciliation"
    }));
  }

  allocateTax(items, tax);
  const warehouseNumber = String(raw.warehouseNumber || "").trim();
  const warehouseName = cleanText(raw.warehouseShortName, raw.warehouseName) || "Costco warehouse";
  const store = warehouseNumber && !warehouseName.includes(`#${warehouseNumber}`)
    ? `${warehouseName} #${warehouseNumber}`
    : warehouseName;
  const date = normalizeDate(raw.transactionDate || raw.transactionDateTime);
  const transactionNumber = String(raw.transactionNumber || raw.invoiceNumber || raw.transactionBarcode || "—").trim();
  const rawCountry = String(raw.warehouseCountry || "CA").trim().toUpperCase();
  const country = ["US", "USA", "UNITED STATES"].includes(rawCountry) ? "US" : "CA";
  const currency = String(raw.currencyCode || (country === "US" ? "USD" : "CAD")).toUpperCase();

  return {
    id,
    fileName: `Costco ${date || "receipt"} ${transactionNumber}.pdf`.replace(/[/:]/g, "-"),
    hash: null,
    date,
    store,
    city: String(raw.warehouseCity || "").trim(),
    state: String(raw.warehouseState || "").trim(),
    country,
    warehouseNumber,
    membershipNumber: String(raw.membershipNumber || "").trim(),
    transactionNumber,
    transactionBarcode: String(raw.transactionBarcode || "").trim(),
    invoiceNumber: String(raw.invoiceNumber || "").trim(),
    subtotal: roundMoney(subtotal),
    tax: roundMoney(tax),
    total: roundMoney(total),
    currency,
    items,
    itemCount: Math.abs(numberValue(raw.totalItemCount, items.filter(item => item.eventType !== "adjustment").reduce((sum, item) => sum + Number(item.quantity || 1), 0))),
    receiptType: receiptRefund ? "refund" : "purchase",
    status: "indexed",
    confidence: Math.abs(roundMoney(items.reduce((sum, item) => sum + item.total, 0) - total)) <= 0.02 ? "high" : "review",
    extractionMethod: "Costco digital receipt",
    importedAt: new Date().toISOString(),
    source: {
      type: "costco-digital",
      key: sourceKey,
      schemaVersion: DIGITAL_SCHEMA_VERSION,
      syncedAt: new Date().toISOString(),
      generatedPdf: true
    }
  };
}

function matchesExistingReceipt(receipt, candidate) {
  if (!receipt || !candidate) return false;
  if (receipt.source?.key && receipt.source.key === candidate.source?.key) return true;
  if (receipt.transactionBarcode && candidate.transactionBarcode && receipt.transactionBarcode === candidate.transactionBarcode) return true;
  if (receipt.date !== candidate.date) return false;
  if (Math.abs(numberValue(receipt.total) - numberValue(candidate.total)) > 0.02) return false;
  const existingTransaction = String(receipt.transactionNumber || "").replace(/\D/g, "");
  const candidateTransaction = String(candidate.transactionNumber || "").replace(/\D/g, "");
  if (existingTransaction && candidateTransaction && existingTransaction === candidateTransaction) return true;
  const existingWarehouse = String(receipt.warehouseNumber || receipt.store || "").replace(/\D/g, "");
  const candidateWarehouse = String(candidate.warehouseNumber || candidate.store || "").replace(/\D/g, "");
  return Boolean(existingWarehouse && candidateWarehouse && existingWarehouse.endsWith(candidateWarehouse));
}

function rebaseItemIds(receipt, id) {
  receipt.items = (receipt.items || []).map((item, index) => ({ ...item, id: `${id}-${index}` }));
  return receipt;
}

module.exports = {
  DIGITAL_SCHEMA_VERSION,
  convertDigitalReceipt,
  digitalReceiptId,
  digitalReceiptKey,
  inferQuantity,
  matchesExistingReceipt,
  normalizeDate,
  numberValue,
  rebaseItemIds,
  roundMoney
};
