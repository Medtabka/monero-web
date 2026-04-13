// SPDX-License-Identifier: MIT
/**
 * mymonero-loader.js — Browser-side loader for the vendored mymonero-core
 * WebAssembly module at js/mymonero-core/MyMoneroCoreCpp_WASM.js + .wasm
 *
 * The upstream bridge files (MyMoneroCoreBridge.js, MyMoneroCoreBridgeClass.js,
 * MyMoneroCoreBridgeEssentialsClass.js) use Node-style require() calls for
 * internal dependencies and an external npm package (@mymonero/mymonero-bridge-utils)
 * that we don't ship. Instead of fighting those, this loader skips the bridge
 * layer entirely and exposes the raw Emscripten module methods — the bridge
 * was really just a thin JS-to-C++ serialization shim and the methods we need
 * are already attached to the Module object.
 *
 * Public API:
 *
 *   await MoneroCore.load()       → Promise<Module>  (idempotent, cached)
 *   MoneroCore.isLoaded()         → bool
 *   MoneroCore.decodeAddress(addr, nettype)     → { pub_viewKey, pub_spendKey, ... }
 *   MoneroCore.sendStep1(params)  → { using_fee, mixin, final_total_wo_fee, ... }
 *   MoneroCore.sendStep2(params)  → { serialized_signed_tx, tx_hash, tx_key, ... }
 *
 * `nettype` is a string: 'MAINNET' | 'TESTNET' | 'STAGENET'.
 * All parameter/result objects are JSON-serializable — large integers
 * (atomic amounts) are passed as decimal strings because JSBigInt tokens
 * can't cross the JS↔WASM boundary cleanly.
 */

const MoneroCore = (function () {
  'use strict';

  const WASM_DIR = '/js/mymonero-core/';
  let _module = null;
  let _loadingPromise = null;
  let _loadError = null;

  function isLoaded () { return _module !== null; }
  function loadError () { return _loadError; }

  /**
   * Instantiate the Emscripten-generated module. Retries on failure
   * (e.g. if the first attempt failed due to a race condition).
   */
  async function load () {
    if (_module) return _module;
    if (_loadingPromise) return _loadingPromise;

    _loadingPromise = (async () => {
      if (typeof MyMoneroClient !== 'function') {
        _loadError = 'MyMoneroClient not available — script not loaded or blocked by browser';
        throw new Error(_loadError);
      }
      try {
        _module = await MyMoneroClient({
          locateFile: function (filename) {
            return WASM_DIR + filename;
          },
        });
        _loadError = null;
        return _module;
      } catch (e) {
        _loadError = e.message || 'WASM module failed to load';
        _loadingPromise = null; // allow retry on next call
        throw e;
      }
    })();

    return _loadingPromise;
  }

  // ── Address decoding ─────────────────────────────────────────────────
  /**
   * Validate and decode a Monero address into its component keys. Used
   * by the send flow to validate recipient input and detect sub/integrated
   * addresses.
   */
  function decodeAddress (address, nettype) {
    if (!_module) throw new Error('MoneroCore not loaded — call await MoneroCore.load() first');
    const args = JSON.stringify({
      address: String(address || '').trim(),
      nettype_string: nettype || 'MAINNET',
    });
    const ret = _module.decode_address(args);
    const parsed = JSON.parse(ret);
    if (parsed.err_msg) throw new Error('Invalid address: ' + parsed.err_msg);
    return parsed;
  }

  // ── Send: step 1 (pre-decoy planning) ────────────────────────────────
  /**
   * Given the wallet's unspent outputs + the amount to send, this returns
   * the fee estimate, required decoy count, and the subset of outputs
   * that will actually be spent. The dashboard uses this result to:
   *   1. Build a human-readable summary ('sending 0.5 XMR + 0.0001 XMR fee')
   *   2. Decide how many decoys to fetch via LwsClient.getRandomOuts()
   */
  function sendStep1 (params) {
    if (!_module) throw new Error('MoneroCore not loaded');
    const required = ['is_sweeping', 'payment_id_string', 'sending_amount',
                      'priority', 'fee_per_b', 'fee_mask', 'fork_version',
                      'unspent_outs', 'nettype_string'];
    for (const k of required) {
      if (params[k] === undefined) {
        throw new Error('sendStep1: missing required parameter "' + k + '"');
      }
    }
    const ret = _module.send_step1__prepare_params_for_get_decoys(JSON.stringify(params));
    const parsed = JSON.parse(ret);
    if (parsed.err_msg) throw new Error('sendStep1: ' + parsed.err_msg);
    return parsed;
  }

  // ── Send: step 2 (actual tx construction + signing) ──────────────────
  /**
   * Builds, signs, and serializes a Monero transaction. Returns the
   * signed hex that the dashboard hands to LwsClient.submitRawTx() for
   * broadcast. This is where the spend key is actually used — it lives
   * only in the arguments passed into this function, stays in-process
   * inside the WASM heap during signing, and is zeroed by the caller
   * afterwards.
   */
  function sendStep2 (params) {
    if (!_module) throw new Error('MoneroCore not loaded');
    const required = ['sec_viewKey_string', 'sec_spendKey_string',
                      'from_address_string', 'to_address_string', 'final_total_wo_fee',
                      'change_amount', 'fee_amount', 'using_outs', 'mix_outs',
                      'unlock_time', 'nettype_string'];
    for (const k of required) {
      if (params[k] === undefined) {
        throw new Error('sendStep2: missing required parameter "' + k + '"');
      }
    }
    const ret = _module.send_step2__try_create_transaction(JSON.stringify(params));
    const parsed = JSON.parse(ret);
    if (parsed.err_msg) throw new Error('sendStep2: ' + parsed.err_msg);
    return parsed;
  }

  // ── Key image generation ──────────────────────────────────────────────
  /**
   * Compute the key_image for a specific output. Used to verify whether
   * the LWS's spent-output detection is correct. The LWS can produce
   * false positives (it sees the wallet's output as a ring decoy in
   * someone else's transaction and flags it as spent). By computing
   * the real key_image client-side, we can compare it against what the
   * LWS reports and filter out false spends.
   *
   * @param {string} txPubKey     - 64-hex tx public key of the RECEIVING tx
   * @param {string} viewSecHex   - 64-hex private view key
   * @param {string} spendPubHex  - 64-hex public spend key
   * @param {string} spendSecHex  - 64-hex private spend key
   * @param {number} outIndex     - Output index within the receiving tx
   * @returns {string}            - 64-hex key image
   */
  function generateKeyImage (txPubKey, viewSecHex, spendPubHex, spendSecHex, outIndex) {
    if (!_module) throw new Error('MoneroCore not loaded');
    const ret = _module.generate_key_image(
      txPubKey, viewSecHex, spendPubHex, spendSecHex, '' + outIndex
    );
    const parsed = JSON.parse(ret);
    if (parsed.err_msg) throw new Error('generateKeyImage: ' + parsed.err_msg);
    return parsed.retVal;
  }

  function _getModule() { return _module; }

  return { load, isLoaded, decodeAddress, sendStep1, sendStep2, generateKeyImage, _getModule };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroCore;
