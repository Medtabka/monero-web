// SPDX-License-Identifier: MIT
/**
 * bip39.js — BIP-39 → SLIP-0010 (ed25519) → Monero spend key
 *
 * Standard BIP-39 wallets (12/15/18/21/24 words) derive a Monero key via:
 *   1. mnemonic → PBKDF2-SHA512(passphrase = "mnemonic" + user_passphrase,
 *                                iterations = 2048, dkLen = 64) → seed
 *   2. SLIP-0010 master:  HMAC-SHA512("ed25519 seed", seed)
 *      → IL = key (32), IR = chain code (32)
 *   3. Hardened-only path m/44'/128'/0' (Monero coin type per SLIP-0044 = 128)
 *      Each step:  I = HMAC-SHA512(parent_chaincode,
 *                                  0x00 || parent_key || ser32(0x80000000+i))
 *   4. The final 32-byte key is fed to MoneroKeys.deriveFromSeed.
 *
 * All hashing uses SubtleCrypto, so the public entry point is async.
 *
 * Depends on: bip39-wordlist.js
 */

const Bip39 = (function () {
  'use strict';

  const HARDENED = 0x80000000;
  // m / 44' / 128' / 0'  — Monero per SLIP-0044
  const MONERO_PATH = [44, 128, 0];

  function validateMnemonic(words) {
    const valid = [12, 15, 18, 21, 24];
    if (!valid.includes(words.length)) {
      throw new Error(`BIP-39: expected 12/15/18/21/24 words, got ${words.length}`);
    }
    if (typeof BIP39_WORDLIST === 'undefined') {
      throw new Error('BIP39_WORDLIST not loaded — include js/bip39-wordlist.js first');
    }
    for (const w of words) {
      if (BIP39_WORDLIST.indexOf(w) < 0) {
        throw new Error(`BIP-39: unknown word "${w}"`);
      }
    }
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  async function pbkdf2Sha512(password, salt, iterations, dkLen) {
    const key = await crypto.subtle.importKey(
      'raw', password, { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
      key, dkLen * 8
    );
    return new Uint8Array(bits);
  }

  async function hmacSha512(key, data) {
    const k = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', k, data);
    return new Uint8Array(sig);
  }

  /**
   * BIP-39 mnemonic → 64-byte seed (PBKDF2-SHA512, 2048 iterations).
   * Per the BIP-39 spec, the salt is "mnemonic" || passphrase.
   */
  async function mnemonicToSeed(mnemonic, passphrase) {
    const norm = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    validateMnemonic(norm.split(' '));
    const salt = utf8('mnemonic' + (passphrase || ''));
    return pbkdf2Sha512(utf8(norm), salt, 2048, 64);
  }

  /**
   * SLIP-0010 ed25519 master key from a seed.
   */
  async function slip10Master(seed) {
    const I = await hmacSha512(utf8('ed25519 seed'), seed);
    return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  }

  /**
   * SLIP-0010 hardened child derivation (the only kind ed25519 supports).
   */
  async function slip10ChildHardened(parent, index) {
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(parent.key, 1);
    const idx = index + HARDENED;
    // ser32 — big-endian
    data[33] = (idx >>> 24) & 0xff;
    data[34] = (idx >>> 16) & 0xff;
    data[35] = (idx >>> 8) & 0xff;
    data[36] = idx & 0xff;
    const I = await hmacSha512(parent.chainCode, data);
    return { key: I.slice(0, 32), chainCode: I.slice(32, 64) };
  }

  /**
   * Walk the m/44'/128'/0' path and return the leaf 32-byte key.
   * This 32-byte value becomes the Monero seed (still requires sc_reduce32).
   */
  async function deriveSpendSeed(mnemonic, passphrase) {
    const seed = await mnemonicToSeed(mnemonic, passphrase);
    let node = await slip10Master(seed);
    for (const i of MONERO_PATH) {
      node = await slip10ChildHardened(node, i);
    }
    return node.key;
  }

  return { mnemonicToSeed, deriveSpendSeed, validateMnemonic };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Bip39;
