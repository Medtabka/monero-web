// SPDX-License-Identifier: MIT
/**
 * monero-send.js — Send-transaction module for monero-web
 *
 * Uses MoneroCore (mymonero-loader.js) for address validation and tx signing.
 * Output selection and fee calculation are done in pure JS to avoid the
 * async callback issue with the WASM's send_funds() function.
 *
 * Public API:
 *   MoneroSend.validateAddress(addr)        → { valid, reason, subaddress, integrated }
 *   MoneroSend.estimateFee(keys, to, amt, prio)  → { fee_xmr, fee_atomic, per_byte }
 *   MoneroSend.send(keys, to, amt, prio, pid, preview) → Promise<{ tx_hash }>
 *
 * Depends on:
 *   js/mymonero-loader.js  (MoneroCore — WASM bridge for sendStep2)
 *   js/lws-client.js       (LwsClient for network I/O)
 */

const MoneroSend = (function () {
  'use strict';

  const ATOMIC_PER_XMR = 1000000000000n;
  const DEFAULT_MIXIN = 15;

  // ── Address validation (no WASM needed) ───────────────────────────

  function validateAddress (addr) {
    if (!addr || typeof addr !== 'string') {
      return { valid: false, reason: 'empty' };
    }
    addr = addr.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(addr)) {
      return { valid: false, reason: 'wrong length or character set' };
    }
    var subaddress = false, integrated = false;
    if (addr.length === 106) {
      integrated = true;
    } else if (addr[0] === '8') {
      subaddress = true;
    }
    return { valid: true, subaddress: subaddress, integrated: integrated, raw: addr };
  }

  // ── Amount helpers ────────────────────────────────────────────────

  function xmrToAtomic (xmrStr) {
    var s = String(xmrStr).trim();
    if (!s) return '0';
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid XMR amount');
    var parts = s.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '').padEnd(12, '0').substring(0, 12);
    return (BigInt(whole) * ATOMIC_PER_XMR + BigInt(frac)).toString();
  }

  function atomicToXmr (atomic) {
    var n = BigInt(String(atomic || '0'));
    var whole = n / ATOMIC_PER_XMR;
    var frac = n % ATOMIC_PER_XMR;
    if (frac === 0n) return whole.toString();
    var fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
    return whole.toString() + '.' + fracStr;
  }

  // ── Fee estimation ────────────────────────────────────────────────

  var PRIO_MULT = { 1: 1, 2: 4, 3: 20, 4: 166 };
  var TYPICAL_TX_BYTES = 2000;

  async function estimateFee (walletKeys, toAddress, xmrAmount, priority) {
    var outs = await LwsClient.getUnspentOuts(
      walletKeys.address,
      walletKeys.privateViewKeyHex,
      '0', 16, false
    );

    var perKbFee = BigInt(outs.per_kb_fee || outs.per_byte_fee * 1024 || '24658');
    var feeMask = BigInt(outs.fee_mask || '10000');
    var mult = BigInt(PRIO_MULT[priority] || 4);

    var feeAtomic = (perKbFee * BigInt(TYPICAL_TX_BYTES) * mult) / 1024n;
    if (feeMask > 0n) {
      feeAtomic = ((feeAtomic + feeMask - 1n) / feeMask) * feeMask;
    }

    return {
      fee_atomic: feeAtomic.toString(),
      fee_xmr: LwsClient.formatXmr(feeAtomic),
      per_byte: (perKbFee / 1024n).toString(),
      _unspentResp: outs,
    };
  }

  // ── Send transaction ──────────────────────────────────────────────

  async function send (walletKeys, toAddress, xmrAmount, priority, paymentId, preview) {
    try {
      await MoneroCore.load();
    } catch (e) {
      throw new Error('Transaction signing requires a component that could not load. Try disabling ad blockers or use a different browser.');
    }

    var amountAtomic = BigInt(xmrToAtomic(xmrAmount));

    // 1. Always fetch fresh unspent outputs (never use cached preview —
    // the LWS state can change between Review and Confirm steps)
    var unspentResp = await LwsClient.getUnspentOuts(
      walletKeys.address, walletKeys.privateViewKeyHex,
      '0', DEFAULT_MIXIN, true
    );

    if (!unspentResp || !Array.isArray(unspentResp.outputs) || unspentResp.outputs.length === 0) {
      throw new Error('No spendable outputs found (LWS returned ' +
        (unspentResp ? (unspentResp.outputs ? unspentResp.outputs.length : 'no outputs field') : 'null') + ')');
    }

    // Verify which outputs are actually spendable using key_image
    // verification. Outputs with spend_key_images may be falsely flagged
    // (ring decoy appearances). Compute the real key_image and check.
    var spendableOuts = [];
    for (var oi = 0; oi < unspentResp.outputs.length; oi++) {
      var o = unspentResp.outputs[oi];
      if (!o.spend_key_images || o.spend_key_images.length === 0) {
        // No spend reports — definitely unspent
        spendableOuts.push(o);
      } else {
        // Has spend reports — verify with key_image
        try {
          var realKI = MoneroCore.generateKeyImage(
            o.tx_pub_key,
            walletKeys.privateViewKeyHex,
            walletKeys.publicSpendKeyHex,
            walletKeys.privateSpendKeyHex,
            o.index
          );
          // If the real key_image is NOT in the spend list, the output
          // is unspent (the reports are false positives from ring decoys)
          var isSpent = o.spend_key_images.indexOf(realKI) >= 0;
          if (!isSpent) spendableOuts.push(o);
        } catch (e) {
          // Key_image computation failed — skip this output to be safe
        }
      }
    }

    if (spendableOuts.length === 0) {
      throw new Error('No spendable outputs available. Your funds may still be confirming — wait a few minutes and try again.');
    }

    // 2. Select outputs to spend (simple: use all, let WASM compute change)
    var perByteFee = Number(unspentResp.per_byte_fee || unspentResp.per_kb_fee / 1024 || 20);
    var feeMask = Number(unspentResp.fee_mask || 10000);
    var mult = PRIO_MULT[priority] || 4;
    var estFee = Math.ceil(perByteFee * TYPICAL_TX_BYTES * mult);
    if (feeMask > 0) estFee = Math.ceil(estFee / feeMask) * feeMask;

    var totalAvailable = 0n;
    var selectedOuts = [];
    // Sort by amount descending — pick fewest outputs needed
    spendableOuts.sort(function (a, b) {
      return Number(BigInt(b.amount) - BigInt(a.amount));
    });
    for (var i = 0; i < spendableOuts.length; i++) {
      selectedOuts.push(spendableOuts[i]);
      totalAvailable += BigInt(spendableOuts[i].amount);
      if (totalAvailable >= amountAtomic + BigInt(estFee)) break;
    }

    if (totalAvailable < amountAtomic + BigInt(estFee)) {
      throw new Error('Insufficient funds: need ' +
        atomicToXmr((amountAtomic + BigInt(estFee)).toString()) +
        ' XMR but only have ' + atomicToXmr(totalAvailable.toString()) + ' XMR');
    }

    var feeAmount = BigInt(estFee);
    var changeAmount = totalAvailable - amountAtomic - feeAmount;

    // 3. Fetch ring decoys
    var decoyAmounts = selectedOuts.map(function () { return '0'; });
    var mixResp = await LwsClient.getRandomOuts(decoyAmounts, DEFAULT_MIXIN + 1);
    if (!mixResp || !Array.isArray(mixResp.amount_outs)) {
      throw new Error('Failed to fetch ring decoys from server');
    }

    // 4. Normalize output formats for WASM
    var wasmOutputs = selectedOuts.map(function (o) {
      var out = {
        amount: String(o.amount),
        public_key: o.public_key,
        index: String(o.index || 0),
        global_index: String(o.global_index),
        tx_pub_key: o.tx_pub_key,
        rct: o.rct || '',
      };
      if (o.spend_key_images) out.spend_key_images = o.spend_key_images;
      if (o.tx_id !== undefined) out.tx_id = String(o.tx_id);
      if (o.tx_hash) out.tx_hash = o.tx_hash;
      if (o.tx_prefix_hash) out.tx_prefix_hash = o.tx_prefix_hash;
      if (o.height !== undefined) out.height = String(o.height);
      if (o.timestamp) out.timestamp = o.timestamp;
      if (o.recipient) out.recipient = o.recipient;
      return out;
    });

    // 5. Build and sign via WASM (synchronous — no async callbacks)

    var step2Params = {
      from_address_string: walletKeys.address,
      sec_viewKey_string: walletKeys.privateViewKeyHex,
      sec_spendKey_string: walletKeys.privateSpendKeyHex,
      to_address_string: toAddress,
      final_total_wo_fee: amountAtomic.toString(),
      change_amount: changeAmount.toString(),
      fee_amount: feeAmount.toString(),
      priority: String(priority || 2),
      fee_per_b: String(perByteFee),
      fee_mask: String(feeMask),
      using_outs: wasmOutputs,
      mix_outs: mixResp.amount_outs,
      unlock_time: '0',
      nettype_string: 'MAINNET',
    };
    if (paymentId) step2Params.payment_id_string = paymentId;

    var step2Result;
    try {
      step2Result = MoneroCore.sendStep2(step2Params);
    } catch (e) {
      var msg = 'Transaction signing failed';
      if (typeof e === 'number') {
        // WASM C++ exception — try to read error string
        try {
          var mod = MoneroCore._getModule ? MoneroCore._getModule() : null;
          if (mod && mod.UTF8ToString) msg = mod.UTF8ToString(e) || msg;
        } catch (x) {}
        console.error('[send] WASM signing exception (ptr ' + e + '):', msg);
      } else if (e && e.message) {
        msg = e.message;
        console.error('[send] signing error:', msg);
      } else {
        console.error('[send] signing error (raw):', e);
      }
      throw new Error(msg);
    }

    if (!step2Result || !step2Result.serialized_signed_tx) {
      console.error('[send] step2 returned:', JSON.stringify(step2Result));
      throw new Error('Transaction signing failed — no signed output');
    }

    // 6. Broadcast
    try {
      var broadcastResp = await LwsClient.submitRawTx(step2Result.serialized_signed_tx);
      if (!broadcastResp || broadcastResp.status !== 'OK') {
        var reason = (broadcastResp && broadcastResp.error) || 'unknown';
        throw new Error(reason);
      }
    } catch (bcErr) {
      var errMsg = bcErr.message || String(bcErr);
      if (/double.spend|already.spent/i.test(errMsg)) {
        throw new Error('Transaction rejected — an output was already spent. Wait a few minutes for confirmations and try again.');
      } else if (/fee.too.low/i.test(errMsg)) {
        throw new Error('Transaction fee is too low. Try a higher priority.');
      } else if (/network|reach|timeout/i.test(errMsg)) {
        throw new Error('Could not reach the wallet server. Check your connection and try again.');
      } else {
        throw new Error('Broadcast failed: ' + errMsg + '. Your funds have not been sent.');
      }
    }

    return {
      tx_hash: step2Result.tx_hash,
      tx_key: step2Result.tx_key || '',
      mixin: DEFAULT_MIXIN,
    };
  }

  return { validateAddress: validateAddress, estimateFee: estimateFee, send: send };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroSend;
