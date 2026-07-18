const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const pdf = require("pdfdataextract");
const { CostcoReceiptParser } = require("./src/CostcoReceiptParser");
const { CsvWriter } = require("./src/CsvWriter");
const { NumberUtils } = require("./src/NumberUtils");

// Comment out the line below to see debug logs
console.debug = function() {};

const PDFS_DIRECTORY = "./costco-receipt-pdfs";
const OUTPUT_DIRECTORY = "./out";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const numberUtils = new NumberUtils();

main().catch(error => {
  console.error(chalk.red("Script failed."));
  console.error(error);
  process.exitCode = 1;
});

// 1. Delete the `.out` directory and re-create it so that it's empty for each run.
// 2. Get all PDF file names in `./costco-receipt-pdfs`.
// 3. Parse each PDF.
// 4. Write all transactions to `.out/costco-receipts.csv`
// 5. If there's any errors encountered on the receipt (e.g., the total or items sold
//    aren't as expected), a line is printed to the console explaining what the mismatch
//    was and on which receipt.
async function main() {
  createOutputDir();
  const allTransactions = [];

  for (const pdfName of getReceiptPdfFileNames()) {
    const transactions = await parseReceiptPdf(pdfName);
    allTransactions.push(...transactions);
  }

  writeToCsv(allTransactions);
}

function createOutputDir() {
  if (fs.existsSync(OUTPUT_DIRECTORY)) {
    fs.rmSync(OUTPUT_DIRECTORY, { recursive: true });
  }

  fs.mkdirSync(OUTPUT_DIRECTORY);
}

function getReceiptPdfFileNames() {
  return fs.readdirSync(PDFS_DIRECTORY, { withFileTypes: true })
    .filter(file => file.isFile()) // exclude directories
    .filter(file => isPdfReceiptFile(`${ PDFS_DIRECTORY }/${ file.name }`))
    .map(file => `${ PDFS_DIRECTORY }/${ file.name }`);
}

function isPdfReceiptFile(filePath) {
  // Fast path: keep current behavior for normal .pdf files.
  if (path.extname(filePath).toLowerCase() === ".pdf") {
    return true;
  }

  // Some downloaded Costco receipts don't keep the .pdf extension.
  // Read the first 4 bytes and accept the file if it starts with "%PDF".
  const fileDescriptor = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fileDescriptor, header, 0, 4, 0);
    return bytesRead === 4 && header.toString("utf8") === "%PDF";
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

async function parseReceiptPdf(pdfName) {
  let transactions = [];
  const costcoReceiptParser = new CostcoReceiptParser();

  try {
    const data = await pdf.PdfData.extract(fs.readFileSync(pdfName));

    // data.text[] is an array of pages now - need to iterate through them
    for (const page of data.text) {
      for (const line of page.split("\n")) {
        const transaction = parseReceiptLine(line, costcoReceiptParser);
        if (transaction) {
          console.debug("transaction is ", JSON.stringify(transaction), "\n");
          transactions.push(transaction);
        }
      }
    }

    // Add the receipt date to each transaction
    transactions = transactions.map(obj => (
      {
      ...obj,
      date: formatReceiptDate(costcoReceiptParser.getDate()),
      isTaxable: obj.isTaxable ? "Y" : "N",
      cardLastFour: costcoReceiptParser.getCardLastFour()
    }));

    correctnessChecks(pdfName, costcoReceiptParser);

    // TODO: Calculate other stats (I calculated these through Google Sheets)
    // total spent, number of items bought, amount spent on tax, number of different costcos
    // shopped at (see `costcoReceiptParser.getStore())`), etc.
  } catch (error) {
    console.log(chalk.red(`Failed to parse ${ pdfName }.`));
    console.debug(error);
  }

  return transactions;
}

function parseReceiptLine(line, costcoReceiptParser) {
  if (line.length === 0) {
    return;
  }

  return costcoReceiptParser.parseLine(line);
}

function formatReceiptDate(dateString) {
  if (!dateString || typeof dateString !== "string") {
    return dateString;
  }

  const dateMatch = dateString.trim().match(/^([0-9]{1,2})\/([0-9]{1,2})(?:\/([0-9]{2,4}))?$/);
  if (!dateMatch) {
    return dateString;
  }

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const parsedYear = dateMatch[3];
  if (!month || !day || month > 12 || day > 31) {
    return dateString;
  }

  if (!parsedYear) {
    return dateString;
  }

  const year = parsedYear.length === 2 ? `20${ parsedYear }` : parsedYear;
  const monthName = MONTH_NAMES[month - 1];
  if (!monthName) {
    return dateString;
  }

  return `${ String(day).padStart(2, "0") } ${ monthName } ${ year }`;
}

function correctnessChecks(pdfName, costcoReceiptParser) {
  const calculatedTotal = numberUtils.numberToDollar(costcoReceiptParser.getTotalCalculated());
  const receiptTotal = numberUtils.numberToDollar(costcoReceiptParser.getTotal());
  const spentCheckPasses = calculatedTotal === receiptTotal;

  const numItemsSoldCalculated = costcoReceiptParser.getNumItemsSoldCalculated();
  const numItemsSoldReceipt = costcoReceiptParser.getNumItemsSoldReceipt();
  const itemsSoldCheckPasses = numItemsSoldCalculated === numItemsSoldReceipt;

  if (!spentCheckPasses || !itemsSoldCheckPasses) {
    console.log(chalk.red(`Check failed for ${ pdfName }.`));
  }

  if (!spentCheckPasses) {
    console.log(chalk.yellow(` Calculated spend (${ calculatedTotal }) doesn't equal total on receipt (${ receiptTotal }).`));
  }

  if (!itemsSoldCheckPasses) {
    console.log(chalk.yellow(` Calculated items sold (${ numItemsSoldCalculated }) does not equal items sold on receipt (${ numItemsSoldReceipt }).`));
  }

  if (!spentCheckPasses || !itemsSoldCheckPasses) {
    console.log(` Double check the receipt to see if the numbers add up. Costco sometimes doesn't include discounts for items on the receipt.\n There could also be an error in the script. If so, feel free to reach out to me.\n`);
  }
}

function writeToCsv(transactions) {
  const headers = [
    { id: "date", title: "Date" },
    { id: "itemIdentifier", title: "Item identifier" },
    { id: "itemName", title: "Item name" },
    { id: "amount", title: "Amount" },
    { id: "isTaxable", title: "Taxable" },
    { id: "cardLastFour", title: "Card used" },
  ];

  new CsvWriter({ outputDir: OUTPUT_DIRECTORY, headers: headers, append: false })
    .write("costco-receipts.csv", transactions);
}
