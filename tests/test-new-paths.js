/**
 * test-new-paths.js — sanity tests for the additions to the crypto engine.
 *
 * Run with:  node tests/test-new-paths.js
 *
 * Covers:
 *   • BIP-39 → SLIP-0010 ed25519 → Monero spend-key derivation
 *   • Polyseed decode (canonical phrase + 4-char-prefix variant)
 *   • Polyseed full key derivation (PBKDF2-SHA256)
 *   • Subaddress generation (correct netbyte, length, distinct from primary,
 *     deterministic across calls)
 *   • Round-trip: 25-word generate → derive → addresses match
 *   • WalletVault encrypt / decrypt / wrong-password rejection
 *
 * No external deps. Just node ≥ 16 (needs WebCrypto, BigInt, sessionStorage shim).
 */

'use strict';

// ── Minimal browser shims ────────────────────────────────────────────
if (!global.crypto) global.crypto = require('crypto').webcrypto;
const _store = new Map();
global.sessionStorage = {
  getItem:    k => _store.has(k) ? _store.get(k) : null,
  setItem:    (k, v) => _store.set(k, String(v)),
  removeItem: k => _store.delete(k),
  clear:      () => _store.clear(),
};
global.btoa = s => Buffer.from(s, 'binary').toString('base64');
global.atob = s => Buffer.from(s, 'base64').toString('binary');

// ── Engine modules (load order matches the HTML pages) ──────────────
global.Keccak256       = require('../js/keccak256.js');
global.MoneroEd25519   = require('../js/monero-ed25519.js');
global.MoneroWordList  = require('../js/monero-wordlist.js');
require('../js/monero-english-wordlist.js');
require('../js/monero-wordlists-all.js');
global.BIP39_WORDLIST  = require('../js/bip39-wordlist.js');
global.Bip39           = require('../js/bip39.js');
global.Polyseed        = require('../js/polyseed.js');
global.MoneroKeys      = require('../js/monero-keys.js');
global.MoneroSubaddress = require('../js/monero-subaddress.js');
global.WalletVault     = require('../js/wallet-vault.js');
// LwsClient relies on `localStorage` and a few browser globals; provide
// minimal shims so the require() doesn't blow up under Node.
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.location = { hostname: 'localhost' };
global.LwsClient = require('../js/lws-client.js');

// ── Tiny test harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok   ' + name); },
    e  => { fail++; console.log('  FAIL ' + name + '\n         ' + (e && e.message || e)); }
  );
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'assertEq failed') +
      '\n           expected: ' + expected +
      '\n           actual:   ' + actual);
  }
}

// ── Tests ───────────────────────────────────────────────────────────
(async () => {
  console.log('\n  monero-web — new code paths\n');

  // 25-word round-trip — sanity check the generate → derive loop is unbroken
  await test('25-word generate → re-derive matches', () => {
    const w = MoneroKeys.generateWallet('english', 'mainnet');
    const k = MoneroKeys.deriveFromMnemonic(w.mnemonic, 'english', 'mainnet');
    assertEq(k.address,            w.address,            'address');
    assertEq(k.privateSpendKeyHex, w.privateSpendKeyHex, 'spend key');
    assertEq(k.privateViewKeyHex,  w.privateViewKeyHex,  'view key');
  });

  // BIP-39
  await test('BIP-39 12 words → produces a valid mainnet address', async () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const k = await MoneroKeys.deriveFromBip39(m, '', 'mainnet');
    assertEq(k.address.length, 95, 'mainnet length');
    assertEq(k.address[0],     '4', 'mainnet prefix');
    assertEq(k.privateSpendKeyHex.length, 64);
    assertEq(k.privateViewKeyHex.length,  64);
    // Determinism: re-derive
    const k2 = await MoneroKeys.deriveFromBip39(m, '', 'mainnet');
    assertEq(k2.address, k.address, 'deterministic');
  });

  await test('BIP-39 passphrase changes the derived address', async () => {
    const m = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const a = await MoneroKeys.deriveFromBip39(m, '',     'mainnet');
    const b = await MoneroKeys.deriveFromBip39(m, 'salt', 'mainnet');
    assert(a.address !== b.address, 'passphrase should change output');
  });

  // Polyseed
  await test('Polyseed canonical phrase decodes', () => {
    const ps = 'raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language';
    const d  = Polyseed.decode(ps);
    assertEq(d.features, 0, 'features');
    assert(typeof d.birthday === 'number', 'birthday is number');
  });

  await test('Polyseed 4-char-prefix variant decodes identically', () => {
    const full   = 'raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language';
    const prefix = 'rave tail swea infa grie assi regu lamp duck vali some litt hars pupp airp lang';
    const a = Polyseed.decode(full);
    const b = Polyseed.decode(prefix);
    assertEq(b.birthday, a.birthday, 'birthday');
    assertEq(b.features, a.features, 'features');
    assertEq(Buffer.from(b.secret).toString('hex'),
             Buffer.from(a.secret).toString('hex'), 'secret');
  });

  await test('Polyseed bad checksum is rejected', () => {
    // Swap two words → checksum should fail
    const bad = 'raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy language airport';
    let threw = false;
    try { Polyseed.decode(bad); } catch (e) { threw = true; }
    assert(threw, 'bad checksum should throw');
  });

  await test('Polyseed → full Monero address derivation', async () => {
    const ps = 'raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language';
    const k  = await MoneroKeys.deriveFromPolyseed(ps, 'mainnet');
    assertEq(k.address.length, 95);
    assertEq(k.address[0],     '4');
    assertEq(k.seedFormat,     'polyseed');
    assertEq(k.wordCount,      16);
  });

  // Subaddresses
  await test('Subaddress (0,1) starts with 8 and differs from primary', () => {
    const w = MoneroKeys.generateWallet('english', 'mainnet');
    const sub = MoneroSubaddress.generate({
      privateViewKey: MoneroKeys.hexToBytes(w.privateViewKeyHex),
      publicSpendKey: MoneroKeys.hexToBytes(w.publicSpendKeyHex),
    }, 0, 1);
    assertEq(sub.address.length, 95);
    assertEq(sub.address[0],     '8', 'subaddress netbyte');
    assert(sub.address !== w.address, 'subaddress != primary');
  });

  await test('Subaddress generation is deterministic', () => {
    const w = MoneroKeys.generateWallet('english', 'mainnet');
    const k = {
      privateViewKey: MoneroKeys.hexToBytes(w.privateViewKeyHex),
      publicSpendKey: MoneroKeys.hexToBytes(w.publicSpendKeyHex),
    };
    const a = MoneroSubaddress.generate(k, 1, 7);
    const b = MoneroSubaddress.generate(k, 1, 7);
    assertEq(a.address, b.address, 'same index → same address');
    const c = MoneroSubaddress.generate(k, 1, 8);
    assert(a.address !== c.address, 'different minor → different address');
    const d = MoneroSubaddress.generate(k, 2, 7);
    assert(a.address !== d.address, 'different major → different address');
  });

  await test('Subaddress (0,0) is rejected as the primary address', () => {
    const w = MoneroKeys.generateWallet('english', 'mainnet');
    let threw = false;
    try {
      MoneroSubaddress.generate({
        privateViewKey: MoneroKeys.hexToBytes(w.privateViewKeyHex),
        publicSpendKey: MoneroKeys.hexToBytes(w.publicSpendKeyHex),
      }, 0, 0);
    } catch (e) { threw = true; }
    assert(threw, '(0,0) should throw');
  });

  // 13-language round-trip — guards against the wordlist regression we
  // had earlier where the all-languages JS file was malformed and only the
  // English wordlist actually loaded in the browser. If any of these break,
  // a real seed in that language can't be imported.
  const ALL_LANGUAGES = [
    'english',  'spanish',  'french',     'german',
    'italian',  'portuguese', 'russian', 'japanese',
    'chinese_simplified', 'dutch', 'esperanto', 'lojban', 'english_old',
  ];
  for (const lang of ALL_LANGUAGES) {
    await test(`25-word round-trip — ${lang}`, () => {
      assert(MoneroWordList.isLoaded(lang), `wordlist "${lang}" failed to load`);
      const w = MoneroKeys.generateWallet(lang, 'mainnet');
      assert(w.mnemonic.split(/\s+/).length === 25, '25 words expected');
      const k = MoneroKeys.deriveFromMnemonic(w.mnemonic, lang, 'mainnet');
      assertEq(k.address,            w.address,            'address');
      assertEq(k.privateSpendKeyHex, w.privateSpendKeyHex, 'spend key');
      assertEq(k.privateViewKeyHex,  w.privateViewKeyHex,  'view key');
    });
  }

  // Network selection
  await test('Stagenet derivation produces a 5… address', () => {
    const w = MoneroKeys.generateWallet('english', 'stagenet');
    assertEq(w.address[0], '5');
  });
  await test('Testnet derivation produces a 9… or A… address', () => {
    const w = MoneroKeys.generateWallet('english', 'testnet');
    assert(w.address[0] === '9' || w.address[0] === 'A',
      'testnet prefix was: ' + w.address[0]);
  });

  // WalletVault
  await test('WalletVault plaintext round-trip', async () => {
    sessionStorage.clear();
    const k = { address: 'demo', privateSpendKeyHex: 'aa', privateViewKeyHex: 'bb',
                publicSpendKeyHex: 'cc', publicViewKeyHex: 'dd' };
    await WalletVault.store(k, '');
    assert(WalletVault.hasBlob(),  'has blob');
    assert(!WalletVault.isLocked(), 'not locked');
    const out = WalletVault.readPlain();
    assertEq(out.address, 'demo');
  });

  await test('WalletVault encrypted round-trip', async () => {
    sessionStorage.clear();
    const k = { address: 'demo-enc', privateSpendKeyHex: '11', privateViewKeyHex: '22',
                publicSpendKeyHex: '33', publicViewKeyHex: '44' };
    await WalletVault.store(k, 'correct horse battery staple');
    assert(WalletVault.isLocked(), 'should be locked');
    assertEq(WalletVault.readPlain(), null, 'readPlain returns null when locked');
    const out = await WalletVault.unlock('correct horse battery staple');
    assertEq(out.address, 'demo-enc');
  });

  await test('WalletVault wrong password is rejected', async () => {
    sessionStorage.clear();
    const k = { address: 'x', privateSpendKeyHex: '0', privateViewKeyHex: '0',
                publicSpendKeyHex: '0', publicViewKeyHex: '0' };
    await WalletVault.store(k, 'right');
    let threw = false;
    try { await WalletVault.unlock('wrong'); } catch (e) { threw = true; }
    assert(threw, 'wrong password should throw');
  });

  // ── LwsClient (mock-mode behaviour) ────────────────────────────────
  await test('LwsClient.formatXmr — atomic units → human XMR', () => {
    assertEq(LwsClient.formatXmr('1000000000000'), '1');
    assertEq(LwsClient.formatXmr('1234567890000'), '1.23456789');
    assertEq(LwsClient.formatXmr('0'), '0');
    assertEq(LwsClient.formatXmr('1'), '0.000000000001');
  });

  await test('LwsClient.availableBalance — total - sent - locked', () => {
    const info = { total_received: '5000000000000', total_sent: '2000000000000', locked_funds: '500000000000' };
    assertEq(LwsClient.availableBalance(info).toString(), '2500000000000');
  });

  await test('LwsClient.availableBalance — never negative', () => {
    const info = { total_received: '0', total_sent: '1000', locked_funds: '0' };
    assertEq(LwsClient.availableBalance(info).toString(), '0');
  });

  await test('LwsClient.scanProgress — partway through', () => {
    const info = { start_height: 1000, scanned_block_height: 1500, blockchain_height: 2000 };
    assertEq(LwsClient.scanProgress(info), 0.5);
  });

  await test('LwsClient.scanProgress — fully synced', () => {
    const info = { start_height: 1000, scanned_block_height: 2000, blockchain_height: 2000 };
    assertEq(LwsClient.scanProgress(info), 1);
  });

  await test('LwsClient mock mode is on for localhost', () => {
    assert(LwsClient.isMock(), 'mock should auto-enable on localhost');
  });

  await test('LwsClient.login (mock) returns plausible response', async () => {
    const r = await LwsClient.login('4ABC', 'deadbeef', { generatedLocally: true });
    assert(typeof r.start_height === 'number', 'start_height present');
    assert(r.generated_locally === true, 'echoes generated_locally');
  });

  await test('LwsClient.getAddressInfo (mock) returns scanning state', async () => {
    const r = await LwsClient.getAddressInfo('4ABC', 'deadbeef');
    assert(r.blockchain_height > 0, 'blockchain_height set');
    assert(r.total_received !== undefined, 'total_received present');
    const avail = LwsClient.availableBalance(r);
    assert(avail > 0n, 'mock balance > 0');
  });

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail === 0 ? 0 : 1);
})();
