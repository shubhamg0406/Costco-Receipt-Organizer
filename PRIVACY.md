# Privacy

Costco Receipt Organizer is designed as a local-first desktop app. It has no hosted user account, analytics service, telemetry collector, advertising SDK, or cloud database.

## Data stored on the Mac

The standalone app stores its working data under:

```text
~/Library/Application Support/Costco Receipt Organizer
```

The `data` subdirectory contains the searchable JSON index, imported or generated receipt PDFs, raw synced receipt records, cached product suggestions, deal-scan results, and account identity labels displayed in the interface. Electron also stores the native Costco browser's cookies and site storage in the application-data directory so the user can remain signed in.

The app never intentionally writes a Costco password into its receipt index. Authentication tokens remain in Electron's local browser storage and are used only inside the authenticated Costco window.

## Network requests

The app contacts external services only for features that require them:

- Costco Canada or Costco United States when the user opens the sync window, syncs receipts, or opens a product page.
- Google Search when product enrichment is requested or automatically attempted.
- Costco, CocoWest, or CocoEast public pages when checking current sale prices.

The internal application server binds only to `127.0.0.1` on an available local port. It is not exposed as a public web service.

External sites receive normal web-request information such as the IP address, user agent, requested page, and any cookies belonging to that site. Their own privacy policies apply.

## Backups and deletion

Receipt PDFs can contain purchase history, membership identifiers, partial payment information, warehouse locations, and transaction numbers. Treat library backups and exported ZIP files as sensitive.

Deleting the app from Applications does not delete its data. To erase the library and stored Costco browser session, quit the app and remove `~/Library/Application Support/Costco Receipt Organizer`. Version 1.3 leaves the former `~/Library/Application Support/Receipt` folder in place after migration so it can serve as a rollback copy; remove that folder separately only after confirming the new library works.

## Public repository safety

Local receipt directories, PDFs, databases, environment files, logs, app bundles, and DMGs are excluded by `.gitignore`. Release packages are built without seed receipt data. Before publishing a fork or release, inspect the staged Git files and packaged application resources again.
