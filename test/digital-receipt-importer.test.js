const assert = require("assert");
const { convertDigitalReceipt, matchesExistingReceipt } = require("../src/DigitalReceiptImporter");

const raw = {
  membershipNumber: "1234",
  transactionBarcode: "991234",
  transactionDate: "2026-07-10",
  warehouseShortName: "RICHMOND",
  warehouseNumber: "501",
  warehouseCity: "Richmond",
  warehouseState: "BC",
  warehouseCountry: "CA",
  transactionNumber: "77",
  totalItemCount: 3,
  subTotal: 37.97,
  taxes: 1.82,
  total: 39.79,
  itemArray: [
    { itemNumber: "1969525", itemDescription01: "K.SPADE PJ", itemUnitPriceAmount: 23.99, amount: 47.98, taxFlag: "B" },
    { itemNumber: "67237", itemDescription01: "CANTALOUPE", itemUnitPriceAmount: 6.99, amount: 6.99, taxFlag: "N" }
  ],
  couponArray: [
    { associatedItemNumber: "1969525", amountCoupon: 5 },
    { associatedItemNumber: "1969525", amountCoupon: 5 },
    { associatedItemNumber: "67237", amountCoupon: 2 }
  ]
};

const receipt = convertDigitalReceipt(raw);
assert.equal(receipt.receiptType, "purchase");
assert.equal(receipt.items[0].quantity, 2);
assert.equal(receipt.items[0].grossAmount, 47.98);
assert.equal(receipt.items[0].discount, -10);
assert.equal(receipt.items[0].amount, 37.98);
assert.equal(receipt.items[1].discount, -2);
assert.equal(receipt.items.reduce((sum, item) => Math.round((sum + item.total) * 100) / 100, 0), receipt.total);
assert(matchesExistingReceipt({ date: receipt.date, total: receipt.total, transactionNumber: "77" }, receipt));

const refund = convertDigitalReceipt({
  ...raw,
  transactionBarcode: "991235",
  transactionType: "RETURN",
  subTotal: 37.98,
  taxes: 1.82,
  total: 39.8,
  totalItemCount: -2,
  itemArray: [{
    itemNumber: "1969525",
    itemDescription01: "K.SPADE PJ",
    itemUnitPriceAmount: 23.99,
    amount: 47.98,
    unit: -2,
    fuelUnitQuantity: 10,
    refundFlag: "Y",
    taxFlag: "B"
  }],
  couponArray: [{ associatedItemNumber: "1969525", amountCoupon: 10, refundflagCoupon: "Y" }]
});
assert.equal(refund.receiptType, "refund");
assert.equal(refund.items[0].quantity, 2);
assert.equal(refund.itemCount, 2);
assert.equal(refund.items[0].grossAmount, -47.98);
assert.equal(refund.items[0].amount, -37.98);
assert.equal(refund.total, -39.8);

console.log("digital receipt importer tests passed");
