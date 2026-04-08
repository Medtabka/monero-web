// SPDX-License-Identifier: MIT
/**
 * polyseed.js — Polyseed (16-word) decoder for Monero
 *
 * Implements the polyseed specification by tevador:
 *   https://github.com/tevador/polyseed
 *
 * Layout (16 × 11 = 176 bits):
 *   coeff[0]      = checksum (11 bits)
 *   coeff[1..15]  = 15 data words, each: 10 bits payload + 1 extra bit
 *                  payload bits → secret seed (150 bits)
 *                  extra bits   → 14 bits of (features<<10 | birthday)
 *
 * Verification: Horner-evaluate the polynomial at x=2 in GF(2^11) with
 * primitive polynomial of polyseed (encoded by polyseed_mul2_table). The
 * result must be zero. Coin (POLYSEED_MONERO=0) is XORed into coeff[1].
 *
 * Key derivation:
 *   PBKDF2-SHA256(
 *     password = secret (32 bytes; 19 used + 13 zero-pad),
 *     salt     = "POLYSEED key\0\xff\xff\xff" || u32_le(coin)
 *                  || u32_le(birthday) || u32_le(features),
 *     iterations = 10000,
 *     dkLen      = 32
 *   )
 *
 * Depends on: bip39-wordlist.js (polyseed English == BIP-39 English)
 */

const Polyseed = (function () {
  'use strict';

  const NUM_WORDS = 16;
  const GF_BITS = 11;
  const GF_SIZE = 1 << GF_BITS;
  const GF_MASK = GF_SIZE - 1;
  const SECRET_BITS = 150;
  const SECRET_SIZE = 19;
  const SECRET_BUFFER_SIZE = 32;
  const CLEAR_BITS = 2;
  const CLEAR_MASK = ~(((1 << CLEAR_BITS) - 1) << (8 - CLEAR_BITS)) & 0xff;
  const DATE_BITS = 10;
  const FEATURE_BITS = 5;
  const POLY_NUM_CHECK_DIGITS = 1;
  const DATA_WORDS = NUM_WORDS - POLY_NUM_CHECK_DIGITS;
  const COIN_MONERO = 0;

  // Mirrors polyseed_mul2_table from src/gf.c
  const MUL2_TABLE = [5, 7, 1, 3, 13, 15, 9, 11];

  function gfMul2(x) {
    if (x < 1024) return 2 * x;
    return MUL2_TABLE[x % 8] + 16 * Math.floor((x - 1024) / 8);
  }

  // Horner evaluation at x=2 — equals 0 for a valid checksum
  function gfPolyEval(coeff) {
    let r = coeff[NUM_WORDS - 1];
    for (let i = NUM_WORDS - 2; i >= 0; i--) {
      r = gfMul2(r) ^ coeff[i];
    }
    return r;
  }

  // Build a fast prefix→index map. Polyseed English uses the BIP-39 wordlist
  // with 4-character prefix matching (`has_prefix = true`).
  let _prefixMap = null;
  function buildPrefixMap() {
    if (_prefixMap) return _prefixMap;
    if (typeof BIP39_WORDLIST === 'undefined') {
      throw new Error('BIP39_WORDLIST not loaded — include js/bip39-wordlist.js first');
    }
    _prefixMap = Object.create(null);
    for (let i = 0; i < BIP39_WORDLIST.length; i++) {
      const w = BIP39_WORDLIST[i];
      _prefixMap[w] = i;
      if (w.length >= 4) _prefixMap[w.slice(0, 4)] = i;
    }
    return _prefixMap;
  }

  function lookupWord(word) {
    const map = buildPrefixMap();
    if (word in map) return map[word];
    if (word.length >= 4 && word.slice(0, 4) in map) return map[word.slice(0, 4)];
    return -1;
  }

  /**
   * Decode a polyseed phrase into its component data.
   * Mirrors polyseed_poly_to_data() from src/gf.c.
   *
   * @param {gf_elem[]} coeff - 16 polynomial coefficients (after coin XOR)
   * @returns {{secret: Uint8Array, birthday: number, features: number}}
   */
  function polyToData(coeff) {
    const secret = new Uint8Array(SECRET_BUFFER_SIZE);
    let extraVal = 0, extraBits = 0;
    let secretIdx = 0, secretBits = 0, seedBits = 0;

    for (let i = POLY_NUM_CHECK_DIGITS; i < NUM_WORDS; i++) {
      let wordVal = coeff[i];

      extraVal = (extraVal << 1) | (wordVal & 1);
      wordVal >>>= 1;
      let wordBits = GF_BITS - 1; // 10 payload bits per word
      extraBits++;

      while (wordBits > 0) {
        if (secretBits === 8) {
          secretIdx++;
          seedBits += secretBits;
          secretBits = 0;
        }
        const chunkBits = Math.min(wordBits, 8 - secretBits);
        wordBits -= chunkBits;
        const chunkMask = (1 << chunkBits) - 1;
        if (chunkBits < 8) {
          secret[secretIdx] = (secret[secretIdx] << chunkBits) & 0xff;
        }
        secret[secretIdx] |= (wordVal >>> wordBits) & chunkMask;
        secretBits += chunkBits;
      }
    }
    seedBits += secretBits;

    if (seedBits !== SECRET_BITS) throw new Error('polyseed: seed bit count mismatch');
    if (extraBits !== FEATURE_BITS + DATE_BITS) throw new Error('polyseed: extra bit count mismatch');
    // The top CLEAR_BITS of secret[18] must be zero
    if ((secret[SECRET_SIZE - 1] & ~CLEAR_MASK) !== 0) {
      throw new Error('polyseed: secret has trailing high bits set');
    }

    return {
      secret,
      birthday: extraVal & ((1 << DATE_BITS) - 1),
      features: (extraVal >>> DATE_BITS) & ((1 << FEATURE_BITS) - 1)
    };
  }

  /**
   * Decode a polyseed mnemonic phrase to its raw data.
   * Throws on bad word count, unknown word, or checksum mismatch.
   */
  function decode(phrase) {
    const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length !== NUM_WORDS) {
      throw new Error(`polyseed: expected ${NUM_WORDS} words, got ${words.length}`);
    }

    const coeff = new Array(NUM_WORDS);
    for (let i = 0; i < NUM_WORDS; i++) {
      const idx = lookupWord(words[i]);
      if (idx < 0) throw new Error(`polyseed: unknown word "${words[i]}"`);
      coeff[i] = idx & GF_MASK;
    }

    // Domain-separate by coin (Monero = 0, so this is a no-op but kept
    // explicit so that switching to a different coin requires only this line)
    coeff[POLY_NUM_CHECK_DIGITS] ^= COIN_MONERO;

    if (gfPolyEval(coeff) !== 0) {
      throw new Error('polyseed: invalid checksum');
    }

    return polyToData(coeff);
  }

  function u32le(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }

  /**
   * Build the PBKDF2 salt for polyseed key derivation.
   * Mirrors polyseed_keygen() from src/polyseed.c.
   */
  function buildSalt(birthday, features, coin) {
    const salt = new Uint8Array(32);
    const header = 'POLYSEED key';
    for (let i = 0; i < header.length; i++) salt[i] = header.charCodeAt(i);
    // salt[12] = 0 (string null terminator)
    salt[13] = 0xff; salt[14] = 0xff; salt[15] = 0xff;
    salt.set(u32le(coin), 16);
    salt.set(u32le(birthday), 20);
    salt.set(u32le(features), 24);
    // bytes 28..31 stay zero
    return salt;
  }

  /**
   * Derive the 32-byte Monero spend-key seed from a polyseed phrase.
   * Returns a Promise<Uint8Array> because PBKDF2-SHA256 runs through
   * SubtleCrypto, which is async.
   */
  async function deriveSeed(phrase) {
    const data = decode(phrase);
    const salt = buildSalt(data.birthday, data.features, COIN_MONERO);

    const baseKey = await crypto.subtle.importKey(
      'raw', data.secret, { name: 'PBKDF2' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' },
      baseKey,
      32 * 8
    );

    return {
      seed: new Uint8Array(bits),
      birthday: data.birthday,
      features: data.features
    };
  }

  return { decode, deriveSeed, buildSalt };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Polyseed;
