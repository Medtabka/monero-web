// SPDX-License-Identifier: MIT
/**
 * keccak256.js
 * Pure JavaScript implementation of Keccak-256 (NOT NIST SHA-3)
 * Monero uses the original Keccak submission, not the NIST-standardized SHA-3
 * which differs in padding (Keccak uses 0x01, SHA-3 uses 0x06)
 *
 * Reference: https://keccak.team/keccak_specs_summary.html
 */

const Keccak256 = (function () {
  'use strict';

  // Keccak-f[1600] round constants
  const RC = [
    [0x00000001, 0x00000000], [0x00008082, 0x00000000],
    [0x0000808a, 0x80000000], [0x80008000, 0x80000000],
    [0x0000808b, 0x00000000], [0x80000001, 0x00000000],
    [0x80008081, 0x80000000], [0x00008009, 0x80000000],
    [0x0000008a, 0x00000000], [0x00000088, 0x00000000],
    [0x80008009, 0x00000000], [0x8000000a, 0x00000000],
    [0x8000808b, 0x00000000], [0x0000008b, 0x80000000],
    [0x00008089, 0x80000000], [0x00008003, 0x80000000],
    [0x00008002, 0x80000000], [0x00000080, 0x80000000],
    [0x0000800a, 0x00000000], [0x8000000a, 0x80000000],
    [0x80008081, 0x80000000], [0x00008080, 0x80000000],
    [0x80000001, 0x00000000], [0x80008008, 0x80000000]
  ];

  // Rotation offsets for ρ step
  const ROTC = [
    1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14,
    27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44
  ];

  // Lane indices for π step
  const PILN = [
    10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4,
    15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1
  ];

  /**
   * Rotate a 64-bit value left by n bits (stored as two 32-bit ints [lo, hi])
   */
  function rotl64(lo, hi, n) {
    if (n >= 32) {
      n -= 32;
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    if (n === 0) return [lo, hi];
    return [
      (lo << n) | (hi >>> (32 - n)),
      (hi << n) | (lo >>> (32 - n))
    ];
  }

  /**
   * Keccak-f[1600] permutation on state (array of 50 uint32s = 25 lanes × 2)
   */
  function keccakf(state) {
    const bc = new Array(10); // 5 lanes × 2 ints
    let t0, t1, lo, hi;

    for (let round = 0; round < 24; round++) {
      // θ step
      for (let i = 0; i < 5; i++) {
        bc[i * 2] = state[i * 2] ^ state[i * 2 + 10] ^ state[i * 2 + 20] ^ state[i * 2 + 30] ^ state[i * 2 + 40];
        bc[i * 2 + 1] = state[i * 2 + 1] ^ state[i * 2 + 11] ^ state[i * 2 + 21] ^ state[i * 2 + 31] ^ state[i * 2 + 41];
      }
      for (let i = 0; i < 5; i++) {
        const r = rotl64(bc[((i + 1) % 5) * 2], bc[((i + 1) % 5) * 2 + 1], 1);
        t0 = bc[((i + 4) % 5) * 2] ^ r[0];
        t1 = bc[((i + 4) % 5) * 2 + 1] ^ r[1];
        for (let j = 0; j < 25; j += 5) {
          state[(j + i) * 2] ^= t0;
          state[(j + i) * 2 + 1] ^= t1;
        }
      }

      // ρ and π steps
      lo = state[1 * 2];
      hi = state[1 * 2 + 1];
      for (let i = 0; i < 24; i++) {
        const j = PILN[i];
        t0 = state[j * 2];
        t1 = state[j * 2 + 1];
        const r = rotl64(lo, hi, ROTC[i]);
        state[j * 2] = r[0];
        state[j * 2 + 1] = r[1];
        lo = t0;
        hi = t1;
      }

      // χ step
      for (let j = 0; j < 25; j += 5) {
        for (let i = 0; i < 5; i++) {
          bc[i * 2] = state[(j + i) * 2];
          bc[i * 2 + 1] = state[(j + i) * 2 + 1];
        }
        for (let i = 0; i < 5; i++) {
          state[(j + i) * 2] ^= (~bc[((i + 1) % 5) * 2]) & bc[((i + 2) % 5) * 2];
          state[(j + i) * 2 + 1] ^= (~bc[((i + 1) % 5) * 2 + 1]) & bc[((i + 2) % 5) * 2 + 1];
        }
      }

      // ι step
      state[0] ^= RC[round][0];
      state[1] ^= RC[round][1];
    }
  }

  /**
   * Keccak-256 hash
   * @param {Uint8Array} input - Data to hash
   * @returns {Uint8Array} 32-byte hash
   */
  function hash(input) {
    const rate = 136; // (1600 - 256*2) / 8 = 136 bytes for Keccak-256
    const state = new Uint32Array(50); // 25 lanes × 64 bits = 50 × 32 bits

    // Absorb phase
    let offset = 0;
    while (offset + rate <= input.length) {
      for (let i = 0; i < rate; i += 4) {
        const laneIdx = (i >> 2);
        state[laneIdx] ^= (
          input[offset + i] |
          (input[offset + i + 1] << 8) |
          (input[offset + i + 2] << 16) |
          (input[offset + i + 3] << 24)
        ) >>> 0;
      }
      keccakf(state);
      offset += rate;
    }

    // Padding - Keccak uses 0x01 (NOT SHA-3's 0x06)
    const remaining = input.length - offset;
    const padded = new Uint8Array(rate);
    for (let i = 0; i < remaining; i++) {
      padded[i] = input[offset + i];
    }
    padded[remaining] = 0x01; // Keccak padding (differs from SHA-3)
    padded[rate - 1] |= 0x80;

    for (let i = 0; i < rate; i += 4) {
      const laneIdx = (i >> 2);
      state[laneIdx] ^= (
        padded[i] |
        (padded[i + 1] << 8) |
        (padded[i + 2] << 16) |
        (padded[i + 3] << 24)
      ) >>> 0;
    }
    keccakf(state);

    // Squeeze phase - extract 32 bytes
    const output = new Uint8Array(32);
    for (let i = 0; i < 32; i += 4) {
      const lane = state[i >> 2];
      output[i] = lane & 0xff;
      output[i + 1] = (lane >> 8) & 0xff;
      output[i + 2] = (lane >> 16) & 0xff;
      output[i + 3] = (lane >> 24) & 0xff;
    }

    return output;
  }

  return { hash };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Keccak256;
}
