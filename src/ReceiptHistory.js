function normalizeHistoryName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function receiptTimestamp(receipt) {
  const parsed = receipt.date ? Date.parse(`${receipt.date}T12:00:00`) : NaN;
  return Number.isNaN(parsed) ? Date.parse(receipt.importedAt || "") || 0 : parsed;
}

function reconcileHistory(receipts) {
  const buckets = new Map();
  (receipts || []).forEach(receipt => (receipt.items || []).forEach(item => {
    if (!["purchase", "refund"].includes(item.eventType)) return;
    const key = item.itemNumber ? `number:${item.itemNumber}` : `name:${normalizeHistoryName(item.name)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ receipt, item, timestamp: receiptTimestamp(receipt) });
    delete item.returnedPurchaseId;
    delete item.returnedPurchaseIds;
    delete item.refundEventId;
    delete item.refundEventIds;
    delete item.matchConfidence;
    delete item.returnedQuantity;
    delete item.remainingQuantity;
    delete item.matchedQuantity;
  }));

  for (const events of buckets.values()) {
    events.sort((a, b) => a.timestamp - b.timestamp);
    const openPurchases = [];
    for (const event of events) {
      if (event.item.eventType === "purchase") {
        event.remaining = Math.max(0, Number(event.item.quantity || 1));
        event.item.status = "active";
        event.item.remainingQuantity = event.remaining;
        event.item.returnedQuantity = 0;
        event.item.refundEventIds = [];
        openPurchases.push(event);
        continue;
      }
      let remainingRefund = Math.max(0, Number(event.item.quantity || 1));
      const refundPerUnit = Math.abs(Number(event.item.amount || 0)) / Math.max(1, Number(event.item.quantity || 1));
      event.item.returnedPurchaseIds = [];
      event.item.matchedQuantity = 0;
      while (remainingRefund > 0.0001) {
        const eligible = openPurchases.filter(candidate => candidate.remaining > 0.0001 && candidate.timestamp <= event.timestamp);
        if (!eligible.length) break;
        const exact = [...eligible].reverse().find(candidate => {
          const purchasePerUnit = Math.abs(Number(candidate.item.amount || 0)) / Math.max(1, Number(candidate.item.quantity || 1));
          return Math.abs(purchasePerUnit - refundPerUnit) <= 0.02;
        });
        const match = exact || eligible[eligible.length - 1];
        const allocatedQuantity = Math.min(remainingRefund, match.remaining);
        match.remaining = Math.max(0, match.remaining - allocatedQuantity);
        remainingRefund = Math.max(0, remainingRefund - allocatedQuantity);
        match.item.returnedQuantity = Number(match.item.returnedQuantity || 0) + allocatedQuantity;
        match.item.remainingQuantity = match.remaining;
        match.item.refundEventIds.push(event.item.id);
        match.item.refundEventId = event.item.id;
        match.item.status = match.remaining > 0.0001 ? "partially-returned" : "returned";
        event.item.returnedPurchaseIds.push(match.item.id);
        event.item.returnedPurchaseId ||= match.item.id;
        event.item.matchedQuantity += allocatedQuantity;
        event.item.matchConfidence = exact ? "price matched" : "timeline matched";
      }
    }
  }
  return receipts;
}

module.exports = { normalizeHistoryName, receiptTimestamp, reconcileHistory };
