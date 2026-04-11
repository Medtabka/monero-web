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

  function isLoaded () { return _module !== null; }

  /**
   * Instantiate the Emscripten-generated module. The upstream JS file
   * exposes itself as `window.MyMoneroClient` (a factory). We call it
   * with a `locateFile` callback that resolves the .wasm path relative
   * to our vendored directory.
   */
  async function load () {
    if (_module) return _module;
    if (_loadingPromise) return _loadingPromise;

    _loadingPromise = (async () => {
      if (typeof MyMoneroClient !== 'function') {
        // The loader script (js/mymonero-core/MyMoneroCoreCpp_WASM.js) must
        // be added to the page via a <script> tag BEFORE mymonero-loader.js
        // is used. If it isn't, fail loudly.
        throw new Error(
          'mymonero-loader: MyMoneroClient global is missing. Include ' +
          '<script src="js/mymonero-core/MyMoneroCoreCpp_WASM.js"></script> ' +
          'before calling MoneroCore.load().'
        );
      }

      _module = await MyMoneroClient({
        locateFile: function (filename) {
          // Tell Emscripten to fetch the .wasm binary from our vendored path
          // instead of the script directory (which would be wrong when the
          // JS file is loaded via a relative <script src>).
          return WASM_DIR + filename;
        },
      });
      return _module;
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
    const required = ['sec_viewKey_string', 'sec_spendKey_string', 'pub_spendKey_string',
                      'from_address_string', 'to_address_string', 'final_total_wo_fee',
                      'change_amount', 'fee_amount', 'outputs', 'mix_outs',
                      'fake_outputs_count', 'unlock_time', 'nettype_string'];
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

  return { load, isLoaded, decodeAddress, sendStep1, sendStep2 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroCore;
