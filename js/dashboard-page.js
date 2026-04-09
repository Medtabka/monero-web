// SPDX-License-Identifier: MIT
// dashboard-page.js — moved inline so the CSP can drop 'unsafe-inline' for scripts
document.addEventListener('DOMContentLoaded', async () => {

  // ─── Wallet load (vault-aware) ───
  // The verify page hands us the keys via WalletVault, which may be plaintext
  // or AES-GCM encrypted with a session password. The unlock overlay handles
  // both initial unlock and re-unlock after idle auto-lock.
  let walletKeys = null;
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  let idleTimer = null;

  const overlay     = document.getElementById('unlock-overlay');
  const overlayMsg  = document.getElementById('unlock-msg');
  const overlayPw   = document.getElementById('unlock-pw');
  const overlayErr  = document.getElementById('unlock-error');
  const overlayBtn  = document.getElementById('unlock-btn');
  const overlayForget = document.getElementById('unlock-forget');

  function showUnlock(message) {
    overlayMsg.textContent = message;
    overlayErr.style.display = 'none';
    overlayPw.value = '';
    overlay.style.display = 'flex';
    setTimeout(() => overlayPw.focus(), 50);
  }
  function hideUnlock() {
    overlay.style.display = 'none';
    overlayPw.value = '';
  }

  overlayForget.addEventListener('click', () => {
    WalletVault.clear();
    walletKeys = null;
    window.location.href = '/verify';
  });

  overlayBtn.addEventListener('click', tryUnlock);
  overlayPw.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });

  async function tryUnlock() {
    overlayErr.style.display = 'none';
    overlayBtn.disabled = true;
    overlayBtn.textContent = 'Unlocking…';
    try {
      walletKeys = await WalletVault.unlock(overlayPw.value);
      hideUnlock();
      initDashboard();
    } catch (e) {
      overlayErr.textContent = e.message || 'Unlock failed';
      overlayErr.style.display = 'block';
    } finally {
      overlayBtn.disabled = false;
      overlayBtn.textContent = 'Unlock';
    }
  }

  // No vault at all → bounce to verify
  if (!WalletVault.hasBlob()) {
    document.getElementById('loading-state').innerHTML = `
      <div style="text-align:center">
        <svg width="48" height="48" fill="none" stroke="var(--text-dim)" stroke-width="1.5" viewBox="0 0 24 24" style="margin-bottom:12px;opacity:.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <p style="color:var(--text);font-size:.95rem;font-weight:500;margin-bottom:6px">No wallet connected</p>
        <p style="color:var(--text-dim);font-size:.8rem;margin-bottom:20px">Enter your seed phrase or private key to access your wallet</p>
        <a href="/verify" style="display:inline-block;padding:12px 28px;background:var(--xmr);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:.85rem;box-shadow:0 4px 24px rgba(255,102,0,0.2)">Open Wallet →</a>
      </div>
    `;
    return;
  }

  // Encrypted → prompt; plaintext → load directly
  if (WalletVault.isLocked()) {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('dashboard').style.display = 'none';
    showUnlock('Enter your session password to unlock this wallet.');
    return; // initDashboard() will run after successful unlock
  } else {
    walletKeys = WalletVault.readPlain();
    initDashboard();
    return;
  }

  // ─── Auto-lock plumbing ─────────────────────────────────────────────
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(autoLock, IDLE_TIMEOUT_MS);
  }
  function autoLock() {
    // Drop the in-memory keys and reload the page. For an encrypted vault
    // the ciphertext persists in sessionStorage across the reload, so the
    // user can re-enter their password without re-deriving from a seed.
    // For a plaintext vault we wipe and bounce to verify.
    walletKeys = null;
    if (WalletVault.isLocked()) {
      window.location.reload();
    } else {
      WalletVault.clear();
      window.location.href = '/verify';
    }
  }
  function installIdleListeners() {
    ['mousemove','keydown','click','touchstart','scroll'].forEach(ev => {
      document.addEventListener(ev, resetIdleTimer, { passive: true });
    });
    resetIdleTimer();
  }

  // ─── Dashboard initialiser ──────────────────────────────────────────
  function initDashboard() {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    populateWallet();
    installIdleListeners();
  }

  async function populateWallet() {

  const isWatchOnly = !!walletKeys.watchOnly;

  // ─── Populate wallet info ───
  document.getElementById('wallet-address').insertAdjacentText('afterbegin', walletKeys.address);
  document.getElementById('receive-addr').textContent = walletKeys.address;
  document.getElementById('key-spend').textContent = walletKeys.privateSpendKeyHex || '— not available (watch-only) —';
  document.getElementById('key-view').textContent = walletKeys.privateViewKeyHex;
  document.getElementById('key-pub-spend').textContent = walletKeys.publicSpendKeyHex || '— not available (watch-only) —';
  document.getElementById('key-pub-view').textContent = walletKeys.publicViewKeyHex;

  // ─── Wallet info badge (seed format + polyseed birthday) ───
  // Polyseed encodes a wallet creation timestamp ("birthday") in 10 bits as
  // 2-week buckets since 2021-11-01 UTC. Once balance scanning lands this is
  // what we'll use as the restore-from height. For now we just surface it
  // for the user.
  (function showWalletInfo () {
    const parts = [];
    if (walletKeys.seedFormat === 'polyseed' && typeof walletKeys.birthday === 'number') {
      const POLYSEED_EPOCH = Date.UTC(2021, 10, 1) / 1000; // 2021-11-01 UTC
      const TIME_STEP = 14 * 24 * 3600;                    // 2 weeks
      const ts = (POLYSEED_EPOCH + walletKeys.birthday * TIME_STEP) * 1000;
      const d = new Date(ts);
      const dateStr = d.toISOString().slice(0, 10);
      parts.push('Polyseed · birthday ~' + dateStr);
    } else if (walletKeys.seedFormat === 'bip39') {
      parts.push('BIP-39');
    }
    if (parts.length === 0) return;
    const info = document.createElement('div');
    info.style.cssText = 'display:inline-block;margin:6px 0;padding:4px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:100px;font-size:.68rem;color:var(--text-mid);font-family:"JetBrains Mono",monospace';
    info.textContent = parts.join(' · ');
    document.querySelector('.wallet-header').appendChild(info);
  })();

  // Watch-only: hide spend-key-dependent UI
  if (isWatchOnly) {
    const sendBtn = document.getElementById('btn-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.4'; sendBtn.title = 'Watch-only wallet'; }
    const subSection = document.getElementById('btn-sub-gen');
    if (subSection) subSection.closest('.keys-section').style.display = 'none';
    // Add a watch-only badge under the address
    const badge = document.createElement('div');
    badge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin:8px 0;padding:4px 12px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);border-radius:100px;font-size:.7rem;font-weight:600;color:#22c55e;text-transform:uppercase;letter-spacing:.06em';
    badge.innerHTML = '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg> Watch-only';
    document.querySelector('.wallet-header').appendChild(badge);
  }

  // ─── Subaddress generator (full-mode only) ───
  // Reconstruct the raw byte buffers we need from the hex strings stored in
  // sessionStorage. The dashboard never sees the seed phrase — only the keys.
  const subKeys = isWatchOnly ? null : {
    privateViewKey: MoneroKeys.hexToBytes(walletKeys.privateViewKeyHex),
    publicSpendKey: MoneroKeys.hexToBytes(walletKeys.publicSpendKeyHex)
  };
  // ─── Subaddress book (persistent metadata + on-demand address derivation) ──
  // We persist {major, minor, label, createdAt} per wallet in localStorage so
  // the user's labeled subaddress book survives across sessions. The actual
  // subaddress strings are NOT stored — they're recomputed from the keys
  // every render. localStorage only ever holds index pairs and labels.
  const subList   = document.getElementById('sub-list');
  const subError  = document.getElementById('sub-error');
  const subLabel  = document.getElementById('sub-label');
  const subMajor  = document.getElementById('sub-major');
  const subMinor  = document.getElementById('sub-minor');
  const subBookKey = 'monero-web-subaddrs-' + walletKeys.address.slice(0, 12);

  function loadSubBook () {
    try {
      const raw = localStorage.getItem(subBookKey);
      if (!raw) return [];
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function saveSubBook (list) {
    try { localStorage.setItem(subBookKey, JSON.stringify(list)); } catch (e) {}
  }
  function nextMinor (list, major) {
    const used = list.filter(e => e.major === major).map(e => e.minor);
    return used.length ? Math.max.apply(null, used) + 1 : 1;
  }
  function copyToClipboard (text, el) {
    navigator.clipboard.writeText(text).then(() => {
      if (el) {
        const old = el.textContent;
        el.textContent = 'Copied!';
        setTimeout(() => { el.textContent = old; }, 1200);
      }
    });
  }

  function renderSubBook () {
    const list = loadSubBook();
    subList.innerHTML = '';
    if (list.length === 0) {
      subList.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);text-align:center;padding:14px 0">No subaddresses yet.</div>';
    }
    // newest first
    list.slice().reverse().forEach((entry, displayIdx) => {
      const realIdx = list.length - 1 - displayIdx;
      let address = '— locked —';
      try {
        if (subKeys) address = MoneroSubaddress.generate(subKeys, entry.major, entry.minor).address;
      } catch (e) { address = '(error)'; }

      const row = document.createElement('div');
      row.style.cssText = 'margin-top:10px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px';
      row.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">' +
          '<div style="font-size:.78rem;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            (entry.label ? escapeHtml(entry.label) : '<span style="color:var(--text-dim);font-weight:400">unlabeled</span>') +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0">' +
            '<span style="font-family:\'JetBrains Mono\',monospace;font-size:.62rem;color:var(--text-dim);padding:2px 8px;background:var(--surface);border-radius:100px">' + entry.major + '/' + entry.minor + '</span>' +
            '<button class="sub-del" data-idx="' + realIdx + '" title="Delete" style="background:transparent;border:0;color:var(--text-dim);cursor:pointer;font-size:.85rem;padding:0 4px;line-height:1">✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="sub-addr" style="font-family:\'JetBrains Mono\',monospace;font-size:.62rem;color:var(--text-mid);word-break:break-all;line-height:1.5;cursor:pointer" title="Click to copy">' +
          escapeHtml(address) +
        '</div>';
      row.querySelector('.sub-addr').addEventListener('click', (e) => copyToClipboard(address, e.currentTarget));
      row.querySelector('.sub-del').addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        const updated = loadSubBook();
        updated.splice(idx, 1);
        saveSubBook(updated);
        renderSubBook();
        autoFillNextMinor();
      });
      subList.appendChild(row);
    });
  }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  function autoFillNextMinor () {
    const list = loadSubBook();
    const major = parseInt(subMajor.value, 10) || 0;
    subMinor.value = nextMinor(list, major);
  }
  subMajor.addEventListener('input', autoFillNextMinor);
  autoFillNextMinor();

  document.getElementById('btn-sub-gen').addEventListener('click', () => {
    subError.style.display = 'none';
    if (!subKeys) {
      subError.textContent = 'Watch-only wallets cannot generate subaddresses (the spend key is required).';
      subError.style.display = 'block';
      return;
    }
    try {
      const major = parseInt(subMajor.value, 10) || 0;
      const minor = parseInt(subMinor.value, 10) || 0;
      if (major === 0 && minor === 0) throw new Error('Index (0,0) is your primary address — cannot be a subaddress');
      // Validate by actually deriving
      MoneroSubaddress.generate(subKeys, major, minor);
      const list = loadSubBook();
      // Don't allow exact duplicates of (major, minor)
      if (list.some(e => e.major === major && e.minor === minor)) {
        throw new Error('That (account, index) is already in your address book.');
      }
      list.push({
        major,
        minor,
        label: (subLabel.value || '').trim(),
        createdAt: new Date().toISOString(),
      });
      saveSubBook(list);
      subLabel.value = '';
      renderSubBook();
      autoFillNextMinor();
    } catch (e) {
      subError.textContent = e.message;
      subError.style.display = 'block';
    }
  });

  renderSubBook();

  // ─── Copy address on click ───
  document.getElementById('wallet-address').addEventListener('click', () => {
    navigator.clipboard.writeText(walletKeys.address).then(() => {
      const toast = document.getElementById('addr-toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1500);
    });
  });

  // ─── Key visibility toggles ───
  ['spend', 'view'].forEach(type => {
    const toggle = document.getElementById('toggle-' + type);
    const value = document.getElementById('key-' + type);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = value.classList.toggle('hidden');
      toggle.textContent = hidden ? 'Show' : 'Hide';
    });
  });

  // ─── Connect to node ───
  const connDot = document.getElementById('conn-dot');
  const connInfo = document.getElementById('conn-info');

  MoneroRPC.onConnectionChange((state) => {
    connDot.className = 'conn-dot ' + state.status;
    if (state.status === 'connected') {
      connInfo.innerHTML = '<span>' + escapeHtml(state.node) + '</span> · <span class="conn-height">' + (state.height ? state.height.toLocaleString() : '—') + '</span>';
    } else if (state.status === 'connecting') {
      connInfo.textContent = state.message || 'Connecting…';
    } else {
      // Disconnected — surface a retry link inline so the user doesn't have
      // to reload the whole page to recover from a transient proxy outage.
      connInfo.innerHTML = '<span style="color:#f87171">' + escapeHtml(state.message || 'Disconnected') + '</span> · <a href="#" id="conn-retry" style="color:var(--xmr);text-decoration:underline;cursor:pointer">retry</a>';
      const r = document.getElementById('conn-retry');
      if (r) r.addEventListener('click', (e) => { e.preventDefault(); connectAndPopulate(); });
    }
  });

  // Wraps the network connect + populate flow so it can be called both on
  // initial load and from any in-page retry button without reloading.
  async function connectAndPopulate () {
    document.getElementById('loading-state').style.display = 'block';
    document.getElementById('loading-state').innerHTML =
      '<div class="spinner"></div><p>Connecting to Monero network…</p>';
    try {
      const node = await MoneroRPC.connect();

      document.getElementById('loading-state').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';

      document.getElementById('net-node').textContent     = node.name;
      document.getElementById('net-height').textContent   = node.height ? node.height.toLocaleString() : '—';
      document.getElementById('net-latency').textContent  = node.latency + 'ms';
      document.getElementById('net-pool').textContent     = node.txPoolSize || '0';

      try {
        const fee = await MoneroRPC.getFeeEstimate();
        document.getElementById('net-fee').textContent = MoneroRPC.formatXMR(fee.feePerByte) + ' XMR/byte';
      } catch (e) {
        document.getElementById('net-fee').textContent = 'unavailable';
      }

      document.getElementById('balance-xmr').textContent = '—';
      document.getElementById('balance-note').textContent =
        'Balance scanning requires a light-wallet server (coming soon)';
    } catch (e) {
      // Build a structured error block with two recovery options.
      const ls = document.getElementById('loading-state');
      ls.style.display = 'block';
      ls.innerHTML =
        '<div style="text-align:center;max-width:380px;margin:0 auto">' +
          '<svg width="40" height="40" fill="none" stroke="#f87171" stroke-width="1.5" viewBox="0 0 24 24" style="margin:0 auto 14px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
          '<p style="color:#f87171;font-size:.92rem;font-weight:600;margin-bottom:6px">Could not reach a Monero node</p>' +
          '<p style="color:var(--text-dim);font-size:.78rem;line-height:1.55;margin-bottom:4px">' + escapeHtml(e.message) + '</p>' +
          '<p style="color:var(--text-dim);font-size:.72rem;line-height:1.55;margin-bottom:18px">This usually means the proxy is rate-limited, the upstream nodes are temporarily down, or your network is blocking the request. Your wallet keys are unaffected.</p>' +
          '<button id="err-retry" class="action-btn" style="padding:10px 22px;font-size:.82rem;width:auto;display:inline-flex;margin-right:8px">Retry</button>' +
          '<button id="err-disconnect" class="action-btn" style="padding:10px 22px;font-size:.82rem;width:auto;display:inline-flex;background:transparent">Disconnect</button>' +
        '</div>';
      document.getElementById('err-retry').addEventListener('click', () => connectAndPopulate());
      document.getElementById('err-disconnect').addEventListener('click', () => {
        WalletVault.clear();
        window.location.href = '/';
      });
    }
  }

  await connectAndPopulate();

  // ─── RECEIVE MODAL ───
  document.getElementById('btn-receive').addEventListener('click', () => {
    document.getElementById('receive-modal').classList.add('show');
    // Generate QR code as SVG using a simple QR library inline
    generateQR(walletKeys.address);
  });

  document.getElementById('receive-close').addEventListener('click', () => {
    document.getElementById('receive-modal').classList.remove('show');
  });

  document.getElementById('receive-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(walletKeys.address).then(() => {
      const btn = document.getElementById('receive-copy');
      btn.textContent = 'Copied!';
      btn.style.borderColor = 'rgba(34,197,94,0.3)';
      btn.style.color = '#4ade80';
      setTimeout(() => { btn.textContent = 'Copy Address'; btn.style.borderColor = ''; btn.style.color = ''; }, 2000);
    });
  });

  // Close modal on backdrop click
  document.getElementById('receive-modal').addEventListener('click', (e) => {
    if (e.target.id === 'receive-modal') e.target.classList.remove('show');
  });

  // ─── SEND MODAL ───
  document.getElementById('btn-send').addEventListener('click', () => {
    document.getElementById('send-modal').classList.add('show');
  });

  document.getElementById('send-close').addEventListener('click', () => {
    document.getElementById('send-modal').classList.remove('show');
  });

  document.getElementById('send-modal').addEventListener('click', (e) => {
    if (e.target.id === 'send-modal') e.target.classList.remove('show');
  });

  // ─── QR CODE GENERATOR (simple version using canvas→dataURL) ───
  function generateQR(text) {
    // Render the QR code locally with the vendored qrcodegen.js encoder.
    // Nothing about the user's address ever leaves the browser — no third
    // party (qrserver, googleapis, etc.) is contacted.
    const qrContainer = document.getElementById('qr-code');
    try {
      // typeNumber=0 → auto-pick the smallest version that fits, EC level "M"
      const qr = qrcode(0, 'M');
      qr.addData('monero:' + text);
      qr.make();
      const count = qr.getModuleCount();
      const size  = 220;       // pixel size of the rendered SVG
      const quiet = 2;         // quiet-zone modules around the code
      const total = count + quiet * 2;
      const cell  = size / total;

      let rects = '';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            rects += '<rect x="' + ((c + quiet) * cell).toFixed(2) +
                     '" y="' + ((r + quiet) * cell).toFixed(2) +
                     '" width="' + cell.toFixed(2) +
                     '" height="' + cell.toFixed(2) + '" fill="#eae8e4"/>';
          }
        }
      }
      qrContainer.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size +
        '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" ' +
        'style="background:#111113;border-radius:12px">' + rects + '</svg>';
    } catch (e) {
      qrContainer.innerHTML = '<div style="color:#f87171;font-size:.75rem;padding:20px">QR error: ' + e.message + '</div>';
    }
  }

  // ─── Disconnect ───
  document.getElementById('btn-disconnect').addEventListener('click', () => {
    WalletVault.clear();
    MoneroRPC.disconnect();
    window.location.href = '/';
  });

  // ─── Custom node settings ───
  const customNodeInput = document.getElementById('custom-node');
  const nodeMsg = document.getElementById('node-msg');
  customNodeInput.value = MoneroRPC.getCustomNode();
  if (customNodeInput.value) {
    nodeMsg.textContent = 'Using custom node — proxy bypassed.';
  }
  document.getElementById('btn-node-save').addEventListener('click', () => {
    const v = customNodeInput.value.trim();
    if (v && !/^https?:\/\//.test(v)) {
      nodeMsg.textContent = 'URL must start with http:// or https://';
      nodeMsg.style.color = '#f87171';
      return;
    }
    MoneroRPC.setCustomNode(v);
    nodeMsg.style.color = 'var(--success)';
    nodeMsg.textContent = v ? 'Saved. Reload to reconnect.' : 'Cleared.';
  });
  document.getElementById('btn-node-clear').addEventListener('click', () => {
    MoneroRPC.setCustomNode('');
    customNodeInput.value = '';
    nodeMsg.style.color = 'var(--text-dim)';
    nodeMsg.textContent = 'Reverted to monero-web proxy. Reload to reconnect.';
  });

  // ─── QR scanner ───
  document.getElementById('btn-scan-qr').addEventListener('click', () => {
    const resultEl = document.getElementById('scan-result');
    resultEl.style.display = 'none';
    QrScanner.open({
      onResult: (parsed) => {
        const lines = [];
        if (parsed.address)     lines.push('<div><span style="color:var(--text-dim)">addr:</span> ' + escapeHtml(parsed.address) + '</div>');
        if (parsed.amount)      lines.push('<div><span style="color:var(--text-dim)">amount:</span> ' + escapeHtml(parsed.amount) + ' XMR</div>');
        if (parsed.recipient)   lines.push('<div><span style="color:var(--text-dim)">recipient:</span> ' + escapeHtml(parsed.recipient) + '</div>');
        if (parsed.description) lines.push('<div><span style="color:var(--text-dim)">memo:</span> ' + escapeHtml(parsed.description) + '</div>');
        if (parsed.paymentId)   lines.push('<div><span style="color:var(--text-dim)">payment id:</span> ' + escapeHtml(parsed.paymentId) + '</div>');
        if (lines.length === 0) lines.push('<div style="color:var(--text-dim)">' + escapeHtml(parsed.raw) + '</div>');
        lines.push('<button id="scan-copy" class="action-btn" style="margin-top:10px;padding:6px 12px;font-size:.7rem;width:auto">Copy address</button>');
        resultEl.innerHTML = lines.join('');
        resultEl.style.display = 'block';
        const copyBtn = document.getElementById('scan-copy');
        if (copyBtn && parsed.address) {
          copyBtn.addEventListener('click', () => copyToClipboard(parsed.address, copyBtn));
        }
      },
      onError: (err) => {
        alert('Scanner error: ' + err.message);
      },
    });
  });

  // ─── Export wallet (JSON) ───
  document.getElementById('btn-export').addEventListener('click', () => {
    const dump = {
      format: 'monero-web-wallet-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      network: walletKeys.network || 'mainnet',
      watchOnly: !!walletKeys.watchOnly,
      address: walletKeys.address,
      privateSpendKeyHex: walletKeys.privateSpendKeyHex || null,
      privateViewKeyHex:  walletKeys.privateViewKeyHex,
      publicSpendKeyHex:  walletKeys.publicSpendKeyHex || null,
      publicViewKeyHex:   walletKeys.publicViewKeyHex,
    };
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'monero-web-' + walletKeys.address.slice(0, 8) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ─── Auto-refresh height every 30s ───
  setInterval(async () => {
    try {
      const height = await MoneroRPC.getHeight();
      document.getElementById('net-height').textContent = height.toLocaleString();
      connInfo.innerHTML = `<span>${MoneroRPC.getConnectionState().node}</span> · <span class="conn-height">${height.toLocaleString()}</span>`;
    } catch(e) {}
  }, 30000);
  } // end populateWallet
});
