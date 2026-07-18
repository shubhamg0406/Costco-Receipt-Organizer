# Security policy

## Supported version

Security fixes are applied to the latest published release of Costco Receipt Organizer.

## Report a vulnerability

Please do not open a public issue for a vulnerability involving receipt data, Costco account sessions, local file access, or remote content loaded in Electron. Use the repository's **Security → Report a vulnerability** flow to create a private GitHub security advisory.

Include the affected version, macOS version, reproduction steps, expected and observed behavior, and whether sensitive data may have been exposed. Do not attach real receipts, membership numbers, authentication tokens, cookies, or passwords. A minimal synthetic fixture is preferred.

## Security boundaries

- The local HTTP service listens only on `127.0.0.1` and chooses an available port.
- Receipt documents and indexes remain outside the app bundle in the user's application-data directory.
- Remote Costco and Google pages run in isolated Electron windows with Node integration disabled and sandboxing enabled.
- The current public DMG is ad-hoc signed but is not signed or notarized with an Apple Developer identity. Verify that downloads come from this repository's release page.

Costco page changes and third-party content can still create risk. Keep macOS current, review product suggestions before trusting them, and avoid opening receipt exports on shared devices.
