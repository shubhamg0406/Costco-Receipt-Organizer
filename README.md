# Costco Receipt Organizer

Costco Receipt Organizer is a local-first macOS app for keeping Costco purchase history searchable. Import receipt PDFs or sync digital receipts, find an item by name or item number, and open the exact receipt when you need it for a return or price adjustment.

The app runs in its own desktop window. Receipt PDFs, parsed items, product metadata, and Costco sync history stay on the Mac by default—there is no hosted account or cloud database.

## What it does

- Keeps original imported PDFs and generated digital-receipt archive PDFs together in one local library.
- Makes the Item Library the home screen, searchable by item number, product name, warehouse, or receipt detail.
- Shows purchase, discount, adjustment, and refund events separately so repeated purchases and later returns remain understandable.
- Tracks quantity, gross price, line discount, allocated tax, and final paid or refunded amount for every item event.
- Allocates receipt-level tax across eligible item lines while reconciling back to the printed receipt total.
- Provides sortable, Excel-style filters for both the Item Library and Receipt Library; newest receipts load first.
- Opens the relevant PDF or its containing Finder folder directly from an item or receipt.
- Syncs digital warehouse receipts from authenticated Costco Canada and Costco United States account pages.
- Suggests product names, images, and Costco links using a native mini browser while preserving the original receipt name.
- Checks recent purchases against current public sale listings and prepares likely price-match receipts.
- Bundles selected receipts into a ZIP, copies them to a folder, or opens the native macOS Share menu.

## Install on macOS

Download the Apple Silicon DMG from [Releases](../../releases), open it, and drag **Costco Receipt Organizer** to Applications.

The downloadable build has an ad-hoc integrity signature, but it is not signed or notarized with an Apple Developer certificate. On first launch, macOS may require you to right-click the app, choose **Open**, and confirm. Only install builds from this repository's release page.

Data is stored separately from the app bundle at:

```text
~/Library/Application Support/Costco Receipt Organizer/data
```

Upgrading or reinstalling the app does not delete that directory. Version 1.3 automatically copies an existing library and Costco browser session from the former `~/Library/Application Support/Receipt` location. The legacy folder is retained as a rollback copy.

## Use the app

### Import PDF receipts

Open **Receipts**, select **Import PDF**, and choose one or more Costco PDFs. Text-based receipts and scanned PDFs are supported; scanned files use macOS Vision OCR when no usable text layer is available. Imported originals are copied into the local library before indexing.

### Sync Costco digital receipts

1. Choose Canada or United States in the global Market control.
2. Open **Receipts → Open Costco & Sync**.
3. Sign in inside the native Costco window.
4. Select **Sync all receipts**.
5. Select **Done** when the toolbar confirms the library is current.

The Costco session stays in the app's local macOS application-data folder. The app reads digital warehouse receipts available to the signed-in account, stores raw transaction records locally, and creates archive PDFs. It does not put a Costco password or copied authentication token into the receipt index.

When a manually imported transaction already exists, sync enriches that record while preserving the original PDF. Canada and U.S. histories, currencies, deal sources, and sync status remain distinct.

### Find product details

Open an item and select **Find Product Details**. A native mini browser searches Google for the item and saves the first country-appropriate Costco result as a suggestion. Opening the result lets the app read any product metadata exposed by Costco, including the full name, image, brand, and canonical URL.

Costco frequently removes warehouse-only or discontinued product pages. A Google result can also be wrong, so suggested metadata appears beside—not instead of—the immutable receipt name.

### Understand discounts, refunds, and tax

Every receipt line remains an event. A later refund is negative and stays attached to its own refund receipt. Matching item number and amount can link it to a prior purchase without collapsing repeated purchases into one row. Discounts remain dedicated line values, including multiple coupons and multi-quantity purchases.

Costco often prints only one tax total. The app allocates that printed amount across eligible final item prices, uses item tax markers when available, and assigns any cent-level rounding remainder to the last eligible line. Item totals therefore reconcile to the receipt total; the allocation is an organizational estimate, not tax advice.

## Build from source

Requirements:

- macOS on Apple Silicon
- Node.js 22.12 or newer
- npm
- Xcode Command Line Tools for the macOS Vision OCR helper

```bash
npm ci
npm run electron
```

To build the standalone app and DMG:

```bash
scripts/build-dmg.sh
```

The script writes `Costco Receipt Organizer.app` and `Costco Receipt Organizer.dmg` at the repository root. Generated builds and all local receipt directories are ignored by Git.

Run the automated checks with:

```bash
npm test
```

The native and UI smoke tests are available as `npm run test:native` and `npm run test:ui`. They launch Electron and may use live public Costco or Google pages.

## Local architecture

| Area | Implementation |
| --- | --- |
| Desktop shell | Electron |
| Interface | HTML, CSS, and browser JavaScript |
| Local API | Node.js HTTP server bound to `127.0.0.1` on an available private port |
| Receipt index | Local JSON document plus original PDF files |
| PDF parsing | `pdfdataextract`, with macOS Vision OCR fallback |
| Costco sync | User-initiated requests inside the authenticated native Costco window |
| Product enrichment | Native Google/Costco mini browser with locally cached suggestions |
| Price checks | Public Costco, CocoWest, and CocoEast sale pages |

Set `COSTCO_RECEIPTS_DIR` to use a different receipt-data directory. For desktop-shell testing, `COSTCO_RECEIPT_ORGANIZER_USER_DATA_DIR` overrides the complete Electron application-data directory. The former `RECEIPT_USER_DATA_DIR` name remains supported only for backward compatibility.

## Privacy and limitations

Read [PRIVACY.md](PRIVACY.md) before syncing an account. There is no telemetry or hosted backend, but sync, product enrichment, and price checks intentionally contact third-party sites. Costco can change its pages or receipt API at any time, which may temporarily break those features.

This project is not affiliated with, endorsed by, or sponsored by Costco Wholesale Corporation. Costco and related marks belong to their respective owners. Price adjustments and return eligibility must be confirmed by Costco.

## Project provenance and licensing

This work began from [GonzaloZiadi/CostcoWrapped](https://github.com/GonzaloZiadi/CostcoWrapped), whose original command-line receipt parser is retained in the repository history and credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). That upstream repository did not contain a license when this version was published. Accordingly, this repository does not claim to relicense the upstream code and is marked `UNLICENSED`; public visibility does not by itself grant reuse rights.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for additional sources and notices, [SECURITY.md](SECURITY.md) for vulnerability reporting, and [CHANGELOG.md](CHANGELOG.md) for release history.
