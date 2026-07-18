const fs = require("fs");
const path = require("path");

const IGNORED_MIGRATION_ENTRIES = new Set([
  "Cache",
  "Code Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "DevToolsActivePort",
  "GPUCache",
  "blob_storage",
  "server.log",
  "server.pid"
]);

function hasReceiptLibrary(userDataDirectory) {
  return fs.existsSync(path.join(userDataDirectory, "data", "index.json"))
    || fs.existsSync(path.join(userDataDirectory, "index.json"));
}

function migrateLegacyUserData(legacyDirectory, targetDirectory, logger = console) {
  if (!fs.existsSync(legacyDirectory) || hasReceiptLibrary(targetDirectory)) return hasReceiptLibrary(targetDirectory);

  fs.mkdirSync(targetDirectory, { recursive: true });
  for (const entry of fs.readdirSync(legacyDirectory)) {
    if (IGNORED_MIGRATION_ENTRIES.has(entry) || entry.startsWith("Singleton")) continue;
    const source = path.join(legacyDirectory, entry);
    const destination = path.join(targetDirectory, entry);
    if (fs.existsSync(destination)) continue;
    try {
      fs.cpSync(source, destination, { recursive: true });
    } catch (error) {
      logger.warn?.(`Could not migrate ${entry}: ${error.message}`);
    }
  }
  return hasReceiptLibrary(targetDirectory);
}

module.exports = { hasReceiptLibrary, migrateLegacyUserData };
