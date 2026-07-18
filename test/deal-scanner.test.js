const assert = require("assert");
const { buildPriceMatches, discoverDealPages, parseDealPage, parseUsWarehouseSavings } = require("../src/DealScanner");

const homepage = '<a href="/2026/07/costco-flyer-costco-sale-items-for-july-13-19-2026-for-bc-ab-sk-mb/">Deals</a>';
assert.deepEqual(discoverDealPages(homepage, "https://cocowest.ca/"), ["https://cocowest.ca/2026/07/costco-flyer-costco-sale-items-for-july-13-19-2026-for-bc-ab-sk-mb/"]);

const html = '<img data-src="https://example.com/tide.jpeg" alt="2507482 TIDE ULTRA ADVANCED POWER 89 WASHLOADS ($5.50 INSTANT SAVINGS EXPIRES ON 2026-07-19) $21.49">';
const [deal] = parseDealPage(html, "https://cocowest.ca/deal", { name: "CocoWest", regions: ["BC"] });
assert.equal(deal.itemNumber, "2507482");
assert.equal(deal.salePrice, 21.49);
assert.equal(deal.savings, 5.5);

const result = buildPriceMatches([{
  id: "receipt-1",
  date: "2026-07-10",
  store: "Richmond",
  items: [{ id: "item-1", itemNumber: "2507482", name: "TIDE ULTRA", eventType: "purchase", amount: 26.99, quantity: 1, discount: 0 }]
}], [deal], { today: "2026-07-16", days: 30 });
assert.equal(result.matches.length, 1);
assert.equal(result.matches[0].potentialSavings, 5.5);

const partial = buildPriceMatches([{
  id: "receipt-2",
  date: "2026-07-10",
  store: "Richmond",
  items: [{ id: "item-2", itemNumber: "2507482", name: "TIDE ULTRA", eventType: "purchase", amount: 53.98, quantity: 2, remainingQuantity: 1, discount: -11 }]
}], [deal], { today: "2026-07-16", days: 30 });
assert.equal(partial.matches.length, 1);
assert.equal(partial.matches[0].quantity, 1);
assert.equal(partial.matches[0].potentialSavings, 5.5);
assert.equal(partial.appliedSavings, 5.5);

const usHtml = `
  <div>Pricing shown is warehouse pricing | Valid 6/15/26 - 7/19/26</div>
  <div data-testid="Grid">
    <img alt="CALPAK Evry Multi-Piece Luggage Bundle" src="https://example.com/calpak.avif" />
    <div>Item 1970196</div>
    <p data-testid="Text_prices_and_percentages_prices"><span>$</span><span>149</span><span>.</span><span>99</span></p>
    <div data-testid="Text_prices_and_percentages_append_text">After $30 OFF</div>
    <a href="https://www.costco.com/p/-/calpak-evry-8-piece-luggage-bundle/4000294990">Buy Online</a>
  </div>`;
const [usDeal] = parseUsWarehouseSavings(usHtml);
assert.equal(usDeal.itemNumber, "1970196");
assert.equal(usDeal.salePrice, 149.99);
assert.equal(usDeal.savings, 30);
assert.equal(usDeal.expiresOn, "2026-07-19");
assert.equal(usDeal.market, "US");

const separated = buildPriceMatches([{
  id: "receipt-us",
  date: "2026-07-10",
  country: "US",
  state: "WA",
  items: [{ id: "item-us", itemNumber: "1970196", name: "CALPAK LUGGAGE", eventType: "purchase", amount: 179.99, quantity: 1 }]
}], [deal, usDeal], { today: "2026-07-16", days: 30, market: "US" });
assert.equal(separated.matches.length, 1);
assert.equal(separated.matches[0].deal.market, "US");

const wrongCanadianRegion = buildPriceMatches([{
  id: "receipt-east",
  date: "2026-07-10",
  country: "CA",
  state: "ON",
  items: [{ id: "item-east", itemNumber: "2507482", name: "TIDE ULTRA", eventType: "purchase", amount: 26.99, quantity: 1 }]
}], [deal], { today: "2026-07-16", days: 30, market: "CA" });
assert.equal(wrongCanadianRegion.matches.length, 0);

console.log("deal scanner tests passed");
