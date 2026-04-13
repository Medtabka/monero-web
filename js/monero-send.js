// SPDX-License-Identifier: MIT
/**
 * monero-send.js — Browser-native send-transaction module
 *
 * Loads the vendored mymonero-core WASM blob and exposes a clean API that
 * the dashboard's send-flow code calls:
 *
 *   MoneroSend.validateAddress(addr)        → { valid, reason, subaddress, integrated }
 *   MoneroSend.estimateFee(keys, to, amt, prio)  → { fee_xmr, fee_atomic, per_byte }
 *   MoneroSend.send(keys, to, amt, prio, pid, preview) → Promise<{ tx_hash }>
 *
 * The WASM module handles RingCT / CLSAG / Bulletproofs+ / stealth addresses.
 * JS handles the I/O (fetching outputs + decoys from LWS, broadcasting).
 *
 * Depends on:
 *   js/mymonero-core/MyMoneroCoreCpp_WASM.js  (Emscripten loader → global MyMoneroClient)
 *   js/mymonero-core/MyMoneroCoreCpp_WASM.wasm (crypto blob)
 *   js/lws-client.js  (LwsClient for network I/O)
 */

const MoneroSend = (function () {
  'use strict';

  let _module = null;
  let _loading = null;

  // ── WASM loader ───────────────────────────────────────────────────

  async function _ensureModule () {
    if (_module) return _module;
    if (_loading) return _loading;
    _loading = (async () => {
      if (typeof MyMoneroClient !== 'function') {
        throw new Error('MyMoneroClient not loaded — include MyMoneroCoreCpp_WASM.js');
      }
      const mod = await MyMoneroClient({
        locateFile: function (f) { return '/js/mymonero-core/' + f; }
      });
      _module = mod;
      return mod;
    })();
    return _loading;
  }

  // ── Address validation (no WASM needed) ───────────────────────────

  const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B58_RE = new RegExp('^[' + BASE58_CHARS + ']+$');

  function validateAddress (addr) {
    if (!addr || typeof addr !== 'string') {
      return { valid: false, reason: 'empty' };
    }
    addr = addr.trim();
    if (!B58_RE.test(addr)) {
      return { valid: false, reason: 'invalid characters' };
    }

    // Mainnet primary: 95 chars, starts with 4
    if (addr.length === 95 && addr[0] === '4') {
      return { valid: true, subaddress: false, integrated: false };
    }
    // Mainnet subaddress: 95 chars, starts with 8
    if (addr.length === 95 && addr[0] === '8') {
      return { valid: true, subaddress: true, integrated: false };
    }
    // Integrated address: 106 chars, starts with 4
    if (addr.length === 106 && addr[0] === '4') {
      return { valid: true, subaddress: false, integrated: true };
    }
    // Stagenet primary: starts with 5
    if (addr.length === 95 && addr[0] === '5') {
      return { valid: true, subaddress: false, integrated: false };
    }
    // Testnet primary: starts with 9 or A
    if (addr.length === 95 && (addr[0] === '9' || addr[0] === 'A')) {
      return { valid: true, subaddress: false, integrated: false };
    }

    return { valid: false, reason: 'wrong length or prefix' };
  }

  // ── Fee estimation (calls LWS, no WASM needed) ───────────────────

  // Priority multipliers (matches Monero source wallet2.cpp)
  const PRIO_MULT = { 1: 1, 2: 4, 3: 20, 4: 166 };
  // Typical tx size in bytes for a 2-input / 2-output RingCT tx
  const TYPICAL_TX_BYTES = 2000;

  async function estimateFee (walletKeys, toAddress, xmrAmount, priority) {
    // Fetch fee parameters from the LWS (which gets them from monerod)
    const outs = await LwsClient.getUnspentOuts(
      walletKeys.address,
      walletKeys.privateViewKeyHex,
      '0',  // amount=0 means "give me fee info only"
      16,
      false
    );

    const perKbFee = BigInt(outs.per_kb_fee || outs.per_byte_fee || '24658');
    const feeMask  = BigInt(outs.fee_mask  || '10000');
    const mult     = BigInt(PRIO_MULT[priority] || 4);

    // fee = (per_kb_fee / 1024) * estimated_bytes * priority_multiplier
    // rounded UP to the nearest fee_mask multiple
    let feeAtomic = (perKbFee * BigInt(TYPICAL_TX_BYTES) * mult) / 1024n;
    if (feeMask > 0n) {
      feeAtomic = ((feeAtomic + feeMask - 1n) / feeMask) * feeMask;
    }

    return {
      fee_atomic: feeAtomic.toString(),
      fee_xmr:    LwsClient.formatXmr(feeAtomic),
      per_byte:   (perKbFee / 1024n).toString(),
    };
  }

  // ── XMR string → atomic units (piconero) ──────────────────────────

  function xmrToAtomic (xmrStr) {
    const parts = xmrStr.split('.');
    const whole = parts[0] || '0';
    let frac = (parts[1] || '').padEnd(12, '0').substring(0, 12);
    return BigInt(whole) * 1000000000000n + BigInt(frac);
  }

  // ── Send transaction (WASM-powered) ───────────────────────────────

  async function send (walletKeys, toAddress, xmrAmount, priority, paymentId, _preview) {
    console.log('[send] send() called, loading WASM...');
    let mod;
    try {
      mod = await _ensureModule();
      console.log('[send] WASM loaded OK, send_funds exists:', typeof mod.send_funds);
    } catch (e) {
      console.error('[send] WASM load failed:', e);
      throw e;
    }

    const amountAtomic = xmrToAtomic(xmrAmount).toString();
    const nettype = 0; // MAINNET

    return new Promise(function (resolve, reject) {
      const taskId = Math.random().toString(36).substr(2, 9);

      // ── WASM → JS callbacks ──────────────────────────────────────

      mod.fromCpp__send_funds__get_unspent_outs = function (_tid, reqStr) {
        console.log('[send] WASM requesting unspent outs');
        var req = typeof reqStr === 'string' ? JSON.parse(reqStr) : reqStr;
        LwsClient.getUnspentOuts(
          walletKeys.address,
          walletKeys.privateViewKeyHex,
          req.amount || amountAtomic,
          parseInt(req.mixin, 10) || 16,
          req.use_dust === true || req.use_dust === 'true'
        ).then(function (res) {
          console.log('[send] got unspent outs:', JSON.stringify(res).slice(0, 200));
          try {
            var cbArg = JSON.stringify({ task_id: taskId, res: res });
            console.log('[send] calling send_cb_I, arg length:', cbArg.length);
            var ret = JSON.parse(mod.send_cb_I__got_unspent_outs(cbArg));
            console.log('[send] send_cb_I returned:', JSON.stringify(ret).slice(0, 200));
            if (ret && ret.err_msg) reject(new Error(ret.err_msg));
          } catch (e) {
            console.error('[send] send_cb_I error:', e);
            reject(e);
          }
        }).catch(function (e) {
          console.error('[send] getUnspentOuts failed:', e);
          try { mod.send_cb_I__got_unspent_outs(JSON.stringify({
            task_id: taskId, err_msg: e.message || String(e)
          })); } catch (x) {}
          reject(e);
        });
      };

      mod.fromCpp__send_funds__get_random_outs = function (_tid, reqStr) {
        console.log('[send] WASM requesting random outs (decoys)');
        var req = typeof reqStr === 'string' ? JSON.parse(reqStr) : reqStr;
        LwsClient.getRandomOuts(
          req.amounts || ['0'],
          parseInt(req.count, 10) || 16
        ).then(function (res) {
          try {
            var ret = JSON.parse(mod.send_cb_II__got_random_outs(
              JSON.stringify({ task_id: taskId, res: res })
            ));
            if (ret && ret.err_msg) reject(new Error(ret.err_msg));
          } catch (e) { reject(e); }
        }).catch(function (e) {
          try { mod.send_cb_II__got_random_outs(JSON.stringify({
            task_id: taskId, err_msg: e.message || String(e)
          })); } catch (x) {}
          reject(e);
        });
      };

      mod.fromCpp__send_funds__submit_raw_tx = function (_tid, reqStr) {
        console.log('[send] WASM submitting signed tx');
        var req = typeof reqStr === 'string' ? JSON.parse(reqStr) : reqStr;
        LwsClient.submitRawTx(req.tx).then(function (res) {
          try {
            var ret = JSON.parse(mod.send_cb_III__submitted_tx(
              JSON.stringify({ task_id: taskId, res: res })
            ));
            if (ret && ret.err_msg) reject(new Error(ret.err_msg));
          } catch (e) { reject(e); }
        }).catch(function (e) {
          try { mod.send_cb_III__submitted_tx(JSON.stringify({
            task_id: taskId, err_msg: e.message || String(e)
          })); } catch (x) {}
          reject(e);
        });
      };

      mod.fromCpp__send_funds__status_update = function (_tid, paramsStr) {
        // Status updates are informational; we don't surface them in the
        // current UI but could add a progress indicator later.
      };

      mod.fromCpp__send_funds__error = function (_tid, paramsStr) {
        console.error('[send] WASM error callback:', paramsStr);
        try {
          var p = typeof paramsStr === 'string' ? JSON.parse(paramsStr) : paramsStr;
          reject(new Error(p.err_msg || 'Transaction construction failed'));
        } catch (e) {
          reject(new Error('Transaction construction failed'));
        }
      };

      mod.fromCpp__send_funds__success = function (_tid, paramsStr) {
        try {
          var p = typeof paramsStr === 'string' ? JSON.parse(paramsStr) : paramsStr;
          resolve({
            tx_hash:  p.tx_hash || p.serialized_signed_tx_hash || 'unknown',
            tx_fee:   p.used_fee || '0',
            mixin:    parseInt(p.mixin, 10) || 16,
          });
        } catch (e) {
          resolve({ tx_hash: 'unknown' });
        }
      };

      // ── Kick off the WASM send ────────────────────────────────────

      var args = {
        task_id:             taskId,
        is_sweeping:         false,
        sending_amount:      amountAtomic,
        from_address_string: walletKeys.address,
        sec_viewKey_string:  walletKeys.privateViewKeyHex,
        sec_spendKey_string: walletKeys.privateSpendKeyHex,
        pub_spendKey_string: walletKeys.publicSpendKeyHex,
        to_address_string:   toAddress,
        priority:            String(priority || 2),
        nettype_string:      'MAINNET',
        unlock_time:         '0',
      };
      if (paymentId) args.payment_id_string = paymentId;

      try {
        console.log('[send] calling send_funds with args:', JSON.stringify(args).slice(0, 200) + '...');
        var retStr = mod.send_funds(JSON.stringify(args));
        console.log('[send] send_funds returned:', retStr);
        var ret = JSON.parse(retStr);
        if (ret && ret.err_msg) {
          console.error('[send] send_funds error:', ret.err_msg);
          reject(new Error(ret.err_msg));
        }
      } catch (e) {
        console.error('[send] send_funds exception:', e);
        reject(e);
      }
    });
  }

  return { validateAddress, estimateFee, send };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroSend;
