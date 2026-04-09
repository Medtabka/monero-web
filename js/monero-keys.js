// SPDX-License-Identifier: MIT
/**
 * monero-keys.js
 * Monero Key Derivation Engine
 *
 * Converts seed bytes or mnemonic phrases into Monero wallet keys:
 *   - Private spend key (seed → sc_reduce32)
 *   - Private view key  (Keccak-256 of spend key → sc_reduce32)
 *   - Public spend key  (ed25519 basepoint × private spend key)
 *   - Public view key   (ed25519 basepoint × private view key)
 *   - Monero address    (base58 of netbyte + pub_spend + pub_view + checksum)
 *
 * Depends on: keccak256.js, monero-ed25519.js, monero-wordlist.js
 */

const MoneroKeys = (function () {
  'use strict';

  const MAINNET  = 0x12;  // '4...'
  const TESTNET  = 0x35;  // '9...' or 'A...'
  const STAGENET = 0x18;  // '5...'

  /**
   * Derive all keys from a raw 32-byte seed (private spend key material)
   * This is the core derivation — independent of mnemonic format.
   *
   * @param {Uint8Array} seedBytes - 32-byte seed
   * @param {string} network - 'mainnet'|'testnet'|'stagenet'
   * @returns {Object}
   */
  function deriveFromSeed(seedBytes, network) {
    network = network || 'mainnet';
    if (seedBytes.length !== 32) {
      throw new Error(`Seed must be 32 bytes, got ${seedBytes.length}`);
    }

    const privateSpendKey = MoneroEd25519.sc_reduce32(seedBytes);
    const privateViewKey  = MoneroEd25519.sc_reduce32(Keccak256.hash(privateSpendKey));
    const publicSpendKey  = MoneroEd25519.scalarmultBase(privateSpendKey);
    const publicViewKey   = MoneroEd25519.scalarmultBase(privateViewKey);

    let netByte;
    switch (network) {
      case 'testnet':  netByte = TESTNET; break;
      case 'stagenet': netByte = STAGENET; break;
      default:         netByte = MAINNET;
    }

    const address = encodeAddress(netByte, publicSpendKey, publicViewKey);

    return {
      network,
      privateSpendKey,
      privateViewKey,
      publicSpendKey,
      publicViewKey,
      address,
      privateSpendKeyHex: bytesToHex(privateSpendKey),
      privateViewKeyHex:  bytesToHex(privateViewKey),
      publicSpendKeyHex:  bytesToHex(publicSpendKey),
      publicViewKeyHex:   bytesToHex(publicViewKey)
    };
  }

  /**
   * Try every loaded wordlist and return the language whose checksum
   * verifies for the given mnemonic, or null if none does. Used to
   * auto-detect the language when the user doesn't pick one (or picks
   * the wrong one). For 25-word and 13-word seeds the checksum is
   * unique to the right wordlist, so this is reliable.
   */
  function detectLanguage(words) {
    if (!Array.isArray(words) || (words.length !== 25 && words.length !== 13)) {
      return null;
    }
    if (typeof MoneroWordList === 'undefined') return null;
    const candidates = [
      'english','spanish','french','german','italian','portuguese',
      'russian','japanese','chinese_simplified','dutch','esperanto',
      'lojban','english_old',
    ];
    for (const lang of candidates) {
      if (!MoneroWordList.isLoaded(lang)) continue;
      try {
        // Every word must be in the wordlist AND the checksum must verify.
        let allKnown = true;
        for (const w of words) {
          if (MoneroWordList.lookup(lang, w) < 0) { allKnown = false; break; }
        }
        if (!allKnown) continue;
        if (MoneroWordList.verifyChecksum(lang, words)) return lang;
      } catch (e) { /* try next language */ }
    }
    return null;
  }

  function deriveFromMnemonic(mnemonic, lang, network) {
    network = network || 'mainnet';

    const words = mnemonic.trim().toLowerCase().split(/\s+/);
    const count = words.length;

    // Auto-detect the language if possible. This protects users from picking
    // the wrong language in the dropdown and getting a confusing "invalid
    // checksum word" error when really the seed is in a different language.
    if ((count === 25 || count === 13)) {
      const detected = detectLanguage(words);
      if (detected) {
        lang = detected;
      } else if (!lang) {
        lang = 'english';
      }
    }
    lang = lang || 'english';

    if (!MoneroWordList.isLoaded(lang)) {
      throw new Error(
        `Word list for "${lang}" not loaded. ` +
        `Call MoneroWordList.register('${lang}', words, prefixLen) first.`
      );
    }
    let seed;

    if (count === 25) {
      // Standard Monero: 24 data + 1 checksum → 32-byte seed
      if (!MoneroWordList.verifyChecksum(lang, words)) {
        throw new Error(
          'Invalid mnemonic — checksum did not verify against any of the ' +
          '13 supported wordlists. Double-check that you copied every word ' +
          'correctly and that the order is right.'
        );
      }
      seed = MoneroWordList.decodeWords(lang, words.slice(0, 24));

    } else if (count === 13) {
      // MyMonero: 12 data + 1 checksum → 16-byte partial → Keccak → 32 bytes
      if (!MoneroWordList.verifyChecksum(lang, words)) {
        throw new Error(
          'Invalid mnemonic — checksum did not verify against any of the ' +
          '13 supported wordlists. Double-check that you copied every word ' +
          'correctly and that the order is right.'
        );
      }
      const partial = MoneroWordList.decodeWords(lang, words.slice(0, 12));
      seed = Keccak256.hash(partial);

    } else {
      throw new Error(
        `Unsupported word count for sync derivation: ${count}. ` +
        `12-word (BIP-39) and 16-word (Polyseed) seeds use async key ` +
        `derivation — call MoneroKeys.deriveFromAnyMnemonic() instead.`
      );
    }

    const result = deriveFromSeed(seed, network);
    result.wordCount = count;
    result.seedHex = bytesToHex(seed);
    return result;
  }

  /**
   * Derive keys from a hex-encoded private spend key
   * Useful when importing from another wallet via key string.
   */
  function deriveFromSpendKey(spendKeyHex, network, lang) {
    const seedBytes = hexToBytes(spendKeyHex);
    const result = deriveFromSeed(seedBytes, network);
    // The 25-word standard Monero mnemonic is a reversible encoding of the
    // 32-byte spend key, so we can reconstruct it whenever the supplied wordlist
    // is available. (This is NOT possible for BIP-39, MyMonero 13-word, or
    // polyseed seeds — those go through one-way KDFs.)
    try {
      const wlLang = lang || 'english';
      if (typeof MoneroWordList !== 'undefined' && MoneroWordList.isLoaded(wlLang)) {
        const reduced = MoneroEd25519.sc_reduce32(seedBytes);
        const dataWords = MoneroWordList.encodeBytes(wlLang, reduced);
        const fullWords = MoneroWordList.appendChecksum(wlLang, dataWords);
        result.mnemonic  = fullWords.join(' ');
        result.wordCount = 25;
      }
    } catch (e) { /* wordlist missing — leave result.mnemonic undefined */ }
    return result;
  }

  /**
   * Encode a standard Monero address
   */
  function encodeAddress(netByte, pubSpend, pubView) {
    const raw = new Uint8Array(69);
    raw[0] = netByte;
    raw.set(pubSpend, 1);
    raw.set(pubView, 33);
    const hash = Keccak256.hash(raw.slice(0, 65));
    raw[65] = hash[0];
    raw[66] = hash[1];
    raw[67] = hash[2];
    raw[68] = hash[3];
    return MoneroEd25519.cnBase58Encode(raw);
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    if (hex.length % 2 !== 0) throw new Error('Hex string must have even length');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  /**
   * Generate a brand new Monero wallet
   * Uses browser crypto.getRandomValues() for secure entropy
   *
   * @param {string} lang - Word list language (default: 'english')
   * @param {string} network - 'mainnet'|'testnet'|'stagenet'
   * @returns {Object} - Full wallet with mnemonic seed phrase
   */
  function generateWallet(lang, network) {
    lang = lang || 'english';
    network = network || 'mainnet';

    // Generate 32 random bytes
    const seedBytes = new Uint8Array(32);
    crypto.getRandomValues(seedBytes);

    // Reduce to valid scalar (ensures it's a valid spend key)
    const spendKey = MoneroEd25519.sc_reduce32(seedBytes);

    // Derive full wallet
    const keys = deriveFromSeed(spendKey, network);

    // Encode as 25-word mnemonic (24 data words + 1 checksum)
    const dataWords = MoneroWordList.encodeBytes(lang, spendKey);
    const fullWords = MoneroWordList.appendChecksum(lang, dataWords);

    keys.mnemonic = fullWords.join(' ');
    keys.wordCount = 25;
    keys.seedHex = bytesToHex(spendKey);

    return keys;
  }

  /**
   * Derive keys from a 12-word BIP-39 mnemonic.
   * Async because PBKDF2-SHA512 + HMAC-SHA512 run through SubtleCrypto.
   *
   * @param {string} mnemonic   - Space-separated BIP-39 words
   * @param {string} passphrase - Optional BIP-39 passphrase ("" by default)
   * @param {string} network    - 'mainnet'|'testnet'|'stagenet'
   */
  async function deriveFromBip39(mnemonic, passphrase, network) {
    if (typeof Bip39 === 'undefined') {
      throw new Error('Bip39 module not loaded — include js/bip39.js first');
    }
    const seed = await Bip39.deriveSpendSeed(mnemonic, passphrase || '');
    const result = deriveFromSeed(seed, network || 'mainnet');
    result.wordCount = mnemonic.trim().split(/\s+/).length;
    result.seedFormat = 'bip39';
    result.seedHex = bytesToHex(seed);
    return result;
  }

  /**
   * Derive keys from a 16-word Polyseed mnemonic.
   * Async because PBKDF2-SHA256 runs through SubtleCrypto.
   */
  async function deriveFromPolyseed(mnemonic, network) {
    if (typeof Polyseed === 'undefined') {
      throw new Error('Polyseed module not loaded — include js/polyseed.js first');
    }
    const ps = await Polyseed.deriveSeed(mnemonic);
    const result = deriveFromSeed(ps.seed, network || 'mainnet');
    result.wordCount = 16;
    result.seedFormat = 'polyseed';
    result.birthday = ps.birthday;
    result.features = ps.features;
    result.seedHex = bytesToHex(ps.seed);
    return result;
  }

  /**
   * Universal async dispatcher: picks the right derivation path from
   * the word count.
   *   12 → BIP-39  (uses Bip39 module + SubtleCrypto)
   *   13 → MyMonero legacy (sync, wrapped in a Promise)
   *   16 → Polyseed (uses Polyseed module + SubtleCrypto)
   *   25 → Standard Monero (sync, wrapped in a Promise)
   */
  async function deriveFromAnyMnemonic(mnemonic, lang, network, passphrase) {
    const count = mnemonic.trim().split(/\s+/).length;
    if (count === 12) return deriveFromBip39(mnemonic, passphrase, network);
    if (count === 16) return deriveFromPolyseed(mnemonic, network);
    return deriveFromMnemonic(mnemonic, lang, network);
  }

  return {
    deriveFromSeed,
    deriveFromMnemonic,
    deriveFromBip39,
    deriveFromPolyseed,
    deriveFromAnyMnemonic,
    deriveFromSpendKey,
    generateWallet,
    encodeAddress,
    bytesToHex,
    hexToBytes
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MoneroKeys;
