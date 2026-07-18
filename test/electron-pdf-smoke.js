const { app } = require("electron");
const { createPdfRenderer, renderReceiptPdf } = require("../electron/costco-sync");

app.whenReady().then(async () => {
  const renderer = await createPdfRenderer();
  try {
    const buffer = await renderReceiptPdf(renderer, {
      membershipNumber: "test",
      transactionBarcode: "pdf-smoke-test",
      transactionDate: "2026-07-15",
      transactionNumber: "123",
      warehouseShortName: "RICHMOND",
      warehouseNumber: "501",
      warehouseCountry: "CA",
      totalItemCount: 2,
      subTotal: 37.98,
      taxes: 1.82,
      total: 39.8,
      itemArray: [{ itemNumber: "1969525", itemDescription01: "K.SPADE PJ", itemUnitPriceAmount: 23.99, amount: 47.98, taxFlag: "B" }],
      couponArray: [{ associatedItemNumber: "1969525", amountCoupon: 5 }, { associatedItemNumber: "1969525", amountCoupon: 5 }]
    });
    if (buffer.slice(0, 4).toString("ascii") !== "%PDF" || buffer.length < 1000) throw new Error("A valid PDF was not generated.");
    console.log(`electron PDF smoke test passed (${buffer.length} bytes)`);
  } finally {
    renderer.destroy();
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});
