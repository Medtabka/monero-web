// SPDX-License-Identifier: MIT
/**
 * send.js — Orchestrates the full Monero send flow
 *
 * Ties together three components:
 *   1. LwsClient  — fetch unspent outputs + decoys, broadcast signed tx
 *   2. MoneroCore — the WASM bridge that validates addresses and builds/signs tx
 *   3. The dashboard UI — validation, confirmation, progress, result
 *
 * Public API:
 *
 *   MoneroSend.validateAddress(address)   → {valid, subaddress, integrated}
 *   await MoneroSend.estimateFee(keys, toAddress, xmrAmount, priority)
 *         → { fee_xmr, mixin, change_xmr, inputs_used }
 *   await MoneroSend.send(keys, toAddress, xmrAmount, priority, paymentId)
 *         → { tx_hash, tx_hex, tx_key }
 *   MoneroSend.xmrToAtomic(xmrString) → string (atomic, e.g. '500000000000' for 0.5)
 *   MoneroSend.atomicToXmr(atomic)    → string ('0.5')
 *
 * The `keys` argument is the same object we store in WalletVault:
 *   { address, privateSpendKeyHex, privateViewKeyHex, publicSpendKeyHex, publicViewKeyHex }
 *
 * Priority is an integer 1-4 matching monerod's fee tiers:
 *   1 = slow (cheapest)
 *   2 = normal  (default)
 *   3 = fast
 *   4 = fastest
 */

const MoneroSend = (function () {
  'use strict';

  // Monero uses 12 decimal places. 1 XMR = 10^12 atomic units (piconero).
  const ATOMIC_PER_XMR = 1000000000000n;
  const DEFAULT_MIXIN = 15;
  const UNLOCK_TIME = 0;

  // ── Amount helpers (BigInt-safe, since JS Numbers can't handle atomic XMR) ──

  function xmrToAtomic (xmrString) {
    const s = String(xmrString).trim();
    if (!s) return '0';
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) throw new Error('Invalid XMR amount');
    const [whole, frac = ''] = s.split('.');
    if (frac.length > 12) throw new Error('XMR amount has more than 12 decimal places');
    const padded = (frac + '000000000000').slice(0, 12);
    return (BigInt(whole) * ATOMIC_PER_XMR + BigInt(padded)).toString();
  }

  function atomicToXmr (atomic) {
    let n;
    if (typeof atomic === 'bigint') n = atomic;
    else n = BigInt(String(atomic || '0'));
    const whole = n / ATOMIC_PER_XMR;
    const frac  = n % ATOMIC_PER_XMR;
    if (frac === 0n) return whole.toString();
    let fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
    return whole.toString() + '.' + fracStr;
  }

  // ── Address validation ──────────────────────────────────────────────

  /**
   * Validate a Monero address string WITHOUT loading the WASM. Fast, regex-only.
   * For a full cryptographic validation (checksum, network match, type detection)
   * call validateAddressFull() which instantiates the WASM bridge.
   */
  function validateAddress (address) {
    if (typeof address !== 'string') return { valid: false, reason: 'not a string' };
    const a = address.trim();
    // Monero addresses: 95 chars base58 for primary, 106 for integrated,
    // starting with 4/5/8/9/A depending on network and type.
    if (!/^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(a)) {
      return { valid: false, reason: 'wrong length or character set' };
    }
    const first = a[0];
    let subaddress = false, integrated = false;
    if (a.length === 106) {
      integrated = true;
    } else if (first === '8' || first === '6' || first === '7' || first === 'B' || first === 'C') {
      // 8... is mainnet subaddress; testnet/stagenet have their own prefixes
      subaddress = true;
    }
    return { valid: true, subaddress, integrated, raw: a };
  }

  /**
   * Full cryptographic validation via WASM. Loads MoneroCore on demand.
   * Returns the decoded address object (pub_viewKey, pub_spendKey, etc.)
   * or throws on invalid address.
   */
  async function validateAddressFull (address, nettype) {
    await MoneroCore.load();
    return MoneroCore.decodeAddress(address, nettype || 'MAINNET');
  }

  // ── Fee estimation (step 1) ─────────────────────────────────────────

  /**
   * Ask the WASM + LWS what this send would cost before actually building
   * the transaction. Returns a preview the UI can show on the confirm screen.
   */
  async function estimateFee (keys, toAddress, xmrAmount, priority) {
    await MoneroCore.load();

    // 1. Fetch unspent outputs from the LWS
    const unspentResp = await LwsClient.getUnspentOuts(
      keys.address,
      keys.privateViewKeyHex,
      '0',   // no amount filter — return everything
      DEFAULT_MIXIN,
      true
    );

    if (!unspentResp || !Array.isArray(unspentResp.outputs)) {
      throw new Error('Light-wallet server returned no outputs for this wallet');
    }

    // 2. Ask step1 what the fee/plan would look like
    const step1 = MoneroCore.sendStep1({
      is_sweeping:       false,
      payment_id_string: '',
      sending_amount:    xmrToAtomic(xmrAmount),
      priority:          priority || 2,
      fee_per_b:         unspentResp.per_kb_fee || '24658',
      fee_mask:          unspentResp.fee_mask || '10000',
      fork_version:      16,     // current Monero fork version (as of 2026-04)
      unspent_outs:      unspentResp.outputs,
      nettype_string:    'MAINNET',
    });

    return {
      fee_xmr:       atomicToXmr(step1.using_fee),
      fee_atomic:    step1.using_fee,
      total_xmr:     atomicToXmr(step1.final_total_wo_fee),
      change_xmr:    atomicToXmr(step1.change_amount),
      mixin:         step1.mixin || DEFAULT_MIXIN,
      inputs_used:   (step1.using_outs || []).length,
      // Passed through to sendStep2 — the dashboard caches this so
      // estimate → confirm → send reuses the same plan.
      _step1:        step1,
      _unspentResp:  unspentResp,
    };
  }

  // ── Actual send (step 2 + broadcast) ────────────────────────────────

  /**
   * Build, sign, and broadcast a Monero transaction. Call this AFTER
   * estimateFee() — it reuses the preview's inputs and avoids a second
   * round-trip to the LWS for outputs.
   *
   * The spend key enters this function and stays in JS memory only long
   * enough to be passed into the WASM heap. The caller is responsible
   * for ensuring WalletVault is unlocked first.
   */
  async function send (keys, toAddress, xmrAmount, priority, paymentId, preview) {
    await MoneroCore.load();

    const est = preview || await estimateFee(keys, toAddress, xmrAmount, priority);
    const step1 = est._step1;
    const unspentResp = est._unspentResp;

    // Fetch the ring decoys for the chosen inputs
    const mixResp = await LwsClient.getRandomOuts(
      (step1.using_outs || []).map(o => String(o.amount)),
      (step1.mixin || DEFAULT_MIXIN) + 1
    );
    if (!mixResp || !Array.isArray(mixResp.amount_outs)) {
      throw new Error('Light-wallet server returned no decoys');
    }

    // Build and sign
    const step2 = MoneroCore.sendStep2({
      from_address_string:  keys.address,
      sec_viewKey_string:   keys.privateViewKeyHex,
      sec_spendKey_string:  keys.privateSpendKeyHex,
      pub_spendKey_string:  keys.publicSpendKeyHex,
      to_address_string:    toAddress,
      payment_id_string:    paymentId || '',
      final_total_wo_fee:   step1.final_total_wo_fee,
      change_amount:        step1.change_amount,
      fee_amount:           step1.using_fee,
      outputs:              step1.using_outs || [],
      mix_outs:             mixResp.amount_outs,
      fake_outputs_count:   step1.mixin || DEFAULT_MIXIN,
      unlock_time:          UNLOCK_TIME,
      nettype_string:       'MAINNET',
    });

    if (!step2 || !step2.serialized_signed_tx) {
      throw new Error('Transaction construction returned no signed hex');
    }

    // Broadcast via LWS
    const broadcastResp = await LwsClient.submitRawTx(step2.serialized_signed_tx);
    if (!broadcastResp || broadcastResp.status !== 'OK') {
      throw new Error('Broadcast rejected: ' + (broadcastResp && broadcastResp.error || 'unknown'));
    }

    return {
      tx_hash: step2.tx_hash,
      tx_hex:  step2.serialized_signed_tx,
      tx_key:  step2.tx_key,
      status:  'broadcast',
    };
  }

  return {
    validateAddress,
    validateAddressFull,
    estimateFee,
    send,
    xmrToAtomic,
    atomicToXmr,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroSend;
