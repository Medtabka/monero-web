// SPDX-License-Identifier: MIT
// index-page.js — moved inline so the CSP can drop 'unsafe-inline'
    (function () {
      var addrEl  = document.getElementById('donate-addr');
      var copyBtn = document.getElementById('donate-copy');
      var toast   = document.getElementById('donate-toast');
      function copyAddr () {
        navigator.clipboard.writeText(addrEl.textContent.trim()).then(function () {
          toast.style.display = 'block';
          setTimeout(function () { toast.style.display = 'none'; }, 2000);
        });
      }
      addrEl.addEventListener('click', copyAddr);
      copyBtn.addEventListener('click', copyAddr);
    })();

    // If there's already an active wallet session in this tab, redirect every
    // "Open Wallet" CTA on the landing page straight to the dashboard. This
    // way clicking the moneroweb logo on /dashboard, then clicking "Open
    // Wallet", takes the user back to where they were instead of forcing them
    // to re-enter their seed.
    (function () {
      try {
        var raw = sessionStorage.getItem('monero-web-wallet');
        if (!raw) return;
        var blob = JSON.parse(raw);
        if (!blob) return;
        // Either an encrypted vault (will prompt unlock) or a plaintext one —
        // both should land on /dashboard, not /verify.
        document.querySelectorAll('a[href="/verify"]').forEach(function (a) {
          a.setAttribute('href', '/dashboard');
        });
      } catch (e) { /* no session — leave links pointing at /verify */ }
    })();
