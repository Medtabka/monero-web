// SPDX-License-Identifier: MIT
/**
 * monero-ed25519.js
 * Ed25519 scalar and group operations for Monero key derivation
 *
 * Implements:
 *   - sc_reduce32: reduce a 32-byte scalar mod l (ed25519 group order)
 *   - scalarmult_base: multiply ed25519 basepoint by scalar → public key
 *   - Monero base58 encoding with 4-byte Keccak checksum
 *
 * The ed25519 group order:
 *   l = 2^252 + 27742317777372353535851937790883648493
 *
 * Field: GF(2^255 - 19)
 */

const MoneroEd25519 = (function () {
  'use strict';

  // ─── Big-number helpers (256-bit via Float64 limbs, 16 limbs × 16 bits) ───

  function gf(init) {
    const r = new Float64Array(16);
    if (init) for (let i = 0; i < init.length; i++) r[i] = init[i];
    return r;
  }

  const _0 = gf();
  const _1 = gf([1]);
  const _9 = gf([9]);

  // d = -121665/121666 mod p
  const D = gf([0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070,
                0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203]);
  // 2*d
  const D2 = gf([0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0,
                 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406]);
  // sqrt(-1)
  const I = gf([0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43,
                0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83]);

  // Ed25519 base point
  const X = gf([0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c,
                0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169]);
  const Y = gf([0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666,
                0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666]);

  function set25519(r, a) {
    for (let i = 0; i < 16; i++) r[i] = a[i] | 0;
  }

  function car25519(o) {
    let c;
    for (let i = 0; i < 16; i++) {
      o[i] += 65536;
      c = Math.floor(o[i] / 65536);
      o[(i + 1) % 16] += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0);
      o[i] -= c * 65536;
    }
  }

  function sel25519(p, q, b) {
    let c = ~(b - 1);
    for (let i = 0; i < 16; i++) {
      const t = c & (p[i] ^ q[i]);
      p[i] ^= t;
      q[i] ^= t;
    }
  }

  function pack25519(o, n) {
    let b;
    const m = gf(), t = gf();
    for (let i = 0; i < 16; i++) t[i] = n[i];
    car25519(t);
    car25519(t);
    car25519(t);
    for (let j = 0; j < 2; j++) {
      m[0] = t[0] - 0xffed;
      for (let i = 1; i < 15; i++) {
        m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
        m[i - 1] &= 0xffff;
      }
      m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
      b = (m[15] >> 16) & 1;
      m[14] &= 0xffff;
      sel25519(t, m, 1 - b);
    }
    for (let i = 0; i < 16; i++) {
      o[2 * i] = t[i] & 0xff;
      o[2 * i + 1] = t[i] >> 8;
    }
  }

  function neq25519(a, b) {
    const c = new Uint8Array(32), d = new Uint8Array(32);
    pack25519(c, a);
    pack25519(d, b);
    return !crypto_verify_32(c, d);
  }

  function crypto_verify_32(x, y) {
    let d = 0;
    for (let i = 0; i < 32; i++) d |= x[i] ^ y[i];
    return (1 & ((d - 1) >>> 8)) - 1 === 0;
  }

  function par25519(a) {
    const d = new Uint8Array(32);
    pack25519(d, a);
    return d[0] & 1;
  }

  function unpack25519(o, n) {
    for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  }

  function A(o, a, b) {
    for (let i = 0; i < 16; i++) o[i] = a[i] + b[i];
  }

  function Z(o, a, b) {
    for (let i = 0; i < 16; i++) o[i] = a[i] - b[i];
  }

  function M(o, a, b) {
    let i, j, t = new Float64Array(31);
    for (i = 0; i < 31; i++) t[i] = 0;
    for (i = 0; i < 16; i++) {
      for (j = 0; j < 16; j++) {
        t[i + j] += a[i] * b[j];
      }
    }
    for (i = 0; i < 15; i++) {
      t[i] += 38 * t[i + 16];
    }
    for (i = 0; i < 16; i++) o[i] = t[i];
    car25519(o);
    car25519(o);
  }

  function S(o, a) {
    M(o, a, a);
  }

  function inv25519(o, a) {
    const c = gf();
    for (let i = 0; i < 16; i++) c[i] = a[i];
    for (let i = 253; i >= 0; i--) {
      S(c, c);
      if (i !== 2 && i !== 4) M(c, c, a);
    }
    for (let i = 0; i < 16; i++) o[i] = c[i];
  }

  function pow2523(o, i) {
    const c = gf();
    for (let a = 0; a < 16; a++) c[a] = i[a];
    for (let a = 250; a >= 0; a--) {
      S(c, c);
      if (a !== 1) M(c, c, i);
    }
    for (let a = 0; a < 16; a++) o[a] = c[a];
  }

  // ─── Extended coordinates (X, Y, Z, T) for ed25519 group ops ───

  function cswap(p, q, b) {
    for (let i = 0; i < 4; i++) sel25519(p[i], q[i], b);
  }

  function pack(r, p) {
    const tx = gf(), ty = gf(), zi = gf();
    inv25519(zi, p[2]);
    M(tx, p[0], zi);
    M(ty, p[1], zi);
    pack25519(r, ty);
    r[31] ^= par25519(tx) << 7;
  }

  function add(p, q) {
    const a = gf(), b = gf(), c = gf(), d = gf(),
          e = gf(), f = gf(), g = gf(), h = gf(),
          t = gf();

    Z(a, p[1], p[0]);
    Z(t, q[1], q[0]);
    M(a, a, t);
    A(b, p[0], p[1]);
    A(t, q[0], q[1]);
    M(b, b, t);
    M(c, p[3], q[3]);
    M(c, c, D2);
    M(d, p[2], q[2]);
    A(d, d, d);
    Z(e, b, a);
    Z(f, d, c);
    A(g, d, c);
    A(h, b, a);

    M(p[0], e, f);
    M(p[1], h, g);
    M(p[2], g, f);
    M(p[3], e, h);
  }

  /**
   * Scalar multiplication: result = scalar * basepoint
   * Uses the TweetNaCl approach: process 4 bits at a time with a lookup table.
   * @param {Uint8Array} scalar - 32-byte scalar (clamped/reduced)
   * @returns {Uint8Array} 32-byte compressed point (public key)
   */
  function scalarmultBase(scalar) {
    // Use double-and-add from high bit to low bit
    // But use the unified add formula for doubling too (add point to itself)
    // This avoids needing a separate doubling implementation.

    const p = [gf(), gf(), gf(), gf()];  // accumulator
    const q = [gf(), gf(), gf(), gf()];  // base point

    // Base point in extended coordinates (X, Y, Z, T) where T = X*Y/Z
    set25519(q[0], X);
    set25519(q[1], Y);
    set25519(q[2], _1);
    M(q[3], X, Y);

    // p = identity = (0, 1, 1, 0)
    set25519(p[0], _0);
    set25519(p[1], _1);
    set25519(p[2], _1);
    set25519(p[3], _0);

    for (let i = 255; i >= 0; i--) {
      const b = (scalar[i >>> 3] >>> (i & 7)) & 1;

      // Double: p = p + p (using the unified addition formula)
      // We must copy p first since add() modifies p in-place
      const dp = [gf(), gf(), gf(), gf()];
      set25519(dp[0], p[0]);
      set25519(dp[1], p[1]);
      set25519(dp[2], p[2]);
      set25519(dp[3], p[3]);
      add(p, dp);  // p = 2*p

      if (b) {
        // Add base point: p = p + q
        const qc = [gf(), gf(), gf(), gf()];
        set25519(qc[0], q[0]);
        set25519(qc[1], q[1]);
        set25519(qc[2], q[2]);
        set25519(qc[3], q[3]);
        add(p, qc);  // p = p + G
      }
    }

    const result = new Uint8Array(32);
    pack(result, p);
    return result;
  }

  // ─── sc_reduce32: reduce a 32-byte scalar mod l ───
  // l = 2^252 + 27742317777372353535851937790883648493
  // l in little-endian bytes:
  // 0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
  // 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  // 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10

  /**
   * sc_reduce32: reduce a 32-byte value modulo the ed25519 group order l
   * This uses a schoolbook approach with 64-bit intermediate arithmetic via JS numbers
   */
  function sc_reduce32(s) {
    // We perform reduction of a 256-bit number mod l
    // l = 2^252 + 27742317777372353535851937790883648493
    //
    // Strategy: interpret s as a big integer, compute s mod l
    // For a 32-byte input (max 2^256 - 1), we need at most a few subtractions

    // Convert to array of limbs (28-bit)
    // Actually, let's do this more carefully with a proven algorithm
    // We'll work with the scalar as 64 "nybbles" (4-bit chunks) for precision

    // Simpler approach: use BigInt if available, fallback to manual
    if (typeof BigInt !== 'undefined') {
      return sc_reduce32_bigint(s);
    }

    // Manual fallback for environments without BigInt
    return sc_reduce32_manual(s);
  }

  function sc_reduce32_bigint(s) {
    let x = BigInt(0);
    for (let i = 31; i >= 0; i--) {
      x = (x << BigInt(8)) | BigInt(s[i]);
    }

    const l = BigInt("7237005577332262213973186563042994240857116359379907606001950938285454250989");
    x = x % l;

    const result = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      result[i] = Number(x & BigInt(0xff));
      x = x >> BigInt(8);
    }
    return result;
  }

  function sc_reduce32_manual(s) {
    // For older browsers: direct subtraction approach
    // Since input is at most 2^256-1 and l ≈ 2^252, we need at most 15 subtractions
    const result = new Uint8Array(32);
    for (let i = 0; i < 32; i++) result[i] = s[i];

    const l = new Uint8Array([
      0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
      0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10
    ]);

    // Compare and subtract
    function geq(a, b) {
      for (let i = 31; i >= 0; i--) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
      }
      return true; // equal
    }

    function sub(a, b) {
      let borrow = 0;
      for (let i = 0; i < 32; i++) {
        const diff = a[i] - b[i] - borrow;
        if (diff < 0) {
          a[i] = diff + 256;
          borrow = 1;
        } else {
          a[i] = diff;
          borrow = 0;
        }
      }
    }

    while (geq(result, l)) {
      sub(result, l);
    }

    return result;
  }

  // ─── Monero Base58 encoding ───

  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /**
   * Encode a block of bytes (up to 8) into base58
   * Monero uses a specific block-based base58 (not Bitcoin's)
   */
  function encodeBlock(data, buf, startIdx) {
    // Block sizes: input bytes → output base58 chars
    const blockSizes = [0, 2, 3, 5, 6, 7, 9, 10, 11];

    if (data.length > 8) throw new Error('Block too large');

    let num = BigInt(0);
    for (let i = 0; i < data.length; i++) {
      num = (num << BigInt(8)) | BigInt(data[i]);
    }

    const outSize = blockSizes[data.length];
    const chars = [];
    for (let i = 0; i < outSize; i++) {
      const rem = num % BigInt(58);
      num = num / BigInt(58);
      chars.unshift(BASE58_ALPHABET[Number(rem)]);
    }

    for (let i = 0; i < chars.length; i++) {
      buf[startIdx + i] = chars[i];
    }

    return outSize;
  }

  /**
   * Monero base58 encode (block-based, different from Bitcoin base58check)
   * @param {Uint8Array} data - Raw bytes to encode
   * @returns {string} Base58 encoded string
   */
  function cnBase58Encode(data) {
    const fullBlockCount = Math.floor(data.length / 8);
    const lastBlockSize = data.length % 8;
    const blockSizes = [0, 2, 3, 5, 6, 7, 9, 10, 11];

    const totalChars = fullBlockCount * 11 + (lastBlockSize > 0 ? blockSizes[lastBlockSize] : 0);
    const result = new Array(totalChars);

    let outIdx = 0;
    for (let i = 0; i < fullBlockCount; i++) {
      const block = data.slice(i * 8, (i + 1) * 8);
      outIdx += encodeBlock(block, result, outIdx);
    }

    if (lastBlockSize > 0) {
      const block = data.slice(fullBlockCount * 8);
      encodeBlock(block, result, outIdx);
    }

    return result.join('');
  }

  // ─── Point unpack / add / variable-base scalarmult ───
  // Used by subaddress derivation: D' = D + m·G,  C' = a·D'.
  //
  // unpack() inverts pack(): given a 32-byte compressed point (y + sign bit),
  // recover x by solving the curve equation, picking the root whose parity
  // matches the high bit of byte 31.

  function unpack(r, p) {
    const t = gf(), chk = gf(), num = gf(), den = gf(),
          den2 = gf(), den4 = gf(), den6 = gf();
    // Strip the sign bit before reading y — pack() ORs it into bit 7 of
    // byte 31, but the y coordinate itself only uses 255 bits.
    const py = new Uint8Array(p);
    py[31] &= 0x7f;
    set25519(r[2], _1);
    unpack25519(r[1], py);
    S(num, r[1]);
    M(den, num, D);
    Z(num, num, r[2]);
    A(den, r[2], den);

    S(den2, den);
    S(den4, den2);
    M(den6, den4, den2);
    M(t, den6, num);
    M(t, t, den);

    pow2523(t, t);
    M(t, t, num);
    M(t, t, den);
    M(t, t, den);
    M(r[0], t, den);

    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) M(r[0], r[0], I);

    S(chk, r[0]);
    M(chk, chk, den);
    if (neq25519(chk, num)) return -1;

    // Match parity: if x's lsb differs from the sign bit, negate x.
    if (par25519(r[0]) !== ((p[31] >> 7) & 1)) Z(r[0], _0, r[0]);

    M(r[3], r[0], r[1]);
    return 0;
  }

  function unpackPoint(packed) {
    const p = [gf(), gf(), gf(), gf()];
    if (unpack(p, packed) !== 0) throw new Error('Invalid ed25519 point');
    return p;
  }

  /**
   * Add two compressed ed25519 points and return the compressed sum.
   */
  function pointAdd(packedA, packedB) {
    const a = unpackPoint(packedA);
    const b = unpackPoint(packedB);
    add(a, b);
    const r = new Uint8Array(32);
    pack(r, a);
    return r;
  }

  /**
   * Variable-base scalar multiplication: result = scalar · point.
   * Uses the same double-and-add loop as scalarmultBase, but starts with
   * the supplied point instead of the basepoint.
   */
  function scalarmult(scalar, packedPoint) {
    const p = [gf(), gf(), gf(), gf()];
    const q = unpackPoint(packedPoint);

    set25519(p[0], _0);
    set25519(p[1], _1);
    set25519(p[2], _1);
    set25519(p[3], _0);

    for (let i = 255; i >= 0; i--) {
      const b = (scalar[i >>> 3] >>> (i & 7)) & 1;

      const dp = [gf(), gf(), gf(), gf()];
      set25519(dp[0], p[0]);
      set25519(dp[1], p[1]);
      set25519(dp[2], p[2]);
      set25519(dp[3], p[3]);
      add(p, dp);

      if (b) {
        const qc = [gf(), gf(), gf(), gf()];
        set25519(qc[0], q[0]);
        set25519(qc[1], q[1]);
        set25519(qc[2], q[2]);
        set25519(qc[3], q[3]);
        add(p, qc);
      }
    }

    const result = new Uint8Array(32);
    pack(result, p);
    return result;
  }

  return {
    sc_reduce32,
    scalarmultBase,
    scalarmult,
    pointAdd,
    cnBase58Encode
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MoneroEd25519;
}
