// SPDX-License-Identifier: MIT
/**
 * qr-scanner.js — Camera-based QR code scanner for Monero URIs
 *
 * Wraps the vendored jsQR decoder with a self-contained UI: opens a fullscreen
 * modal, requests camera permission, runs the rear camera (preferred) into a
 * <video> element, and on every animation frame snapshots the video to a
 * <canvas> and feeds the pixel data to jsQR. When a Monero URI is detected
 * (or any QR code is detected, if no URI filter is set), the configured
 * `onResult` callback fires once and the scanner stops.
 *
 * Public API:
 *
 *   QrScanner.open({
 *     onResult: function (parsed) { ... },
 *     onCancel: function () { ... },        // optional
 *     onError:  function (err)    { ... },  // optional
 *     filter:   'monero',                   // 'monero' (default) or 'any'
 *   })
 *
 * The `parsed` object passed to onResult has shape:
 *   {
 *     raw:        'monero:4ABC...?tx_amount=0.5&recipient_name=Alice',
 *     address:    '4ABC...',                // empty string for non-monero filter='any'
 *     amount:     '0.5',                    // string in XMR or null
 *     paymentId:  'abc...' or null,
 *     recipient:  'Alice' or null,
 *     description:'Coffee' or null,
 *   }
 *
 * Depends on the global `jsQR` from js/jsqr.js.
 */

const QrScanner = (function () {
  'use strict';

  let modal = null;
  let video = null;
  let canvas = null;
  let stream = null;
  let rafId = null;
  let active = false;
  let opts = null;

  function ensureModal () {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'qr-scanner-modal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(10,10,10,0.96);backdrop-filter:blur(8px);z-index:10000;align-items:center;justify-content:center;padding:20px;flex-direction:column';
    modal.innerHTML =
      '<div style="width:100%;max-width:420px;background:#111113;border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:22px;text-align:center">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
          '<h2 style="font-size:1rem;font-weight:600;color:#eae8e4;letter-spacing:-0.01em">Scan QR code</h2>' +
          '<button id="qr-scanner-close" style="background:transparent;border:0;color:#9a9894;font-size:1.4rem;cursor:pointer;line-height:1;padding:0 4px">✕</button>' +
        '</div>' +
        '<div style="position:relative;width:100%;aspect-ratio:1/1;background:#000;border-radius:10px;overflow:hidden;margin-bottom:12px">' +
          '<video id="qr-scanner-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;display:block"></video>' +
          '<div style="position:absolute;inset:14%;border:2px solid #ff6600;border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,0.35);pointer-events:none"></div>' +
        '</div>' +
        '<p id="qr-scanner-status" style="font-size:.74rem;color:#9a9894;line-height:1.5;margin-bottom:0">Point the camera at a Monero QR code</p>' +
      '</div>';
    document.body.appendChild(modal);

    canvas = document.createElement('canvas');
    video = modal.querySelector('#qr-scanner-video');

    modal.querySelector('#qr-scanner-close').addEventListener('click', () => {
      stop();
      if (opts && opts.onCancel) opts.onCancel();
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        stop();
        if (opts && opts.onCancel) opts.onCancel();
      }
    });
  }

  function setStatus (text, isError) {
    const el = modal && modal.querySelector('#qr-scanner-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#f87171' : '#9a9894';
  }

  /**
   * Parse a `monero:` URI into its parts.
   * Returns { raw, address, amount, paymentId, recipient, description }
   * or null if the input is not a Monero URI.
   */
  function parseMoneroUri (text) {
    if (!text || typeof text !== 'string') return null;
    if (!/^monero:/i.test(text)) return null;
    const without = text.replace(/^monero:/i, '');
    const qIdx = without.indexOf('?');
    const address = (qIdx >= 0 ? without.slice(0, qIdx) : without).trim();
    const params = {};
    if (qIdx >= 0) {
      without.slice(qIdx + 1).split('&').forEach(kv => {
        if (!kv) return;
        const eq = kv.indexOf('=');
        if (eq < 0) return;
        const k = decodeURIComponent(kv.slice(0, eq));
        const v = decodeURIComponent(kv.slice(eq + 1));
        params[k] = v;
      });
    }
    return {
      raw: text,
      address,
      amount:      params.tx_amount      || params.amount      || null,
      paymentId:   params.tx_payment_id  || params.payment_id  || null,
      recipient:   params.recipient_name || params.recipient   || null,
      description: params.tx_description || params.description || null,
    };
  }

  function tick () {
    if (!active) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (e) {
      // Cross-origin or zero-sized; skip this frame
      rafId = requestAnimationFrame(tick);
      return;
    }
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code && code.data) {
      const parsed = parseMoneroUri(code.data);
      if (opts.filter === 'any' || parsed) {
        const result = parsed || {
          raw: code.data,
          address: '', amount: null, paymentId: null, recipient: null, description: null,
        };
        const cb = opts.onResult;
        stop();
        if (cb) cb(result);
        return;
      }
      // Detected a non-Monero QR — keep scanning
      setStatus('Detected a non-Monero QR. Point at a monero: code.');
    }
    rafId = requestAnimationFrame(tick);
  }

  async function open (options) {
    opts = options || {};
    if (!opts.filter) opts.filter = 'monero';
    if (typeof jsQR !== 'function') {
      const err = new Error('jsQR library not loaded — include js/jsqr.js first');
      if (opts.onError) opts.onError(err);
      else throw err;
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Camera access not supported in this browser');
      if (opts.onError) opts.onError(err);
      else throw err;
      return;
    }
    ensureModal();
    modal.style.display = 'flex';
    setStatus('Requesting camera access…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
    } catch (e) {
      setStatus(e.message || 'Camera access denied', true);
      return;
    }
    video.srcObject = stream;
    setStatus('Point the camera at a Monero QR code');
    active = true;
    rafId = requestAnimationFrame(tick);
  }

  function stop () {
    active = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    if (modal) modal.style.display = 'none';
  }

  return { open, stop, parseMoneroUri };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QrScanner;
