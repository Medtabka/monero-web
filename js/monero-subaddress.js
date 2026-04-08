// SPDX-License-Identifier: MIT
/**
 * monero-subaddress.js — Monero subaddress derivation
 *
 * Subaddress (major i, minor j) for an account with private view key `a`
 * and public spend key `D`:
 *
 *   m       = Hs("SubAddr\0" || a || u32_le(i) || u32_le(j))
 *           where Hs(x) = sc_reduce32(Keccak256(x))
 *   D'      = D + m·G            (subaddress public spend)
 *   C'      = a·D'               (subaddress public view)
 *   address = base58( 0x2A || D' || C' || keccak256(prefix)[0..4] )
 *
 * The (0,0) subaddress index is reserved for the primary address and must
 * NOT be encoded as a subaddress — it has its own (standard) network byte.
 *
 * Depends on: keccak256.js, monero-ed25519.js
 */

const MoneroSubaddress = (function () {
  'use strict';

  const SUBADDRESS_NETBYTE = 0x2A; // mainnet subaddress prefix → "8..."

  function u32le(n) {
    return new Uint8Array([
      n & 0xff,
      (n >>> 8) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 24) & 0xff
    ]);
  }

  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  /**
   * Hash-to-scalar: sc_reduce32(Keccak256(data))
   */
  function hashToScalar(data) {
    return MoneroEd25519.sc_reduce32(Keccak256.hash(data));
  }

  /**
   * Compute the subaddress secret scalar `m` for index (major, minor).
   */
  function subaddressSecret(privateViewKey, major, minor) {
    const prefix = new TextEncoder().encode('SubAddr\0');
    return hashToScalar(concat([prefix, privateViewKey, u32le(major), u32le(minor)]));
  }

  /**
   * Encode a Monero subaddress from its public spend & view points.
   * Mirrors MoneroKeys.encodeAddress() but with the subaddress netbyte.
   */
  function encodeSubaddress(pubSpend, pubView) {
    const raw = new Uint8Array(69);
    raw[0] = SUBADDRESS_NETBYTE;
    raw.set(pubSpend, 1);
    raw.set(pubView, 33);
    const hash = Keccak256.hash(raw.slice(0, 65));
    raw[65] = hash[0];
    raw[66] = hash[1];
    raw[67] = hash[2];
    raw[68] = hash[3];
    return MoneroEd25519.cnBase58Encode(raw);
  }

  /**
   * Generate a subaddress for the given account/index.
   *
   * @param {Object}     keys      - { privateViewKey, publicSpendKey } as Uint8Array(32)
   * @param {number}     major     - Account index (0 = primary account)
   * @param {number}     minor     - Subaddress index within the account
   * @returns {Object}   { major, minor, address, publicSpendKeyHex, publicViewKeyHex }
   */
  function generate(keys, major, minor) {
    if (major === 0 && minor === 0) {
      throw new Error('Index (0,0) is the primary address, not a subaddress');
    }
    const m  = subaddressSecret(keys.privateViewKey, major, minor);
    const mG = MoneroEd25519.scalarmultBase(m);
    const subSpend = MoneroEd25519.pointAdd(keys.publicSpendKey, mG);
    const subView  = MoneroEd25519.scalarmult(keys.privateViewKey, subSpend);
    const address  = encodeSubaddress(subSpend, subView);
    return {
      major,
      minor,
      address,
      publicSpendKey: subSpend,
      publicViewKey:  subView,
      publicSpendKeyHex: bytesToHex(subSpend),
      publicViewKeyHex:  bytesToHex(subView)
    };
  }

  function bytesToHex(b) {
    return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  }

  return { generate, subaddressSecret, encodeSubaddress };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroSubaddress;
