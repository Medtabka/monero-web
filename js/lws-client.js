// SPDX-License-Identifier: MIT
/**
 * lws-client.js — Browser client for monero-lws (light-wallet server)
 *
 * Wraps the small set of HTTP endpoints monero-web's dashboard needs to
 * display balance, transaction history, and (eventually) construct send
 * transactions. The actual server lives on our Hetzner VPS at
 *   https://node.monero-web.com/lws/...
 * fronted by nginx + Cloudflare. The wire protocol is the legacy MyMonero
 * light-wallet protocol that monero-lws implements.
 *
 * Trust model
 * -----------
 *   • What the server sees:  view key, primary address, signed tx hex
 *   • What the server NEVER sees:  spend key, seed phrase, mnemonic
 *
 * The view key alone cannot spend funds — it can only see incoming outputs.
 * The spend key stays in the user's browser tab forever, encrypted by the
 * existing WalletVault session password.
 *
 * Public API:
 *   await LwsClient.login(address, viewKey, opts)        → register a wallet
 *   await LwsClient.getAddressInfo(address, viewKey)     → balance + state
 *   await LwsClient.getAddressTxs(address, viewKey)      → transaction history
 *   await LwsClient.getUnspentOuts(address, viewKey,...) → outputs to spend
 *   await LwsClient.getRandomOuts(amounts, count)        → ring decoys
 *   await LwsClient.submitRawTx(txHex)                   → broadcast
 *   LwsClient.setBaseUrl(url)                            → override default
 *   LwsClient.setMockMode(boolean)                       → for tests / dev
 *
 * Mock mode is enabled automatically if the dashboard is loaded from
 * localhost OR if `localStorage.getItem('lws-mock') === '1'`. In mock mode,
 * every endpoint returns plausible fake data so the UI can be developed and
 * demoed against a non-running backend. Toggle from DevTools:
 *   localStorage.setItem('lws-mock', '1')   // force mock on
 *   localStorage.removeItem('lws-mock')     // back to real backend
 */

const LwsClient = (function () {
  'use strict';

  // Default base URL — same origin pattern as the existing /api/proxy.
  // The /lws/ prefix is mapped by nginx on the VPS to the local
  // monero-lws-daemon listening on 127.0.0.1:8443.
  let BASE_URL = 'https://node.monero-web.com/lws';

  // Mock mode: if true, every call returns synthetic data instead of
  // hitting the network. Used for UI development before the real
  // backend exists, and for testing.
  let MOCK = false;

  // Auto-enable mock mode for local development so we don't need a
  // running monero-lws to iterate on the dashboard. The flag can be
  // forced on or off via localStorage.
  function detectMockDefault () {
    try {
      const flag = localStorage.getItem('lws-mock');
      if (flag === '1') return true;
      if (flag === '0') return false;
    } catch (e) {}
    if (typeof location === 'undefined') return false;
    return location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1' ||
           location.hostname === '';
  }
  MOCK = detectMockDefault();

  function setBaseUrl (url) {
    BASE_URL = url.replace(/\/$/, '');
  }
  function setMockMode (on) { MOCK = !!on; }
  function isMock () { return MOCK; }

  // ── Internal POST helper ──────────────────────────────────────────
  async function post (path, body) {
    if (MOCK) return mockResponse(path, body);
    const url = BASE_URL + path;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new LwsError('network', 'Could not reach light-wallet server: ' + e.message, e);
    }
    let data;
    try { data = await response.json(); }
    catch (e) {
      // Empty or non-JSON response — check HTTP status first
      if (!response.ok) {
        throw new LwsError(
          'server',
          'Server error (HTTP ' + response.status + ')',
          e,
          response.status
        );
      }
      throw new LwsError('decode', 'Light-wallet server returned invalid JSON', e);
    }
    if (!response.ok) {
      throw new LwsError(
        'server',
        (data && data.error) ? data.error : ('HTTP ' + response.status),
        null,
        response.status
      );
    }
    return data;
  }

  // ── Public endpoints ──────────────────────────────────────────────

  /**
   * Register a wallet's view key with the server. Idempotent — calling
   * this for an already-known wallet just returns the current state.
   *
   * @param {string} address      Primary address (95 chars)
   * @param {string} viewKey      Private view key (64 hex chars)
   * @param {object} [opts]
   * @param {number} [opts.createdAt]      Restore-from block height
   * @param {boolean} [opts.generatedLocally]  true for newly-created wallets
   */
  async function login (address, viewKey, opts) {
    opts = opts || {};
    var body = {
      address,
      view_key: viewKey,
      create_account:    true,
      generated_locally: !!opts.generatedLocally,
    };
    // Include start_height for imported wallets. NOTE: monero-lws ignores
    // this field in /login — it always registers at the current chain tip.
    // The actual scan-from height is set via /import_wallet_request's
    // from_height parameter. We still send start_height here in case a
    // future LWS build honours it at account-creation time.
    if (!opts.generatedLocally && typeof opts.createdAt === 'number' && opts.createdAt > 0) {
      body.start_height = opts.createdAt;
    } else if (!opts.generatedLocally) {
      body.start_height = 0;
    }
    try {
      return await post('/login', body);
    } catch (e) {
      if (isHiddenAccount(e)) {
        await reactivateAccount(address);
        return await post('/login', body);
      }
      throw e;
    }
  }

  /**
   * Request a historical rescan for an imported wallet. Must be called
   * AFTER login() for wallets that have existing transaction history
   * (i.e., not freshly generated). Without this, the LWS only scans
   * forward from the tip and misses historical transactions.
   *
   * @param {string} address    Primary address (95 chars)
   * @param {string} viewKey    Private view key (64 hex chars)
   * @param {number} [fromHeight=0]  Block to start scanning from.
   *   0 = genesis (slow but finds everything). A positive value skips
   *   older blocks for faster sync (e.g. polyseed birthday height).
   */
  async function importWalletRequest (address, viewKey, fromHeight) {
    var body = { address, view_key: viewKey };
    if (typeof fromHeight === 'number' && fromHeight > 0) {
      body.from_height = fromHeight;
    }
    return post('/import_wallet_request', body);
  }

  /**
   * Detect "account hidden/deactivated" errors from monero-lws. This
   * happens when an account is idle for 30+ days and the LWS hides it.
   * The /login endpoint returns 403 with an empty body for hidden accounts.
   */
  function isHiddenAccount (err) {
    if (!err) return false;
    // 403 from /login with empty body = hidden account.
    // 404 = account genuinely not found (also retriable).
    if (err.statusCode === 403 || err.statusCode === 404) return true;
    var msg = (err.message || '').toLowerCase();
    return msg.indexOf('not found') !== -1 ||
           msg.indexOf('no account') !== -1 ||
           msg.indexOf('account not') !== -1;
  }

  /**
   * Reactivate a hidden account via the admin API. monero-lws hides
   * accounts idle for 30+ days, and /login returns 403 for them.
   * The only way to bring them back is through the admin endpoint.
   * Exposed at /lws/admin/reactivate via nginx on the VPS.
   */
  async function reactivateAccount (address) {
    console.log('[lws] reactivating hidden account via admin API');
    var url = BASE_URL + '/admin/reactivate';
    var response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address }),
      });
    } catch (e) {
      throw new LwsError('network', 'Could not reach reactivation endpoint: ' + e.message, e);
    }
    if (!response.ok) {
      throw new LwsError('server', 'Reactivation failed (HTTP ' + response.status + ')', null, response.status);
    }
    return true;
  }

  /**
   * Get the wallet's current state (balance, scanning progress, etc.)
   * Called every ~30s while the dashboard is open. If the account was
   * hidden (idle 30+ days), automatically re-registers it and retries.
   */
  async function getAddressInfo (address, viewKey) {
    try {
      return await post('/get_address_info', { address, view_key: viewKey });
    } catch (e) {
      if (isHiddenAccount(e)) {
        await reactivateAccount(address);
        await post('/login', { address, view_key: viewKey, create_account: true, generated_locally: false });
        return await post('/get_address_info', { address, view_key: viewKey });
      }
      throw e;
    }
  }

  /**
   * Get the wallet's transaction history. Auto-reactivates hidden accounts.
   */
  async function getAddressTxs (address, viewKey) {
    try {
      return await post('/get_address_txs', { address, view_key: viewKey });
    } catch (e) {
      if (isHiddenAccount(e)) {
        await reactivateAccount(address);
        await post('/login', { address, view_key: viewKey, create_account: true, generated_locally: false });
        return await post('/get_address_txs', { address, view_key: viewKey });
      }
      throw e;
    }
  }

  /**
   * Get unspent outputs the wallet can spend. Used by the send flow
   * (mymonero-core-js will call this).
   */
  async function getUnspentOuts (address, viewKey, amount, mixin, useDust) {
    return post('/get_unspent_outs', {
      address,
      view_key: viewKey,
      amount: String(amount || '0'),
      mixin: mixin || 15,
      use_dust: !!useDust,
      dust_threshold: '2000000000',
    });
  }

  /**
   * Get random "decoy" outputs from the chain for ring signature mixing.
   */
  async function getRandomOuts (amounts, count) {
    return post('/get_random_outs', {
      amounts: amounts || ['0'],
      count: count || 16,
    });
  }

  /**
   * Broadcast a signed transaction.
   */
  async function submitRawTx (txHex) {
    return post('/submit_raw_tx', { tx: txHex });
  }

  // ── Helpers exposed to callers ────────────────────────────────────

  /**
   * Convenience: derive available balance from a get_address_info response.
   * Returns a BigInt (atomic units / piconero).
   */
  function availableBalance (info) {
    if (!info) return 0n;
    const total    = BigInt(info.total_received || '0');
    const spent    = BigInt(info.total_sent     || '0');
    const locked   = BigInt(info.locked_funds   || '0');
    const avail    = total - spent - locked;
    return avail < 0n ? 0n : avail;
  }

  /**
   * Convenience: scanning progress 0..1 derived from a get_address_info
   * response. Returns 1 if the LWS has caught up.
   */
  function scanProgress (info) {
    if (!info) return 0;
    const start  = info.start_height        || 0;
    const cur    = info.scanned_block_height || info.scanned_height || 0;
    const tip    = info.blockchain_height   || 0;
    if (tip <= start) return 1;
    if (cur >= tip)   return 1;
    // Treat "within 3 blocks of chain tip" as fully synced — the chain
    // advances while LWS finishes the last few blocks, which makes
    // progress stick at ~99% until the next poll catches up.
    if (tip - cur <= 3) return 1;
    return Math.max(0, Math.min(1, (cur - start) / (tip - start)));
  }

  /**
   * Format atomic units (piconero) as a human XMR string with no trailing
   * zeros. 1 XMR = 1e12 piconero. Accepts BigInt, string, or number.
   */
  function formatXmr (atomic) {
    let n;
    if (typeof atomic === 'bigint') n = atomic;
    else if (typeof atomic === 'string') n = BigInt(atomic);
    else n = BigInt(Math.round(Number(atomic) || 0));
    const sign = n < 0n ? '-' : '';
    if (n < 0n) n = -n;
    const whole = n / 1000000000000n;
    const frac  = n % 1000000000000n;
    if (frac === 0n) return sign + whole.toString();
    let fracStr = frac.toString().padStart(12, '0');
    fracStr = fracStr.replace(/0+$/, '');
    return sign + whole.toString() + '.' + fracStr;
  }

  // ── Custom error type ─────────────────────────────────────────────

  function LwsError (kind, message, cause, statusCode) {
    const err = new Error(message);
    err.name = 'LwsError';
    err.kind = kind;
    err.cause = cause || null;
    err.statusCode = statusCode || 0;
    return err;
  }

  // ── Mock backend (used for UI development without a running LWS) ──
  // Returns plausible-looking fake data deterministically derived from
  // the requested address so two calls with the same address return the
  // same numbers. Sync progress advances over time so the dashboard's
  // "scanning..." state is testable too.

  const _mockBirthMs = Date.now();

  function mockResponse (path, body) {
    return new Promise(resolve => setTimeout(() => {
      resolve(handleMock(path, body));
    }, 80 + Math.random() * 120));
  }

  function handleMock (path, body) {
    const tip = 3650000;
    const elapsed = (Date.now() - _mockBirthMs) / 1000;
    // Mock scan starts at tip-1000 and advances ~50 blocks/sec so the
    // UI shows a "scanning…" state for the first ~20 seconds.
    const startHeight = tip - 1000;
    const scanned = Math.min(tip, Math.floor(startHeight + elapsed * 50));

    if (path === '/login') {
      return {
        new_address: true,
        generated_locally: !!body.generated_locally,
        start_height: startHeight,
      };
    }

    if (path === '/get_address_info') {
      // Fake balance: 1.234 XMR received, 0 spent
      return {
        locked_funds:         '0',
        total_received:       '1234567890000',
        total_sent:           '0',
        scanned_height:       scanned,
        scanned_block_height: scanned,
        start_height:         startHeight,
        transaction_height:   scanned,
        blockchain_height:    tip,
        spent_outputs:        [],
        rates: {},
      };
    }

    if (path === '/get_address_txs') {
      return {
        total_received:    '1234567890000',
        scanned_height:    scanned,
        blockchain_height: tip,
        transactions: [
          {
            id: 1,
            hash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
            timestamp:      new Date(Date.now() - 86400 * 1000 * 3).toISOString(),
            total_received: '500000000000',
            total_sent:     '0',
            fee:            '0',
            unlock_time:    0,
            height:         tip - 432,
            payment_id:     null,
            coinbase:       false,
            mempool:        false,
            mixin:          15,
            spent_outputs:  [],
          },
          {
            id: 2,
            hash: '11112222333344445555666677778888999900001111222233334444aaaabbbb',
            timestamp:      new Date(Date.now() - 86400 * 1000 * 7).toISOString(),
            total_received: '734567890000',
            total_sent:     '0',
            fee:            '0',
            unlock_time:    0,
            height:         tip - 10080,
            payment_id:     null,
            coinbase:       false,
            mempool:        false,
            mixin:          15,
            spent_outputs:  [],
          },
        ],
      };
    }

    if (path === '/get_unspent_outs') {
      return { per_kb_fee: '24658', fee_mask: '10000', amount: '1234567890000', outputs: [] };
    }

    if (path === '/get_random_outs') {
      return { amount_outs: [{ amount: '0', outputs: [] }] };
    }

    if (path === '/submit_raw_tx') {
      return { status: 'OK' };
    }

    return { error: 'mock: unknown path ' + path };
  }

  return {
    login,
    importWalletRequest,
    getAddressInfo,
    getAddressTxs,
    getUnspentOuts,
    getRandomOuts,
    submitRawTx,
    availableBalance,
    scanProgress,
    formatXmr,
    setBaseUrl,
    setMockMode,
    isMock,
    LwsError,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LwsClient;
