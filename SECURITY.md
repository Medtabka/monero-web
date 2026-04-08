# Security Policy

## Reporting a vulnerability

If you think you've found a security issue in monero-web, **please do not open
a public GitHub issue**. Instead, report it privately so we can fix it before
it's disclosed.

**Preferred channels** (in order):

1. GitHub's private vulnerability reporting:
   <https://github.com/YOUR_USERNAME/monero-web/security/advisories/new>
2. Email: `security@monero-web.com` (PGP key fingerprint published on the site)

Please include:

- A clear description of the issue
- The exact files / functions / lines involved
- Steps to reproduce (a minimal proof of concept is ideal)
- The impact you believe it has
- Any suggested fix, if you have one

We aim to:

- Acknowledge your report within **72 hours**
- Triage and respond with an initial assessment within **7 days**
- Ship a fix or mitigation for confirmed issues within **30 days** for
  high-severity findings, sooner if actively exploited

We do not currently run a paid bug-bounty program, but we will publicly credit
anyone who reports a real issue (unless you'd prefer to stay anonymous).

## Scope

In scope:

- The static site at `monero-web.com` and everything in this repository
- The `js/` crypto engine: `keccak256.js`, `monero-ed25519.js`,
  `monero-keys.js`, `monero-wordlist.js`, `bip39.js`, `polyseed.js`,
  `monero-subaddress.js`, `wallet-vault.js`
- The Netlify proxy in `netlify/functions/`
- CSP, SRI, and any other deployment-side hardening

Out of scope (please don't report these as vulnerabilities):

- The browser itself, or browser-extension-based attacks (the threat model
  in [README.md](./README.md) explicitly does not cover these)
- Compromised operating systems / keystroke loggers
- DNS hijacking outside our control
- Public Monero remote nodes — they are third-party infrastructure
- Anything that requires the user to paste their seed into an obvious phishing
  clone of the site

## Things we are particularly interested in

- Any way for derived keys to leak out of the browser tab
- Any way for an attacker to substitute a different address into the receive
  flow without the user noticing
- Cryptographic bugs in the key derivation, polyseed decoder, BIP-39
  PBKDF2/SLIP-0010 path, subaddress derivation, or AES-GCM vault
- CSP bypasses, prototype-pollution sinks, clipboard-hijacking sinks
- Any deviation from the on-paper threat model

## Disclosure

Once a fix is shipped we'll publish a short advisory on the GitHub repo and
update the changelog with the CVE (if assigned) and credit.

Thank you for keeping monero-web safe.
