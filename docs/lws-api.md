# Light-wallet server API contract

This is the HTTP API the dashboard uses to talk to `monero-lws` (running
on our VPS, fronted by nginx, served at `https://node.monero-web.com/lws/...`).

The dashboard never speaks to monerod directly for wallet-specific data —
it goes through this layer, which holds per-view-key indexes of which
outputs belong to which wallets.

## Trust model

What the LWS sees:

- **Your view key** — needed to scan incoming outputs. The view key alone
  cannot spend, only see.
- **Your primary address** — needed to compute the public spend key for
  output decryption.
- **Your wallet birthday** (optional) — sets the lower bound for the scan
  to avoid walking the chain from genesis.
- **Your signed transaction hex** when you broadcast — needed to forward
  to monerod's `send_raw_transaction`. The LWS does not see the inputs of
  the tx in plaintext (Monero hides them by design).

What the LWS does **not** see:

- Your **spend key** — never sent. Lives only in your browser tab.
- Your **seed phrase** — never sent. Lives only in your browser tab.
- Your **subaddress map** — derived locally from the spend key when needed.

## Endpoints

All endpoints are POST with JSON bodies. The base URL is
`https://node.monero-web.com/lws`.

### `POST /login`

Register a new wallet view key with the server. The server starts
scanning the chain from `created_at` (or genesis if not given).

**Request:**

```json
{
  "address":          "47RzzwG62wBc...VZeRCz",
  "view_key":         "8c0a6f...e1d9",
  "created_at":       3200000,
  "generated_locally": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string | yes | Primary address (95 chars, mainnet `4...`) |
| `view_key` | hex string | yes | 64-char private view key |
| `created_at` | int | no | Restore-from block height. For polyseed wallets, derive from `birthday * 2 weeks since 2021-11-01`. For BIP-39 / 25-word, ask the user or default to current chain tip if creating a new wallet. |
| `generated_locally` | bool | no | `true` for newly-created wallets so the server starts from the tip. `false` for imported wallets so the server scans from `created_at`. |

**Response (200):**

```json
{
  "new_address": true,
  "generated_locally": true,
  "start_height": 3648770
}
```

| Field | Type | Notes |
|---|---|---|
| `new_address` | bool | `true` if this view key was previously unknown to the LWS |
| `generated_locally` | bool | echoed from request |
| `start_height` | int | Block the LWS will start scanning from |

**Errors:**

- `400` — bad address / bad view key format
- `403` — view key doesn't match address (the LWS verifies cryptographically)
- `503` — the LWS is still starting up; retry in a few seconds

---

### `POST /get_address_info`

Get the wallet's current state — balance, scanned height, and metadata.
Called every ~30 seconds by the dashboard while the wallet view is open.

**Request:**

```json
{
  "address":  "47RzzwG62wBc...VZeRCz",
  "view_key": "8c0a6f...e1d9"
}
```

**Response (200):**

```json
{
  "locked_funds":           "0",
  "total_received":         "1234567890000",
  "total_sent":             "0",
  "scanned_height":         3648770,
  "scanned_block_height":   3648770,
  "start_height":           3648770,
  "transaction_height":     3648770,
  "blockchain_height":      3648770,
  "spent_outputs":          [ ... ],
  "rates": {}
}
```

| Field | Type | Notes |
|---|---|---|
| `locked_funds` | string (atomic) | Balance still locked (incoming, not yet spendable) |
| `total_received` | string (atomic) | Total ever received |
| `total_sent` | string (atomic) | Total ever spent |
| `scanned_height` | int | Last block the LWS has finished scanning for THIS wallet |
| `blockchain_height` | int | Current chain tip the LWS knows about |
| `spent_outputs` | array | Outputs the LWS has identified as spent (used for change calculation) |
| `rates` | object | Reserved (we don't use exchange rates) |

The dashboard computes the **available balance** as
`total_received - total_sent - locked_funds` (parsed from atomic string,
displayed via `MoneroRPC.formatXMR()`).

The dashboard shows a **scanning indicator** while
`scanned_height < blockchain_height`. The percentage is
`(scanned_height - start_height) / (blockchain_height - start_height) * 100`.

---

### `POST /get_address_txs`

Get the transaction history for the wallet.

**Request:**

```json
{
  "address":  "47RzzwG62wBc...VZeRCz",
  "view_key": "8c0a6f...e1d9"
}
```

**Response (200):**

```json
{
  "total_received":     "1234567890000",
  "scanned_height":     3648770,
  "blockchain_height":  3648770,
  "transactions": [
    {
      "id":               42,
      "hash":             "abc123...",
      "timestamp":        "2026-04-09T14:15:30Z",
      "total_received":   "500000000000",
      "total_sent":       "0",
      "fee":              "0",
      "unlock_time":      0,
      "height":           3648500,
      "payment_id":       null,
      "coinbase":         false,
      "mempool":          false,
      "mixin":            15,
      "spent_outputs":    []
    }
  ]
}
```

The dashboard renders this as a list newest-first with
direction (received/sent) inferred from `total_received` vs `total_sent`,
amount via `formatXMR()`, confirmations via
`blockchain_height - height`, and a click-to-expand for the rest.

---

### `POST /get_unspent_outs`

Get the wallet's unspent outputs — needed when constructing a new
transaction. mymonero-core-js calls this internally as part of the send
flow.

**Request:**

```json
{
  "address":      "47RzzwG62wBc...VZeRCz",
  "view_key":     "8c0a6f...e1d9",
  "amount":       "0",
  "mixin":        15,
  "use_dust":     true,
  "dust_threshold": "2000000000"
}
```

**Response:** an array of `output` objects with `amount`, `index`,
`global_index`, `tx_hash`, `tx_pub_key`, `rct` blob, and the per-output
key needed to compute the key image client-side.

The full schema is documented inline in `mymonero-core-js`'s
`monero_send_routine.js` — we link to it instead of duplicating it here
because the field set is large and version-dependent.

---

### `POST /get_random_outs`

Get random "decoy" outputs from the chain for ring signature mixing.
Called by mymonero-core-js when building a transaction.

**Request:**

```json
{
  "amounts": ["0"],
  "count":   16
}
```

**Response:** an array of output groups, each containing 16 random outputs
the wallet's tx-construction code uses as decoys.

---

### `POST /submit_raw_tx`

Broadcast a signed transaction. mymonero-core-js produces the hex; the
dashboard hands it to this endpoint; the LWS forwards to monerod's
`send_raw_transaction`.

**Request:**

```json
{
  "tx": "0200030203..."
}
```

**Response (200):**

```json
{
  "status": "OK"
}
```

**Errors:**

- `400` — malformed hex
- `403` — daemon rejected the tx (double-spend, invalid ring signature, etc.)
- `503` — daemon unreachable

The LWS may surface monerod's specific rejection reason in the response
body. The dashboard displays it verbatim in the send error state.

## Polling cadence

| Endpoint | Frequency | Why |
|---|---|---|
| `/login` | Once per session | Idempotent — registers if new, no-op if known |
| `/get_address_info` | Every 30 s while dashboard is open | Drives balance + scanning progress |
| `/get_address_txs` | Every 30 s while history view is open | Drives history list |
| `/get_unspent_outs` | On demand (when user clicks Send) | Needed once per tx |
| `/get_random_outs` | On demand (when user clicks Send) | Needed once per tx |
| `/submit_raw_tx` | On demand (final step of send) | Once per tx |

The 30-second polling interval matches the Monero block time and is
consistent with what other light wallets do.

## Caching and rate limits

- Cloudflare's edge **does not** cache LWS responses (they're per-wallet
  and change frequently). The Pages Function uses `Cache-Control: no-store`
  on these endpoints.
- The LWS itself rate-limits per IP (default: ~60 requests/minute) which
  is plenty for the 30-second polling cadence.

## Security headers

The dashboard makes these requests with `Content-Type: application/json`.
The LWS responds with permissive CORS (`Access-Control-Allow-Origin: *`)
because the dashboard is hosted at `monero-web.com` and the LWS is at
`node.monero-web.com` — same root domain but different subdomain, which
is technically cross-origin.

## What about the existing `/api/proxy` endpoint?

The existing Cloudflare Pages Function at `/api/proxy` forwards to
`monerod` (or our pruned node when synced). It's used for **chain-level**
queries: height, fee estimate, raw block data. It is **not** used for
wallet-specific data — that all goes through the LWS.

The two endpoints are complementary:

| Need | Use |
|---|---|
| Current chain height, fee estimate | `/api/proxy` (monerod via the smart-failover proxy) |
| Wallet balance, transaction history, unspent outputs, decoy outputs, broadcast | `/lws/...` (monero-lws on the VPS) |

This separation means a future "untrusted mode" where the LWS is bypassed
entirely is straightforward — just route everything through `/api/proxy`
and do the scanning client-side. The architecture supports both.
