// SPDX-License-Identifier: MIT
/**
 * monero-wordlist.js
 * Monero Mnemonic Word List Handler
 *
 * The actual word list (1626 words) must be loaded from the canonical
 * Monero source and registered via MoneroWordList.register().
 * 
 * Download the English list from:
 *   https://raw.githubusercontent.com/monero-project/monero/master/src/mnemonics/english.h
 *
 * This module provides:
 *   - Word list registration and lookup
 *   - Checksum verification  
 *   - 3-word-group → bytes decoding
 */

const MoneroWordList = (function () {
  'use strict';

  const lists = {};

  function register(lang, words, prefixLen, flags) {
    flags = flags || 0;
    const ALLOW_DUPLICATE_PREFIXES = 1;
    if (words.length !== 1626) {
      throw new Error(`Word list must have exactly 1626 entries, got ${words.length}`);
    }
    const map = {};
    for (let i = 0; i < words.length; i++) {
      const key = words[i].substring(0, prefixLen).toLowerCase();
      if (map[key] !== undefined && !(flags & ALLOW_DUPLICATE_PREFIXES)) {
        throw new Error(`Duplicate prefix "${key}" at index ${i}`);
      }
      if (map[key] === undefined) {
        map[key] = i;
      }
    }
    lists[lang] = { words, prefixLen, map };
  }

  function lookup(lang, word) {
    const list = lists[lang];
    if (!list) throw new Error(`Word list not loaded: ${lang}`);
    const prefix = word.toLowerCase().trim().substring(0, list.prefixLen);
    const idx = list.map[prefix];
    return idx !== undefined ? idx : -1;
  }

  function wordAt(lang, index) {
    const list = lists[lang];
    if (!list) throw new Error(`Word list not loaded: ${lang}`);
    return list.words[index];
  }

  function verifyChecksum(lang, words) {
    const list = lists[lang];
    if (!list) throw new Error(`Word list not loaded: ${lang}`);
    const dataWords = words.slice(0, words.length - 1);
    const checksumWord = words[words.length - 1];
    const prefixStr = dataWords.map(w =>
      w.toLowerCase().trim().substring(0, list.prefixLen)
    ).join('');
    const crc = crc32(prefixStr);
    const expectedIdx = ((crc >>> 0) % dataWords.length);
    return dataWords[expectedIdx].toLowerCase().trim() ===
           checksumWord.toLowerCase().trim();
  }

  function decodeWords(lang, dataWords) {
    const N = 1626;
    const indices = dataWords.map(w => {
      const idx = lookup(lang, w);
      if (idx < 0) throw new Error(`Unknown word: "${w}"`);
      return idx;
    });
    if (indices.length % 3 !== 0) {
      throw new Error(`Data word count must be divisible by 3, got ${indices.length}`);
    }
    const seed = new Uint8Array((indices.length / 3) * 4);
    for (let i = 0; i < indices.length; i += 3) {
      const w1 = indices[i], w2 = indices[i + 1], w3 = indices[i + 2];
      let val = w1 + N * ((w2 - w1 + N * 2) % N) + N * N * ((w3 - w2 + N * 2) % N);
      const off = (i / 3) * 4;
      seed[off] = val & 0xff;
      seed[off + 1] = (val >>> 8) & 0xff;
      seed[off + 2] = (val >>> 16) & 0xff;
      seed[off + 3] = (val >>> 24) & 0xff;
    }
    return seed;
  }

  function encodeBytes(lang, seedBytes) {
    const list = lists[lang];
    if (!list) throw new Error(`Word list not loaded: ${lang}`);
    const N = 1626;
    if (seedBytes.length % 4 !== 0) {
      throw new Error(`Seed byte length must be divisible by 4, got ${seedBytes.length}`);
    }
    const words = [];
    for (let i = 0; i < seedBytes.length; i += 4) {
      const val = (seedBytes[i] | (seedBytes[i+1] << 8) | (seedBytes[i+2] << 16) | ((seedBytes[i+3] << 24) >>> 0)) >>> 0;
      const w1 = val % N;
      const w2 = ((Math.floor(val / N) % N) + w1) % N;
      const w3 = ((Math.floor(val / (N * N)) % N) + w2) % N;
      words.push(list.words[w1], list.words[w2], list.words[w3]);
    }
    return words;
  }

  function appendChecksum(lang, dataWords) {
    const list = lists[lang];
    if (!list) throw new Error(`Word list not loaded: ${lang}`);
    const prefixStr = dataWords.map(w => w.substring(0, list.prefixLen)).join('');
    const checksumIdx = crc32(prefixStr) % dataWords.length;
    return [...dataWords, dataWords[checksumIdx]];
  }

  function isLoaded(lang) { return lang in lists; }

  function crc32(str) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xEDB88320 & (-(crc & 1)));
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  return { register, lookup, wordAt, verifyChecksum, decodeWords, encodeBytes, appendChecksum, isLoaded, crc32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroWordList;
