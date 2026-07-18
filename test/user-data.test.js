const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { hasReceiptLibrary, migrateLegacyUserData } = require("../electron/user-data");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "costco-receipt-organizer-migration-"));
const legacy = path.join(root, "Receipt");
const target = path.join(root, "Costco Receipt Organizer");

try {
  fs.mkdirSync(path.join(legacy, "data", "receipts"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "Cache"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "data", "index.json"), JSON.stringify({ schemaVersion: 14, receipts: [] }));
  fs.writeFileSync(path.join(legacy, "data", "receipts", "example.pdf"), "%PDF synthetic fixture");
  fs.writeFileSync(path.join(legacy, "Cookies"), "synthetic session fixture");
  fs.writeFileSync(path.join(legacy, "Cache", "ignored"), "cache");

  assert.equal(hasReceiptLibrary(legacy), true);
  assert.equal(migrateLegacyUserData(legacy, target), true);
  assert.equal(fs.existsSync(path.join(target, "data", "index.json")), true);
  assert.equal(fs.existsSync(path.join(target, "data", "receipts", "example.pdf")), true);
  assert.equal(fs.existsSync(path.join(target, "Cookies")), true);
  assert.equal(fs.existsSync(path.join(target, "Cache")), false);
  assert.equal(fs.existsSync(path.join(legacy, "data", "index.json")), true);

  fs.writeFileSync(path.join(target, "data", "index.json"), JSON.stringify({ sentinel: "keep-existing" }));
  assert.equal(migrateLegacyUserData(legacy, target), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "data", "index.json"), "utf8")).sentinel, "keep-existing");

  console.log("User-data migration tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
