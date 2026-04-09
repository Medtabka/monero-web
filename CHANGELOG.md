# Changelog

All notable changes to monero-web are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-09

First public release after the move from Netlify to Cloudflare Pages.

### Added — crypto engine
- BIP-39 12-word seed support (PBKDF2-SHA512 → SLIP-0010 ed25519 → `m/44'/128'/0'`)
  with optional BIP-39 passphrase.
- 13-word MyMonero legacy seed format (12 data + 1 checksum, Keccak-hashed).
- 16-word Polyseed support — full GF(2¹¹) checksum decoder, PBKDF2-SHA256
  key derivation, prefix-matching wordlist lookup, and birthday extraction.
- 25-word standard Monero seed in **13 languages**: English, Spanish, French,
  German, Italian, Portuguese, Russian, Japanese, Chinese (simplified),
  Dutch, Esperanto, Lojban, English (old).
- Subaddress derivation (account, index) with `8…` mainnet netbyte.
- Network selector — mainnet (`4…`), stagenet (`5…`), testnet (`9…` / `A…`).
- Watch-only import — paste an address + private view key with no spend key
  to land on a read-only dashboard view.
- Recovered 25-word mnemonic shown when importing via private spend key.
- Pure-JavaScript ed25519 point unpacking, addition, and arbitrary-base
  scalar multiplication used for subaddress generation.

### Added — wallet UI / session security
- Encrypted session storage (`WalletVault`) — AES-GCM encrypted in
  `sessionStorage` with a key derived from a user-supplied password
  (PBKDF2-SHA256, 250 000 iterations).
- Idle auto-lock after 10 minutes of inactivity. With a session password,
  re-unlock without re-deriving from the seed.
- Custom node URL — bypass the proxy entirely and connect to your own
  `monerod` over HTTPS + CORS.
- Wallet JSON export — portable backup file containing all keys.
- Subaddress generator on the dashboard.
- Click-to-copy wallet address with toast confirmation.
- "Continue session" banner on `/verify` when an existing wallet is loaded.
- Logo links back to home from any page.
- Clean URLs at `/`, `/verify`, `/dashboard`, `/privacy` (legacy `.html`
  paths 301-redirect to the canonical form).

### Added — landing page / brand
- Full landing page at `/` with hero, feature grid, FAQ, and donate section.
- Donate section with click-to-copy XMR address, `monero:` URI link, and
  a self-hosted static QR code.
- Privacy page at `/privacy` documenting exactly what the wallet collects
  (nothing) and what flows over the network.

### Added — infrastructure
- Cloudflare Pages deployment with `functions/api/proxy.js` serverless
  function (replaces the old Netlify function).
- DNSSEC active end-to-end (Cloudflare-managed DNS, DS record at Porkbun).
- Self-hosted fonts under `/fonts/` (no Google Fonts requests).
- Self-hosted QR encoder under `js/qrcodegen.js` (no third-party QR API
  requests; the receive modal renders QR codes locally).
- GitHub Actions CI workflow that runs the 28-test crypto suite + inline
  script syntax check + no-external-assets lint on every push and PR.
- `tools/update-donation-address.sh` — single command to rotate the
  donation address across README, index, and the QR SVG without drift.

### Added — docs
- README threat model — explicit list of what monero-web protects against
  and what it does not.
- `SECURITY.md` with disclosure policy + GitHub PVR + email channel.
- SPDX license headers on every JS file.

### Migrated
- Hosting moved from Netlify to Cloudflare Pages after Netlify's free tier
  suspended the project for "credit" usage.
- Domain `monero-web.com` migrated from Porkbun-managed DNS to
  Cloudflare-managed DNS while keeping the registration at Porkbun.

### Fixed
- All non-English wordlists were silently broken in production because
  `js/monero-wordlists-all.js` was three concatenated copies of the same
  data with the first copy truncated mid-array. Replaced with one clean
  copy. All 13 languages now round-trip correctly in tests.
- `appendChecksum()` now lowercases word prefixes to match
  `verifyChecksum()`, fixing the German wordlist (and any other
  capitalised list).
- `lookup()` now uses a full-word map first and falls back to prefix
  matching, so the legacy English wordlist (which has 4-character prefix
  collisions) works correctly.

### Security
- All crypto operations run in-browser with zero external script
  dependencies. CI fails any change that adds an external `<script src>`,
  external stylesheet, or external font.
- 28 cryptographic test vectors covering BIP-39, Polyseed canonical and
  prefix-form, polyseed bad-checksum rejection, subaddress derivation
  (deterministic, distinct from primary, (0,0) rejected), all 13 wordlist
  round-trips, network byte selection, and the WalletVault encrypt /
  decrypt / wrong-password paths.

[Unreleased]: https://github.com/Medtabka/monero-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Medtabka/monero-web/releases/tag/v0.1.0
