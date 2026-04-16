// SPDX-License-Identifier: MIT
// swap-popup.js — Trocador exchange widget in a modal overlay.
// Any element with class "swap-popup-trigger" opens the popup on click.

(function () {
  var WIDGET_URL = 'https://trocador.app/en/widget/?ref=JgOuC4teDM';

  var styles = [
    '.swap-popup-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.75);',
      '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);',
      'display:none;align-items:center;justify-content:center;z-index:9999;padding:20px}',
    '.swap-popup-backdrop.open{display:flex}',
    '.swap-popup-modal{background:#111113;border:1px solid rgba(255,255,255,0.06);',
      'border-radius:12px;width:100%;max-width:400px;height:min(600px,88vh);',
      'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.6)}',
    '.swap-popup-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.06);background:#19191d}',
    '.swap-popup-title{font-size:.82rem;font-weight:600;letter-spacing:-0.01em;color:#eae8e4;',
      "font-family:'Outfit',system-ui,sans-serif}",
    '.swap-popup-title span{color:#6e6c6a;font-weight:400;font-size:.72rem;margin-left:4px}',
    '.swap-popup-close{background:transparent;border:none;color:#6e6c6a;font-size:1.3rem;',
      'line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px;',
      'transition:background .15s,color .15s}',
    '.swap-popup-close:hover{background:#111113;color:#eae8e4}',
    '.swap-popup-body{flex:1;position:relative;background:#111113}',
    '.swap-popup-body iframe{width:100%;height:100%;border:none;display:block}',
    '.swap-popup-loading{position:absolute;inset:0;background:#111113;display:flex;',
      'align-items:center;justify-content:center;color:#6e6c6a;font-size:.85rem;',
      "z-index:1;transition:opacity .3s;font-family:'Outfit',system-ui,sans-serif}",
    '.swap-popup-loading.hidden{opacity:0;pointer-events:none}'
  ].join('');

  var html = [
    '<div class="swap-popup-backdrop" id="swap-popup-backdrop">',
      '<div class="swap-popup-modal" role="dialog" aria-modal="true" aria-labelledby="swap-popup-title">',
        '<div class="swap-popup-head">',
          '<div class="swap-popup-title" id="swap-popup-title">Exchange <span>&middot; via trocador.app</span></div>',
          '<button class="swap-popup-close" id="swap-popup-close" aria-label="Close">&times;</button>',
        '</div>',
        '<div class="swap-popup-body">',
          '<div class="swap-popup-loading" id="swap-popup-loading">Loading Trocador&hellip;</div>',
          '<iframe id="swap-popup-frame" title="Trocador exchange widget" loading="lazy"></iframe>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');

  function init() {
    var styleEl = document.createElement('style');
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);

    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);

    var backdrop = document.getElementById('swap-popup-backdrop');
    var closeBtn = document.getElementById('swap-popup-close');
    var frame    = document.getElementById('swap-popup-frame');
    var loading  = document.getElementById('swap-popup-loading');

    function open() {
      if (!frame.src) frame.src = WIDGET_URL;
      backdrop.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    function close() {
      backdrop.classList.remove('open');
      document.body.style.overflow = '';
    }

    document.querySelectorAll('.swap-popup-trigger').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        open();
      });
    });

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && backdrop.classList.contains('open')) close();
    });
    frame.addEventListener('load', function () {
      loading.classList.add('hidden');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
