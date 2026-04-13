// SPDX-License-Identifier: MIT
/**
 * wallet-vault.js — encrypted sessionStorage for derived wallet keys
 *
 * Two storage modes:
 *   • Plaintext   — { encrypted: false, keys: {...} }
 *   • Encrypted   — { encrypted: true, salt, iv, ciphertext } where
 *                   ciphertext = AES-GCM(
 *                     key   = PBKDF2-SHA256(password, salt, 250000, 32 bytes),
 *                     iv    = 12 random bytes,
 *                     plain = JSON.stringify(keys)
 *                   )
 *
 * The vault never holds the password — only the user does. If the user
 * supplies an empty password we fall back to plaintext (the same threat
 * model as the original implementation).
 *
 * Stored keys object shape (matches what verify.html / dashboard.html
 * already use):
 *   {
 *     address, network,
 *     privateSpendKeyHex, privateViewKeyHex,
 *     publicSpendKeyHex,  publicViewKeyHex
 *   }
 */

const WalletVault = (function () {
  'use strict';

  const STORAGE_KEY = 'monero-web-wallet';
  const PBKDF2_ITERATIONS = 250000;

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(password, salt, iterations) {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password),
      { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Store wallet keys. If password is empty/falsy the keys are stored
   * in plaintext (encrypted:false). Otherwise they are AES-GCM encrypted.
   */
  async function store(keys, password) {
    // If this is a freshly-created wallet, set the sessionStorage flag
    // here so it's impossible to miss regardless of which UI button
    // triggers the store.
    if (keys && keys.createdAtCurrentTip) {
      try { sessionStorage.setItem('monero-web-fresh-wallet', '1'); } catch (e) {}
    }
    if (!password) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        encrypted: false,
        keys
      }));
      return;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const ct   = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(keys))
    ));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      encrypted:  true,
      version:    1,
      iterations: PBKDF2_ITERATIONS,
      salt:       b64(salt),
      iv:         b64(iv),
      ciphertext: b64(ct)
    }));
  }

  function readBlob() {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function hasBlob()    { return readBlob() !== null; }
  function isLocked()   { const b = readBlob(); return !!(b && b.encrypted); }

  /**
   * Read plaintext keys directly. Returns null if no blob, or if the
   * blob is encrypted (in which case the caller must call unlock()).
   */
  function readPlain() {
    const b = readBlob();
    if (!b || b.encrypted) return null;
    return b.keys;
  }

  /**
   * Decrypt an encrypted blob with the supplied password.
   * Throws on wrong password / corrupted ciphertext.
   */
  async function unlock(password) {
    const b = readBlob();
    if (!b || !b.encrypted) throw new Error('No encrypted vault to unlock');
    const salt       = unb64(b.salt);
    const iv         = unb64(b.iv);
    const ct         = unb64(b.ciphertext);
    const iterations = (typeof b.iterations === 'number') ? b.iterations : PBKDF2_ITERATIONS;
    const key        = await deriveKey(password, salt, iterations);
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    } catch (e) {
      throw new Error('Wrong password');
    }
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function clear() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  return { store, hasBlob, isLocked, readPlain, unlock, clear };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WalletVault;
