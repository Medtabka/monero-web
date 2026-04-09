# Architecture decision: light-wallet server + transaction core

**Status:** accepted, 2026-04-09
**Author:** monero-web maintainers
**Supersedes:** none (first ADR for the post-VPS architecture)

## Context

Browser-based Monero wallets cannot run a full Monero node in the user's tab —
the blockchain is hundreds of GB and `monero_wallet2` is ~150 000 lines of C++
that doesn't compile cleanly to WebAssembly. Every browser-based wallet that
has ever shipped (MyMonero, Edge, etc.) has therefore split the work between:

1. A **light-wallet server** that holds a copy of the blockchain and scans
   incoming blocks for outputs that match a registered view key.
2. A **client-side transaction core** that builds and signs transactions
   locally in the browser, so the spend key never leaves the user's tab.

We need to choose an implementation for both halves.

## Options considered

### Light-wallet server

| Option | Language | Status | Pros | Cons |
|---|---|---|---|---|
| **monero-lws** | C++ | Actively maintained by **vtnerd** (Monero core dev) | Correct (shares primitives with the official wallet), efficient, supports view tags / RingCT / subaddresses, LMDB-backed (no extra DB process) | Compile-from-source on the VPS (~30 min on a CAX21), boost dependency, less battle-tested at scale than the heavyweight desktop wallets |
| **mymonero-app-server** | Go | Dormant since MyMonero shut down January 2026 | Smaller binary, simpler deploy | MongoDB dependency, output decryption logic may not be fully up-to-date with newer Monero protocol changes, you'd be the de-facto maintainer of a fork |
| **Roll our own (Node.js)** | JavaScript | Doesn't exist | Same ethos as the rest of monero-web (hand-written, no deps, auditable). Reuses existing JS crypto code. SQLite-only deployment. | Multi-week project with cryptographic landmines (CLSAG, view tags, RingCT amount commitments, subaddress hashtables, six protocol eras to handle). Until written, no balance display at all. |

### Client-side transaction core

| Option | Language | Status | Pros | Cons |
|---|---|---|---|---|
| **mymonero-core-js** | C++ → WebAssembly + JS wrapper | MIT, stable, shipped in production at MyMonero for years | Already exists. Handles all Monero protocol versions correctly. ~1-2 MB WASM blob. Battle-tested. Client-side signing — spend key never leaves the browser. | Heavyweight compiled C++ blob, not auditable line-by-line the way our hand-written JS engine is. Last upstream activity uncertain after MyMonero shutdown. |
| **monero-serai → WASM** | Rust → WebAssembly | Theoretically possible | Cleaner Rust codebase. Better long-term ecosystem fit. | Multi-week build pipeline work to compile to `wasm32-unknown-unknown`. No turnkey JS bindings. |
| **Roll our own** | JavaScript | Doesn't exist | Maximum auditability. | Multi-month project. Real risk of subtle cryptographic bugs that silently leak privacy or break tx validity. |

## Decision

**For the light-wallet server: use `monero-lws`.**

**For the client-side transaction core: use `mymonero-core-js`.**

Both are heavyweight compiled artifacts written by experienced Monero
contributors. Both are MIT licensed and open source. Both have been used in
production. They are the only realistic paths to a working browser-based
wallet on a tight timeline.

## Rationale

1. **Time to user-visible features.** The combination of monero-lws +
   mymonero-core-js gets us from "wallet that derives keys" to "wallet that
   shows balances and can send" in roughly 2-3 days of focused work. Rolling
   either piece by hand is a multi-week-to-multi-month project, and during
   that time monero-web has no balance display and no send button.

2. **Cryptographic correctness.** Output decryption and transaction
   construction are the kinds of cryptographic code where a subtle bug can
   silently leak privacy or just produce wrong balances without any error.
   monero-lws and mymonero-core-js are both written by people who have spent
   years working on Monero specifically. Our hand-written JS engine handles
   key derivation and address encoding correctly because there are unambiguous
   test vectors; output decryption against a live chain has many more edge
   cases (six protocol eras, view tags, subaddresses, integrated addresses,
   payment IDs) and we'd be inventing those test vectors ourselves.

3. **Realistic ecosystem.** The monero-web project sits in a small niche —
   browser-based non-custodial Monero wallets — and the architectural choices
   that exist in this niche are exactly the two libraries we picked. Cake,
   Feather, and the Monero GUI / CLI are heavyweight desktop wallets that
   embed the full `monero_wallet2`; we cannot replicate that in a browser, so
   we cannot reuse their architecture.

4. **The threat model holds.** The spend key still never leaves the browser
   tab. monero-lws sees the *view key* (so it can scan incoming outputs) and
   the *signed transaction hex* (so it can broadcast). Neither of those
   compromises spending authority. mymonero-core-js runs entirely inside the
   user's tab and has no network access of its own.

5. **Self-hosted operation.** Both libraries run on infrastructure we
   control (`monero-lws` on our Hetzner VPS alongside `monerod`, and
   `mymonero-core-js` runs in the user's own browser served by our
   Cloudflare-hosted static site). There is no third-party SaaS dependency.

## Acknowledged trade-offs

- **`monero-lws` and `mymonero-core-js` are not hand-written
  auditable JavaScript** the way the rest of `js/` is. This bumps against
  monero-web's stated ethos of "every line you can read." We accept this
  trade-off because the alternative is no balance display and no send
  button at all.

- **Long-term plan:** the right *eventual* answer is a hand-written
  Node.js light-wallet server and a hand-written JS transaction core,
  cross-checked against `monero-lws` and `mymonero-core-js` as
  reference implementations. This is post-launch work. The README will
  document the current state honestly: "this version uses two trusted
  third-party libraries; here is the long-term plan to replace them
  with hand-written equivalents."

- **`mymonero-core-js` is the only viable WASM tx-construction option
  today.** If MyMonero's upstream codebase decays beyond use, we will
  re-evaluate (probably toward `monero-serai` → WASM, which is the
  current best Rust alternative).

## Implementation plan (in order)

1. **Compile and install `monero-lws`** on the existing CAX21 VPS,
   alongside the already-running `monerod`. Build script:
   `setup-monero-lws.sh` (lives next to `setup-monerod.sh`).
2. **Expose `monero-lws` over Cloudflare** at
   `https://node.monero-web.com/lws/...` via the existing nginx reverse
   proxy. Same TLS termination, same DDoS protection, same firewall.
3. **Write `js/lws-client.js`** — a small wrapper module the dashboard
   uses to talk to the LWS endpoints. Documented in
   `docs/lws-api.md`.
4. **Wire the dashboard's balance + history panels** to call
   `lws-client.js`. Until then they show `—`.
5. **Vendor `mymonero-core-js`** under `js/mymonero-core/`. **Done**
   2026-04-09. The 5 source files are checked into the repo at
   `js/mymonero-core/` along with the BSD-3-Clause `LICENSE.txt` and
   a README explaining provenance, status, and the recommended
   browser-compat path for whoever wires it up next. The files
   ship to users via Cloudflare Pages but are not yet called from
   the dashboard — that happens in step 6.
6. **Write `js/send.js`** — the wrapper the Send button calls. Builds
   the tx via mymonero-core-js, signs it, broadcasts via the existing
   `/api/proxy` Cloudflare Function.
7. **Replace the dashboard's "send coming soon" placeholder** with the
   real send screen built earlier (#7 fee selector, payment ID handling,
   confirmation step).

After step 4 lands, the wallet shows real balances. After step 7 lands,
the wallet sends transactions. Both within ~1 week of focused work.

## Open questions for later

- **Where do we host the validation cross-check?** When the long-term
  hand-written equivalents land, we want to run both implementations in
  parallel and alert on any divergence. This probably lives as a Node
  script on the VPS that periodically scans a known wallet through both
  paths and emails on mismatch.

- **Should we publish a `lws-server-protocol.md`?** The MyMonero protocol
  is documented in scattered places. A clean spec we maintain would help
  anyone else trying to build a browser-based Monero wallet on the same
  shape.

- **Do we offer an "untrusted mode"?** A future opt-in where the entire
  scan happens client-side via WebAssembly with no LWS — slower, fully
  trustless. Probably worth doing once the WASM scanner exists for
  cross-validation purposes anyway.
