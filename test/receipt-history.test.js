const assert = require("assert");
const { reconcileHistory } = require("../src/ReceiptHistory");

const discounted = { id: "discounted", itemNumber: "100", name: "TEST ITEM", eventType: "purchase", quantity: 1, amount: 20 };
const fullPrice = { id: "full-price", itemNumber: "100", name: "TEST ITEM", eventType: "purchase", quantity: 1, amount: 30 };
const refund = { id: "refund", itemNumber: "100", name: "TEST ITEM", eventType: "refund", quantity: 1, amount: -30 };
const receipts = [
  { id: "r1", date: "2026-06-01", items: [discounted] },
  { id: "r2", date: "2026-06-08", items: [fullPrice] },
  { id: "r3", date: "2026-06-15", items: [refund] }
];
reconcileHistory(receipts);
assert.equal(discounted.remainingQuantity, 1, "the discounted purchase must remain active");
assert.equal(fullPrice.remainingQuantity, 0, "the refund must match the same per-unit price");
assert.equal(refund.returnedPurchaseId, "full-price");
assert.equal(refund.matchConfidence, "price matched");

const twoPack = { id: "two-pack", itemNumber: "200", name: "TWO PACK", eventType: "purchase", quantity: 2, amount: 40 };
const oneReturned = { id: "one-returned", itemNumber: "200", name: "TWO PACK", eventType: "refund", quantity: 1, amount: -20 };
reconcileHistory([
  { id: "r4", date: "2026-07-01", items: [twoPack] },
  { id: "r5", date: "2026-07-08", items: [oneReturned] }
]);
assert.equal(twoPack.returnedQuantity, 1);
assert.equal(twoPack.remainingQuantity, 1);
assert.equal(twoPack.status, "partially-returned");

console.log("receipt history tests passed");
