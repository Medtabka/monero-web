// SPDX-License-Identifier: MIT
// verify-page.js — moved inline so the CSP can drop 'unsafe-inline' for scripts
document.addEventListener('DOMContentLoaded', () => {
  // Defensive helpers — return safe defaults if a referenced element is
  // missing. Stops "cannot read property 'value' of null" errors when a
  // user is running a stale cached version of this script against a
  // newer HTML (or vice versa) where one side knows about an element
  // the other doesn't.
  const $val = (id) => {
    const el = document.getElementById(id);
    return (el && typeof el.value === 'string') ? el.value : '';
  };
  const $el = (id) => document.getElementById(id);

  // If there's already a wallet session in this tab, surface a banner that
  // jumps the user straight to the dashboard instead of forcing them to
  // re-enter their seed. They can still derive a different wallet from this
  // page if they want.
  (function showActiveSessionBanner () {
    if (!WalletVault.hasBlob()) return;
    const banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:10px;padding:14px 16px;margin-bottom:18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    banner.innerHTML =
      '<svg width="18" height="18" fill="none" stroke="#22c55e" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>' +
      '<span style="flex:1;font-size:.82rem;color:var(--text)">An active wallet session is loaded in this tab.</span>' +
      '<a href="/dashboard" style="flex-shrink:0;background:#22c55e;color:#fff;text-decoration:none;font-size:.78rem;font-weight:600;padding:8px 16px;border-radius:8px">Continue →</a>';
    const card = document.querySelector('.card');
    if (card) card.insertBefore(banner, card.firstChild);
  })();

  const formats = {
    12: { name:'BIP-39',          cls:'mymonero', icon:'◇' },
    13: { name:'MyMonero Legacy', cls:'mymonero', icon:'◈' },
    16: { name:'Polyseed',        cls:'mymonero', icon:'◉' },
    25: { name:'Monero Standard', cls:'standard', icon:'◆' },
  };

  // ─── Advanced: custom Monero node URL ───
  // Reads and writes the same localStorage key that js/monero-rpc.js uses,
  // so whatever the user sets here on the verify page is automatically
  // picked up by the dashboard's MoneroRPC calls. Letting users configure
  // this BEFORE deriving keys means the view key can go straight to their
  // own node on the first LWS /login call — it never touches our default.
  const NODE_KEY = 'monero-web-node-url';
  const advInput = $el('adv-node-url');
  const advMsg   = $el('adv-node-msg');
  const advSave  = $el('adv-node-save');
  const advReset = $el('adv-node-reset');
  if (advInput) {
    try { advInput.value = localStorage.getItem(NODE_KEY) || ''; } catch (e) {}
    if (advMsg && advInput.value) {
      advMsg.textContent = 'Using your custom node.';
      advMsg.style.color = 'var(--success)';
    }
    if (advSave) advSave.addEventListener('click', () => {
      const v = (advInput.value || '').trim();
      if (v && !/^https?:\/\//.test(v)) {
        advMsg.textContent = 'URL must start with http:// or https://';
        advMsg.style.color = '#f87171';
        return;
      }
      try {
        if (v) localStorage.setItem(NODE_KEY, v.replace(/\/$/, ''));
        else   localStorage.removeItem(NODE_KEY);
        advMsg.textContent = v ? 'Saved. Your wallet will use this node.' : 'Cleared. Using monero-web proxy.';
        advMsg.style.color = v ? 'var(--success)' : 'var(--text-dim)';
      } catch (e) {
        advMsg.textContent = 'Could not save: ' + e.message;
        advMsg.style.color = '#f87171';
      }
    });
    if (advReset) advReset.addEventListener('click', () => {
      try { localStorage.removeItem(NODE_KEY); } catch (e) {}
      advInput.value = '';
      advMsg.textContent = 'Reverted to monero-web proxy (default).';
      advMsg.style.color = 'var(--text-dim)';
    });
  }

  // ─── TABS ───
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.form-section').forEach(f => f.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      document.getElementById('results').classList.remove('show');
      document.getElementById('error-msg').classList.remove('show');
    });
  });

  // ─── SEED INPUT ───
  const seedInput = document.getElementById('seed-input');
  const wcNum = document.getElementById('wc-num');
  const wordCounter = document.getElementById('word-counter');
  const seedFormat = document.getElementById('seed-format');
  const btnSeed = document.getElementById('btn-derive-seed');

  seedInput.addEventListener('input', () => {
    const words = seedInput.value.trim().split(/\s+/).filter(w => w.length > 0);
    const count = words.length;
    wcNum.textContent = count;
    wordCounter.classList.remove('valid');
    seedFormat.style.display = 'none';
    seedFormat.className = 'seed-format-badge';
    btnSeed.disabled = true;

    const fmt = formats[count];
    if (fmt) {
      wordCounter.classList.add('valid');
      btnSeed.disabled = false;
      seedFormat.style.display = 'inline-block';
      seedFormat.classList.add(fmt.cls);
      seedFormat.textContent = fmt.icon + ' ' + fmt.name;
    }
    // BIP-39 passphrase row only shown for 12-word seeds
    document.getElementById('bip39-pass-group').style.display =
      (count === 12) ? 'block' : 'none';
  });

  // ─── WALLET AGE BUTTONS → restore height ───
  // Each button computes an approximate block height based on how old the
  // wallet is. Monero blocks are ~2 min apart → 720/day → ~5,040/week.
  //
  // We use a known checkpoint to estimate the current tip accurately,
  // then subtract blocks for the chosen time period. Computing from
  // genesis forward is inaccurate because Monero's average block time
  // over 12 years drifts from the target 120s.
  const CHECKPOINT_HEIGHT = 3651000;
  const CHECKPOINT_TS = Date.UTC(2026, 3, 13) / 1000; // April 13, 2026
  const SECS_PER_BLOCK = 120;
  const BLOCKS_PER_DAY = 720;

  function estimatedCurrentHeight() {
    var secsSinceCheckpoint = Date.now() / 1000 - CHECKPOINT_TS;
    return Math.max(CHECKPOINT_HEIGHT, CHECKPOINT_HEIGHT + Math.floor(secsSinceCheckpoint / SECS_PER_BLOCK));
  }

  function ageToHeight(age) {
    var tip = estimatedCurrentHeight();
    switch (age) {
      case 'week':    return Math.max(0, tip - 7 * BLOCKS_PER_DAY);
      case 'month':   return Math.max(0, tip - 30 * BLOCKS_PER_DAY);
      case '3months': return Math.max(0, tip - 91 * BLOCKS_PER_DAY);
      case '6months': return Math.max(0, tip - 182 * BLOCKS_PER_DAY);
      case 'year':    return Math.max(0, tip - 365 * BLOCKS_PER_DAY);
      case '2years':  return Math.max(0, tip - 730 * BLOCKS_PER_DAY);
      case 'unknown': return 0;
      default:        return 0;
    }
  }

  var restoreHeightEl = $el('restore-height');
  var selectedLabel = $el('restore-height-selected');

  document.querySelectorAll('.wallet-age-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      // Remove active state from all buttons
      document.querySelectorAll('.wallet-age-btn').forEach(function(b) {
        b.style.background = 'var(--surface)';
        b.style.borderColor = 'var(--border)';
        b.style.color = b.dataset.age === 'unknown' ? 'var(--text-dim)' : 'var(--text)';
      });
      // Highlight the clicked button
      btn.style.background = 'var(--xmr-dim)';
      btn.style.borderColor = 'rgba(255,102,0,0.4)';
      btn.style.color = 'var(--xmr)';

      var age = btn.dataset.age;
      var height = ageToHeight(age);
      if (restoreHeightEl) restoreHeightEl.value = String(height);
      if (selectedLabel) {
        if (age === 'unknown') {
          selectedLabel.textContent = 'Will scan from genesis — finds everything, may take 1-3 hours for old wallets';
          selectedLabel.style.color = 'var(--text-dim)';
        } else {
          selectedLabel.textContent = 'Restore point set to ~block ' + height.toLocaleString() + ' — full scan required to find historical transactions';
          selectedLabel.style.color = 'var(--success)';
        }
        selectedLabel.style.display = 'block';
      }
    });
  });

  // Auto-hide the wallet-age section for polyseed (birthday is embedded)
  // and show it for all other formats. Also hide for BIP-39 passphrase row.
  seedInput.addEventListener('input', function() {
    var words = seedInput.value.trim().split(/\s+/).filter(function(w) { return w.length > 0; });
    var count = words.length;
    var rhGroup = $el('restore-height-group');
    if (rhGroup) {
      // Polyseed (16 words) has an embedded birthday — no need to ask.
      // For 12/13/25/other, show the age picker.
      rhGroup.style.display = (count === 16) ? 'none' : 'block';
    }
  });

  // ─── SPEND KEY INPUT ───
  const spendKeyInput = document.getElementById('spend-key-input');
  const btnKey = document.getElementById('btn-derive-key');

  spendKeyInput.addEventListener('input', () => {
    btnKey.disabled = !/^[0-9a-fA-F]{64}$/.test(spendKeyInput.value.trim());
  });

  // ─── WATCH-ONLY INPUT ───
  const watchAddr = document.getElementById('watch-addr');
  const watchView = document.getElementById('watch-view');
  const btnWatch  = document.getElementById('btn-derive-watch');
  function refreshWatchBtn() {
    const addrOk = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(watchAddr.value.trim());
    const viewOk = /^[0-9a-fA-F]{64}$/.test(watchView.value.trim());
    btnWatch.disabled = !(addrOk && viewOk);
  }
  watchAddr.addEventListener('input', refreshWatchBtn);
  watchView.addEventListener('input', refreshWatchBtn);

  btnWatch.addEventListener('click', () => {
    const errorEl = document.getElementById('error-msg');
    const resultsEl = document.getElementById('results');
    errorEl.classList.remove('show');
    resultsEl.classList.remove('show');
    btnWatch.disabled = true;
    btnWatch.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Loading...';

    setTimeout(() => {
      try {
        const addr     = (watchAddr && watchAddr.value || '').trim();
        const viewHex  = (watchView && watchView.value || '').trim().toLowerCase();
        // Derive the public view key from the supplied private view key so the
        // dashboard can still verify itself locally. We do NOT have the public
        // spend key here (would require base58 address decoding), so the
        // watch-only blob omits it — the dashboard hides spend-key-dependent
        // features (subaddress generator, send) when this is the case.
        const viewBytes = MoneroKeys.hexToBytes(viewHex);
        const reduced   = MoneroEd25519.sc_reduce32(viewBytes);
        const pubView   = MoneroEd25519.scalarmultBase(reduced);
        const keys = {
          address:            addr,
          network:            $val('network-select') || 'mainnet',
          privateSpendKeyHex: '',
          privateViewKeyHex:  MoneroKeys.bytesToHex(reduced),
          publicSpendKeyHex:  '',
          publicViewKeyHex:   MoneroKeys.bytesToHex(pubView),
          watchOnly:          true
        };
        showResults(keys);
      } catch (e) {
        errorEl.textContent = 'Error: ' + e.message;
        errorEl.classList.add('show');
      }
      btnWatch.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg> Open Watch-Only Wallet';
      refreshWatchBtn();
    }, 60);
  });

  // ─── DERIVE FROM SEED ───
  btnSeed.addEventListener('click', () => {
    const errorEl = document.getElementById('error-msg');
    const resultsEl = document.getElementById('results');
    errorEl.classList.remove('show');
    resultsEl.classList.remove('show');

    btnSeed.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Deriving...';
    btnSeed.disabled = true;

    setTimeout(async () => {
      try {
        const mnemonic = (seedInput && seedInput.value || '').trim();
        // Language is auto-detected by MoneroKeys.detectLanguage(); we pass
        // null so the engine picks whichever wordlist actually matches.
        const network    = $val('network-select') || 'mainnet';
        const passphrase = $val('bip39-pass');
        const keys = await MoneroKeys.deriveFromAnyMnemonic(mnemonic, null, network, passphrase);
        // Attach the user-supplied restore height (if any) so the dashboard
        // can pass it to the LWS to avoid scanning from genesis.
        const rhVal = $val('restore-height').replace(/[^0-9]/g, '');
        if (rhVal.length > 0) {
          keys.restoreHeight = parseInt(rhVal, 10);
        }
        showResults(keys);
      } catch(e) {
        errorEl.textContent = 'Error: ' + e.message;
        errorEl.classList.add('show');
      }
      btnSeed.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Derive Keys';
      btnSeed.disabled = false;
    }, 100);
  });

  // ─── DERIVE FROM KEY ───
  btnKey.addEventListener('click', () => {
    const errorEl = document.getElementById('error-msg');
    const resultsEl = document.getElementById('results');
    errorEl.classList.remove('show');
    resultsEl.classList.remove('show');

    btnKey.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Deriving...';
    btnKey.disabled = true;

    setTimeout(() => {
      try {
        const network = $val('network-select') || 'mainnet';
        const spendHex = (spendKeyInput && spendKeyInput.value || '').trim().toLowerCase();
        const keys = MoneroKeys.deriveFromSpendKey(spendHex, network);
        showResults(keys);
      } catch(e) {
        errorEl.textContent = 'Error: ' + e.message;
        errorEl.classList.add('show');
      }
      btnKey.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Derive Keys';
      btnKey.disabled = false;
    }, 100);
  });

  // ─── SHOW RESULTS ───
  function showResults(keys) {
    // Reveal the recovered mnemonic card only when we have one (spend-key
    // import paths attach it; BIP-39 / polyseed / MyMonero don't because
    // those formats are one-way and can't be reconstructed from the keys)
    const mnemCard = document.getElementById('res-mnemonic-card');
    if (keys.mnemonic && keys.wordCount === 25) {
      document.getElementById('res-mnemonic').textContent = keys.mnemonic;
      mnemCard.style.display = 'block';
    } else {
      mnemCard.style.display = 'none';
    }
    document.getElementById('res-address').textContent = keys.address;
    document.getElementById('res-spend').textContent = keys.privateSpendKeyHex;
    document.getElementById('res-view').textContent = keys.privateViewKeyHex;
    document.getElementById('res-pub-spend').textContent = keys.publicSpendKeyHex;
    document.getElementById('res-pub-view').textContent = keys.publicViewKeyHex;

    const formatEl = document.getElementById('result-format');
    if (keys.wordCount) {
      const fmt = formats[keys.wordCount];
      formatEl.textContent = (fmt ? fmt.icon + ' ' : '') + 'Derived via ' + (fmt ? fmt.name : keys.wordCount + '-word seed');
    } else {
      formatEl.textContent = '◆ Derived from private spend key';
    }

    // Store keys for Open Wallet button
    window._derivedKeys = keys;

    // Show or create the Open Wallet block (password input + button)
    let openBlock = document.getElementById('open-block');
    if (!openBlock) {
      openBlock = document.createElement('div');
      openBlock.id = 'open-block';
      openBlock.style.marginTop = '16px';
      openBlock.innerHTML =
        '<label style="display:block;font-size:.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">' +
        'Session password <span style="text-transform:none;letter-spacing:0;color:var(--text-dim)">(optional · encrypts in-tab storage)</span></label>' +
        '<input id="session-pw" type="password" autocomplete="new-password" placeholder="Leave empty for no encryption" ' +
        'style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:var(--text);outline:none;margin-bottom:10px">' +
        '<button id="btn-open-wallet" class="btn-primary" style="background:#22c55e;box-shadow:0 4px 24px rgba(34,197,94,0.2)">' +
        '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Open Wallet Dashboard</button>';
      document.getElementById('results').appendChild(openBlock);
      document.getElementById('btn-open-wallet').addEventListener('click', async () => {
        if (!window._derivedKeys) return;
        const k = window._derivedKeys;
        const pw = $val('session-pw');
        var vaultData = {
          address: k.address,
          network: k.network,
          privateSpendKeyHex: k.privateSpendKeyHex,
          privateViewKeyHex:  k.privateViewKeyHex,
          publicSpendKeyHex:  k.publicSpendKeyHex,
          publicViewKeyHex:   k.publicViewKeyHex,
          watchOnly:          !!k.watchOnly,
          seedFormat:         k.seedFormat || null,
          birthday:           (typeof k.birthday === 'number') ? k.birthday : null,
          restoreHeight:      (typeof k.restoreHeight === 'number') ? k.restoreHeight : null,
        };
        // Preserve the freshly-created flag if set (from Generate New flow)
        if (k.createdAtCurrentTip) {
          vaultData.createdAtCurrentTip = true;
          try { sessionStorage.setItem('monero-web-fresh-wallet', '1'); } catch (e) {}
        }
        await WalletVault.store(vaultData, pw);
        window.location.href = '/dashboard';
      });
    }

    document.getElementById('results').classList.add('show');
    document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── COPY BUTTONS ───
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      navigator.clipboard.writeText(target.textContent).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  // ─── CREATE NEW WALLET ───
  const btnCreate = document.getElementById('btn-create');
  if (btnCreate) {
    btnCreate.addEventListener('click', () => {
      btnCreate.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Generating...';
      btnCreate.disabled = true;

      setTimeout(() => {
        try {
          const wallet = MoneroKeys.generateWallet(
            $val('create-lang') || 'english',
            $val('network-select') || 'mainnet'
          );

          document.getElementById('create-mnemonic').textContent = wallet.mnemonic;
          document.getElementById('create-address').textContent = wallet.address;
          document.getElementById('create-spend').textContent = wallet.privateSpendKeyHex;
          document.getElementById('create-view').textContent = wallet.privateViewKeyHex;
          document.getElementById('create-result').style.display = 'block';

          // Store for Open Wallet button — mark as freshly created so
          // the dashboard skips historical scanning regardless of which
          // "Open Wallet" button the user clicks.
          wallet.createdAtCurrentTip = true;
          window._derivedKeys = wallet;

          // Add Open Wallet block (password + button) if not exists
          let openBlock = document.getElementById('open-block-create');
          if (!openBlock) {
            openBlock = document.createElement('div');
            openBlock.id = 'open-block-create';
            openBlock.style.marginTop = '12px';
            openBlock.innerHTML =
              '<label style="display:block;font-size:.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">' +
              'Session password <span style="text-transform:none;letter-spacing:0;color:var(--text-dim)">(optional · encrypts in-tab storage)</span></label>' +
              '<input id="session-pw-create" type="password" autocomplete="new-password" placeholder="Leave empty for no encryption" ' +
              'style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;font-family:\'JetBrains Mono\',monospace;font-size:.78rem;color:var(--text);outline:none;margin-bottom:10px">' +
              '<button id="btn-open-wallet-create" class="btn-primary" style="background:var(--xmr)">' +
              '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Open Wallet Dashboard</button>';
            document.getElementById('create-result').appendChild(openBlock);
            document.getElementById('btn-open-wallet-create').addEventListener('click', async () => {
              if (!window._derivedKeys) return;
              const k = window._derivedKeys;
              const pw = $val('session-pw-create');
              await WalletVault.store({
                address: k.address,
                network: k.network,
                privateSpendKeyHex: k.privateSpendKeyHex,
                privateViewKeyHex:  k.privateViewKeyHex,
                publicSpendKeyHex:  k.publicSpendKeyHex,
                publicViewKeyHex:   k.publicViewKeyHex,
                seedFormat:         k.seedFormat || null,
                birthday:           (typeof k.birthday === 'number') ? k.birthday : null,
                createdAtCurrentTip: true,
              }, pw);
              // Signal the dashboard that this is a freshly-created wallet
              // so it skips historical scanning. Two signals for redundancy:
              // vault has createdAtCurrentTip=true, sessionStorage has this flag.
              try { sessionStorage.setItem('monero-web-fresh-wallet', '1'); } catch (e) {}
              // Pre-register the wallet on the LWS with generated_locally=true
              // BEFORE redirecting to the dashboard. This ensures the LWS
              // creates the account starting from the current chain tip (no
              // historical scan needed). The dashboard will see the account
              // already exists and is "up to date" immediately.
              try {
                await LwsClient.login(k.address, k.privateViewKeyHex, { generatedLocally: true });
              } catch (e) {
                console.warn('[verify] pre-register on LWS failed (non-fatal):', e);
              }
              window.location.href = '/dashboard';
            });
          }

          // Re-bind copy buttons for new elements
          document.querySelectorAll('#create-result .copy-btn').forEach(btn => {
            btn.onclick = () => {
              const target = document.getElementById(btn.dataset.target);
              navigator.clipboard.writeText(target.textContent).then(() => {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
              });
            };
          });

        } catch(e) {
          document.getElementById('error-msg').textContent = 'Error: ' + e.message;
          document.getElementById('error-msg').classList.add('show');
        }
        btnCreate.innerHTML = '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg> Generate New Wallet';
        btnCreate.disabled = false;
      }, 100);
    });
  }
});
