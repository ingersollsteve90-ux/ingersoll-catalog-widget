/* ==========================================================================
   Ingersoll Catalog Tour + "Back to diagram" link
   --------------------------------------------------------------------------
   Loaded site-wide in Duda's Body End HTML, AFTER ingersoll-widget.js:
     <script src="https://cdn.jsdelivr.net/gh/ingersollsteve90-ux/
       ingersoll-catalog-widget@COMMIT/ingersoll-tour.js"></script>

   Self-contained: injects its own CSS, never modifies ingersoll-widget.js
   behaviour. If this file fails to load, catalogs work exactly as before.

   What it does
   ------------
   1. Catalog pages: adds a "? How to use" button to each catalog header.
      Two tour modes:
        - WATCH:   an animated pointer demonstrates every feature on the
                   real, live catalog (no audio needed).
        - SHOW ME: step-by-step coach marks; the customer does each click.
      First-time visitors get a small one-time offer card (bottom-right).
   2. Every page: remembers the last catalog section the visitor used and,
      on product pages / cart / anywhere else, shows a
      "← Back to diagram" pill that returns them to that exact section
      and re-highlights the part they were ordering.
   3. Sends GA4 events (if gtag is present): catalog_tour_start,
      catalog_tour_step, catalog_tour_complete, catalog_tour_exit,
      catalog_back_link_click.

   Tunables: set window.IngersollTourConfig = {...} BEFORE this script.
   ========================================================================== */
(function () {
  'use strict';
  if (window.IngersollTour) return;

  var CFG = Object.assign({
    offerFirstVisit: true,          // one-time "take a tour?" card on catalog pages
    offerDelayMs: 1500,
    backLinkEnabled: true,
    backLinkMaxAgeMs: 3 * 60 * 60 * 1000,  // pill shows for 3h after last catalog use
    backLinkPosition: 'right',      // 'left' or 'right' (bottom corner)
    zBase: 2147483000
  }, window.IngersollTourConfig || {});

  var K_SEEN = 'ingersollTourOffered_v1';
  var K_BACK = 'ingersollBackLink_v1';
  var K_HINT = 'ingersollTourBackHint_v1';
  var K_RESUME = 'ingersollTourResume_v1'; // Watch demo continuing across page loads
  var RESUME_TTL_MS = 3 * 60 * 1000;

  /* ---------------- small utilities ---------------- */
  function lsGet(k) { try { var r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var isTouch = window.matchMedia && window.matchMedia('(hover: none)').matches;
  function isNarrow() { return window.innerWidth < 640; }
  function track(name, params) {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch (e) {}
  }
  function visible(e) {
    if (!e || !e.isConnected) return false;
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
  }

  /* ---------------- widget lookups (book mode + legacy pasted) ---------------- */
  function widget() {
    var all = document.querySelectorAll('.ingersoll-catalog-widget');
    for (var i = 0; i < all.length; i++) if (all[i].querySelector('.diagram-wrap') && visible(all[i])) return all[i];
    return null;
  }
  function q(sel) { var w = widget(); return w ? w.querySelector(sel) : null; }
  function navArrow() {
    var w = widget(); if (!w) return null;
    var c = w.querySelectorAll('.book-nav-next,.book-nav-prev,.section-nav-next,.section-nav-prev');
    for (var i = 0; i < c.length; i++) if (c[i].textContent.trim() && visible(c[i])) return c[i];
    return null;
  }
  function navBar() { return q('.book-nav-bar') || q('.section-nav-bar:not([style*="none"])'); }
  function toggleBtn() {
    var w = widget(); if (!w) return null;
    var c = w.querySelectorAll('.book-nav-toggle,.section-nav-toggle');
    for (var i = 0; i < c.length; i++) if (visible(c[i])) return c[i];
    return null;
  }
  function fixedLayer(z) {
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var s = kids[i].style;
      if (s.position === 'fixed' && s.zIndex === String(z) && s.display === 'block') return kids[i];
    }
    return null;
  }
  function openDropdown() { return fixedLayer(99997); }
  function closeDropdown() { var b = fixedLayer(99996); if (b) b.click(); }
  function sectionTitle(w) { var s = w && w.querySelector('.section-bar span'); return s ? s.textContent.trim() : ''; }
  function catalogLabel(w) {
    var h = w && w.querySelector('header h1'); if (!h) return '';
    var t = ''; h.childNodes.forEach(function (n) { if (n.nodeType === 3) t += n.textContent; });
    return t.trim();
  }
  // Prefer an in-stock part with an Add to Cart button, a little way down the list.
  function demoRows() {
    var w = widget(); if (!w) return [];
    var rows = [].slice.call(w.querySelectorAll('.parts-row')).filter(function (r) { return r.querySelector('.add-btn'); });
    if (!rows.length) rows = [].slice.call(w.querySelectorAll('.parts-row'));
    return rows;
  }
  function dotFor(ref) { var w = widget(); return w ? w.querySelector('.hotspot[data-hs-ref="' + ref + '"]') : null; }

  /* ---------------- styles ---------------- */
  var Z = CFG.zBase;
  var css = [
    /* "How to use" button: brand red #FD0100, centered in the catalog header on
       desktop (absolute so it never shifts the logo/title/breadcrumb), inline on
       the right on narrower screens where there's no room in the middle. */
    '.ingersoll-catalog-widget header{position:relative}',
    '.ing-tour-launch{margin-left:14px;flex:0 0 auto;background:#FD0100;border:2px solid #FD0100;color:#fff;border-radius:24px;padding:8px 20px 8px 10px;font:700 15px/1 "Droid Serif",Georgia,serif;letter-spacing:.02em;cursor:pointer;display:inline-flex;align-items:center;gap:9px;white-space:nowrap;box-shadow:0 3px 12px rgba(253,1,0,.45);transition:background .15s,transform .15s,box-shadow .15s;animation:ingLaunchPulse 1.6s ease-in-out 1s 3}',
    '.ing-tour-launch:hover{background:#d10000;border-color:#fff;transform:translateY(-1px);box-shadow:0 5px 16px rgba(253,1,0,.6)}',
    '.ing-tour-launch b{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#fff;color:#FD0100;font:700 16px Georgia,serif}',
    '@keyframes ingLaunchPulse{0%,100%{box-shadow:0 3px 12px rgba(253,1,0,.45),0 0 0 0 rgba(253,1,0,.6)}50%{box-shadow:0 3px 12px rgba(253,1,0,.45),0 0 0 10px rgba(253,1,0,0)}}',
    '@media(min-width:900px){.ing-tour-launch{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0}.ing-tour-launch:hover{transform:translate(-50%,calc(-50% - 1px))}}',
    '.ing-tour-launch .l-short{display:none}',
    '@media(max-width:640px){.ing-tour-launch .l-long{display:none}.ing-tour-launch .l-short{display:inline}}',
    '@media(max-width:640px){.ing-tour-launch{padding:6px 12px 6px 6px;font-size:13px;gap:6px}.ing-tour-launch b{width:20px;height:20px;font-size:13px}}',
    '.ing-tour-layer{position:fixed;inset:0;z-index:' + Z + ';pointer-events:none}',
    '.ing-tour-blocker{position:fixed;inset:0;pointer-events:auto;background:transparent}',
    '.ing-tour-card.nudge{animation:ingNudge .45s ease}',
    '@keyframes ingNudge{20%,60%{margin-left:-8px}40%,80%{margin-left:8px}}',
    '.ing-tour-ring{position:fixed;border:3px solid #FFD700;border-radius:8px;transition:left .35s ease,top .35s ease,width .35s ease,height .35s ease,opacity .2s;box-shadow:0 0 0 4px rgba(200,34,26,.55);animation:ingTourPulse 1.4s ease-in-out infinite;opacity:0}',
    '.ing-tour-ring.dim{box-shadow:0 0 0 4px rgba(200,34,26,.55),0 0 0 9999px rgba(0,0,0,.42)}',
    '@keyframes ingTourPulse{0%,100%{outline:0 solid rgba(255,215,0,.6);outline-offset:0}50%{outline:6px solid rgba(255,215,0,0);outline-offset:6px}}',
    '.ing-tour-cursor{position:fixed;left:0;top:0;width:26px;height:26px;margin:-2px 0 0 -3px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));transition:transform .12s}',
    '.ing-tour-cursor.touch{width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(255,255,255,.55);border:3px solid #C8221A;filter:none}',
    '.ing-tour-cursor.press{transform:scale(.82)}',
    '.ing-tour-ripple{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #C8221A;animation:ingTourRipple .6s ease-out forwards}',
    '@keyframes ingTourRipple{to{transform:scale(3.4);opacity:0}}',
    '.ing-tour-card{position:fixed;width:330px;max-width:calc(100vw - 24px);background:#fff;color:#1A1A1A;border-radius:8px;border-top:4px solid #C8221A;box-shadow:0 10px 34px rgba(0,0,0,.35);padding:14px 16px 12px;font:14px/1.45 "Droid Serif",Georgia,serif;pointer-events:auto;transition:left .3s ease,top .3s ease,opacity .2s}',
    '.ing-tour-card .t-step{font:700 10px/1 Georgia,serif;letter-spacing:.1em;text-transform:uppercase;color:#9A968C;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}',
    '.ing-tour-card .t-x{background:none;border:0;font-size:20px;line-height:1;color:#9A968C;cursor:pointer;padding:0 2px}',
    '.ing-tour-card .t-text{font-size:15px}',
    '.ing-tour-card .t-bar{height:3px;background:#eee;border-radius:2px;margin:10px 0 0;overflow:hidden}',
    '.ing-tour-card .t-bar i{display:block;height:100%;background:#C8221A;transition:width .4s}',
    '.ing-tour-card .t-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}',
    '.ing-tour-btn{border:1px solid #9A968C;background:#fff;color:#1A1A1A;border-radius:4px;padding:6px 12px;font:600 13px "Droid Serif",Georgia,serif;cursor:pointer}',
    '.ing-tour-btn.primary{background:#C8221A;border-color:#C8221A;color:#fff}',
    '.ing-tour-btn.go{background:#4A7C3F;border-color:#4A7C3F;color:#fff}',
    /* mock product page used by the Watch demo */
    '.ing-tour-mock{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);width:min(560px,calc(100vw - 24px));background:#fff;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.5),0 12px 40px rgba(0,0,0,.4);overflow:hidden;font-family:"Droid Serif",Georgia,serif;opacity:0;transition:opacity .3s,transform .3s}',
    '.ing-tour-mock.on{opacity:1;transform:translate(-50%,-50%) scale(1)}',
    '.ing-tour-mock .m-bar{background:#2D2E32;color:#bbb;font-size:11px;padding:7px 12px;letter-spacing:.06em;text-transform:uppercase;border-bottom:3px solid #C8221A}',
    '.ing-tour-mock .m-body{display:flex;gap:18px;padding:20px}',
    '.ing-tour-mock .m-img{flex:0 0 130px;height:130px;background:#eceef1;border:1px dashed #D9D4C8;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#9A968C;font-size:12px}',
    '.ing-tour-mock h4{margin:0 0 6px;font-size:17px;color:#1A1A1A}',
    '.ing-tour-mock .m-pn{font:12px "Courier New",monospace;color:#3D3D3D;margin-bottom:8px}',
    '.ing-tour-mock .m-price{font:700 18px "Courier New",monospace;color:#4A7C3F;margin-bottom:12px}',
    '.ing-tour-mock .m-qty{display:inline-block;border:1px solid #D9D4C8;border-radius:4px;padding:6px 12px;margin-right:8px;font-size:13px}',
    '.ing-tour-mock .m-add{display:inline-block;background:#4A7C3F;color:#fff;border-radius:4px;padding:8px 16px;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.04em}',
    '.ing-tour-mock .m-ok{display:none;margin-top:10px;color:#4A7C3F;font-weight:700}',
    '.ing-tour-mock .m-ok.on{display:block}',
    '.ing-tour-toast{position:fixed;transform:translateX(-50%);background:#4A7C3F;color:#fff;font:700 15px "Droid Serif",Georgia,serif;padding:9px 16px;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.3);animation:ingPop .25s ease-out;white-space:nowrap}',
    '.ing-tour-mock .m-foot{position:relative;height:58px;background:#fafaf8;border-top:1px solid #eee}',
    '.ing-tour-mock .m-foot .ing-back-pill{position:absolute;left:12px;bottom:10px;opacity:0;transition:opacity .3s}',
    '.ing-tour-mock .m-foot .ing-back-pill.on{opacity:1}',
    /* back-to-diagram pill (real one + mock copy) */
    '.ing-back-pill{position:fixed;bottom:18px;z-index:' + (Z - 10) + ';display:flex;align-items:center;gap:4px;background:#2D2E32;color:#fff;border-left:4px solid #C8221A;border-radius:24px;box-shadow:0 6px 20px rgba(0,0,0,.3);font:14px/1.2 "Droid Serif",Georgia,serif;max-width:calc(100vw - 36px)}',
    '.ing-back-pill a{color:#fff;text-decoration:none;padding:9px 6px 9px 14px;display:block;min-width:0}',
    '.ing-back-pill a strong{display:block;font-size:14px}',
    '.ing-back-pill a small{display:block;font-size:11px;color:#bbb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62vw}',
    '.ing-back-pill button{background:none;border:0;color:#999;font-size:18px;cursor:pointer;padding:6px 12px 6px 4px}',
    /* the real (site-wide) pill: larger than the mock copy inside the demo */
    '.ing-back-pill.left,.ing-back-pill.right{bottom:24px;border-left-width:6px;border-radius:34px;box-shadow:0 8px 28px rgba(0,0,0,.4);animation:ingPillIn .45s ease-out}',
    '.ing-back-pill.left{left:24px}.ing-back-pill.right{right:24px}',
    '.ing-back-pill.left a,.ing-back-pill.right a{padding:14px 8px 14px 22px}',
    '.ing-back-pill.left a strong,.ing-back-pill.right a strong{font-size:19px}',
    '.ing-back-pill.left a small,.ing-back-pill.right a small{font-size:13px;margin-top:3px}',
    '.ing-back-pill.left button,.ing-back-pill.right button{font-size:22px;padding:8px 16px 8px 6px}',
    '.ing-back-pill.left:hover,.ing-back-pill.right:hover{background:#C8221A}',
    '@keyframes ingPillIn{from{transform:translateY(30px);opacity:0}to{transform:none;opacity:1}}',
    '@media(max-width:640px){.ing-back-pill.left a strong,.ing-back-pill.right a strong{font-size:17px}.ing-back-pill.left,.ing-back-pill.right{bottom:16px}.ing-back-pill.left{left:12px}.ing-back-pill.right{right:12px}}',
    '.ing-back-pill.pulse{animation:ingTourPulse 1.4s ease-in-out infinite;outline-color:#FFD700}',
    '.ing-back-hint{position:fixed;bottom:104px;z-index:' + (Z - 10) + ';background:#FFD700;color:#1A1A1A;font:600 13px Georgia,serif;padding:8px 12px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:260px}',
    '.ing-back-hint.left{left:24px}.ing-back-hint.right{right:24px}',
    /* first-visit offer */
    '.ing-tour-offer-bg{position:fixed;inset:0;z-index:' + (Z - 5) + ';background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;animation:ingFade .25s ease-out}',
    '.ing-tour-offer{width:480px;max-width:100%;background:#fff;border-radius:10px;border-top:6px solid #C8221A;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:26px 28px 22px;font:16px/1.5 "Droid Serif",Georgia,serif;color:#1A1A1A;text-align:center;position:relative;animation:ingPop .3s ease-out}',
    '.ing-tour-offer .o-x{position:absolute;top:8px;right:12px;background:none;border:0;font-size:26px;line-height:1;color:#9A968C;cursor:pointer}',
    '.ing-tour-offer .o-icon{width:54px;height:54px;margin:0 auto 10px;border-radius:50%;background:#FFD700;color:#1A1A1A;display:flex;align-items:center;justify-content:center;font:700 30px Georgia,serif}',
    '.ing-tour-offer h5{margin:0 0 8px;font-size:23px;line-height:1.25}',
    '.ing-tour-offer p{margin:0 0 20px;color:#3D3D3D;font-size:16px}',
    '.ing-tour-offer .t-btns{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}',
    '.ing-tour-offer .t-btns .ing-tour-btn{font-size:16px;padding:12px 18px;flex:1 1 180px}',
    '.ing-tour-offer .o-skip{display:inline-block;margin-top:14px;background:none;border:0;color:#7a766c;font:14px Georgia,serif;text-decoration:underline;cursor:pointer}',
    '@keyframes ingFade{from{opacity:0}to{opacity:1}}',
    '@keyframes ingPop{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion: reduce){.ing-tour-ring,.ing-back-pill.pulse,.ing-tour-launch{animation:none}}'
  ].join('\n');
  var styleEl = el('style'); styleEl.textContent = css; document.head.appendChild(styleEl);

  var CURSOR_SVG = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11.2-6.6 1 3.9 7.6-3 1.5-3.9-7.7L4 20.4z" fill="#fff" stroke="#1A1A1A" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  /* ======================================================================
     Tour engine
     ====================================================================== */
  var T = null; // active tour state

  function Cancelled() {}
  function sleep(ms) {
    var tok = T;
    return new Promise(function (res, rej) {
      setTimeout(function () { (T && T === tok && !T.dead) ? res() : rej(new Cancelled()); }, ms);
    });
  }
  function alive(tok) { return T && T === tok && !T.dead; }

  function buildLayer(mode) {
    var layer = el('div', 'ing-tour-layer');
    if (mode === 'watch') {
      var blocker = el('div', 'ing-tour-blocker');
      // Clicks during the demo are ignored (they used to end the tour,
      // which customers did by accident while trying to "click through").
      // A click just nudges the card so they see where Skip tour is.
      blocker.addEventListener('click', function () {
        if (!T) return;
        var c = T.ui.card; c.classList.remove('nudge'); void c.offsetWidth; c.classList.add('nudge');
      });
      layer.appendChild(blocker);
    }
    var ring = el('div', 'ing-tour-ring' + (mode === 'show' ? ' dim' : ''));
    var cursor = el('div', 'ing-tour-cursor' + (isTouch ? ' touch' : ''), isTouch ? '' : CURSOR_SVG);
    if (mode !== 'watch') cursor.style.display = 'none';
    var card = el('div', 'ing-tour-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-live', 'polite');
    layer.appendChild(ring); layer.appendChild(cursor); layer.appendChild(card);
    document.body.appendChild(layer);
    return { layer: layer, ring: ring, cursor: cursor, card: card };
  }

  // Positions ring + card every frame, so they stay glued to their targets
  // while the page or the parts list scrolls.
  function frameLoop() {
    if (!T || T.dead) return;
    var ring = T.ui.ring, card = T.ui.card;
    var tgt = typeof T.target === 'function' ? T.target() : T.target;
    var r = null;
    if (tgt && tgt.isConnected) {
      r = tgt.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) r = null;
    }
    if (r) {
      var pad = T.pad == null ? 6 : T.pad;
      ring.style.opacity = '1';
      ring.style.left = (r.left - pad) + 'px';
      ring.style.top = (r.top - pad) + 'px';
      ring.style.width = (r.width + pad * 2) + 'px';
      ring.style.height = (r.height + pad * 2) + 'px';
    } else {
      ring.style.opacity = '0';
    }
    // Card placement
    var cw = card.offsetWidth, ch = card.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, x, y;
    if (!isNarrow() && r && T.side) {
      x = (r.right + 18 + cw < vw) ? r.right + 18 : r.left - 18 - cw;
      y = Math.min(Math.max(12, r.top + r.height / 2 - ch / 2), vh - ch - 12);
    } else if (isNarrow() || !r) {
      x = (vw - cw) / 2;
      y = r ? (r.top + r.height / 2 > vh * 0.55 ? 12 : vh - ch - 12) : (vh - ch) / 2;
    } else {
      x = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
      if (r.bottom + 16 + ch < vh) y = r.bottom + 16;
      else if (r.top - 16 - ch > 0) y = r.top - 16 - ch;
      else { // target fills the screen: sit beside it, or bottom corner
        y = vh - ch - 12;
        x = (r.left > cw + 24) ? 12 : vw - cw - 12;
      }
    }
    card.style.left = Math.round(x) + 'px';
    card.style.top = Math.round(y) + 'px';
    // Watch-mode cursor
    if (T.cur) { T.ui.cursor.style.left = T.cur.x + 'px'; T.ui.cursor.style.top = T.cur.y + 'px'; }
    T.raf = requestAnimationFrame(frameLoop);
  }

  function setCard(o) {
    var c = T.ui.card;
    var total = T.total;
    var stepTxt = o.step ? ('Step ' + o.step + ' of ' + total) : (T.mode === 'watch' ? 'Quick tour' : 'Step by step');
    var html = '<div class="t-step"><span>' + stepTxt + '</span><button class="t-x" aria-label="Close tour">&times;</button></div>' +
      '<div class="t-text">' + o.text + '</div>';
    if (o.step) html += '<div class="t-bar"><i style="width:' + Math.round(o.step / total * 100) + '%"></i></div>';
    html += '<div class="t-btns"></div>';
    c.innerHTML = html;
    c.querySelector('.t-x').onclick = function () { endTour('exit'); };
    var btns = c.querySelector('.t-btns');
    (o.buttons || []).forEach(function (b) {
      var bt = el('button', 'ing-tour-btn' + (b.cls ? ' ' + b.cls : ''), b.label);
      bt.type = 'button';
      bt.onclick = function (e) { e.stopPropagation(); b.fn(); };
      btns.appendChild(bt);
    });
    if (!btns.children.length) btns.style.display = 'none';
    T.target = o.target || null;
    T.pad = o.pad;
    T.side = !!o.side;
    if (o.step) track('catalog_tour_step', { tour_mode: T.mode, tour_step: o.step });
  }

  function startTour(mode) {
    if (!widget()) return;
    lsDel(K_RESUME);
    begin(mode, mode === 'watch' ? runWatch : runShow, true);
  }

  // Shared start-up for a fresh tour AND for a Watch demo resuming on the
  // product page / back on the catalog after a real page load.
  function begin(mode, run, fresh) {
    if (T) endTour('restart');
    closeOffer(true);
    T = { mode: mode, ui: buildLayer(mode), dead: false, cleanups: [], total: mode === 'watch' ? 8 : 6 };
    if (mode === 'watch') T.cur = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.85 };
    var onKey = function (e) { if (e.key === 'Escape') endTour('exit'); };
    document.addEventListener('keydown', onKey);
    T.cleanups.push(function () { document.removeEventListener('keydown', onKey); });
    T.raf = requestAnimationFrame(frameLoop);
    if (fresh) track('catalog_tour_start', { tour_mode: mode });
    run().catch(function (err) { if (!(err instanceof Cancelled)) { console.error('Ingersoll tour error', err); endTour('error'); } });
  }

  function endTour(reason) {
    if (!T) return;
    var t = T; t.dead = true; T = null;
    cancelAnimationFrame(t.raf);
    t.cleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
    if (t.ui.layer.parentNode) t.ui.layer.parentNode.removeChild(t.ui.layer);
    var mock = document.querySelector('.ing-tour-mock'); if (mock) mock.remove();
    if (openDropdown()) closeDropdown();
    var wrap = q('.diagram-wrap'); if (wrap) wrap.dispatchEvent(new MouseEvent('mouseleave'));
    if (reason !== 'handoff') lsDel(K_RESUME);
    if (reason === 'complete') track('catalog_tour_complete', { tour_mode: t.mode });
    else if (reason === 'exit') track('catalog_tour_exit', { tour_mode: t.mode });
  }

  /* ---------------- Watch-mode helpers ---------------- */
  function pointOf(target, fx, fy) {
    return function () {
      var e = typeof target === 'function' ? target() : target;
      if (!e || !e.isConnected) return null;
      var r = e.getBoundingClientRect();
      return { x: r.left + r.width * (fx == null ? 0.5 : fx), y: r.top + r.height * (fy == null ? 0.5 : fy) };
    };
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function moveTo(getPt, ms, onStep) {
    var tok = T, sx = T.cur.x, sy = T.cur.y, t0 = performance.now();
    ms = ms || 900;
    return new Promise(function (res, rej) {
      function f(now) {
        if (!alive(tok)) return rej(new Cancelled());
        var p = getPt(); if (!p) return res();
        var k = Math.min(1, (now - t0) / ms), e = ease(k);
        T.cur.x = sx + (p.x - sx) * e; T.cur.y = sy + (p.y - sy) * e;
        if (onStep) onStep(T.cur.x, T.cur.y);
        if (k < 1) requestAnimationFrame(f); else res();
      }
      requestAnimationFrame(f);
    });
  }
  function clickFx() {
    var r = el('div', 'ing-tour-ripple');
    r.style.left = T.cur.x + 'px'; r.style.top = T.cur.y + 'px';
    T.ui.layer.appendChild(r);
    T.ui.cursor.classList.add('press');
    setTimeout(function () { r.remove(); if (T) T.ui.cursor.classList.remove('press'); }, 600);
    return sleep(220);
  }
  function inView(e, margin) {
    var r = e.getBoundingClientRect(); margin = margin || 70;
    return r.top >= margin && r.bottom <= window.innerHeight - margin;
  }
  function ensureVisible(e, block) {
    if (!e || inView(e)) return Promise.resolve();
    e.scrollIntoView({ behavior: 'smooth', block: block || 'center' });
    return sleep(650);
  }
  function hoverDiagram(x, y) {
    var wrap = q('.diagram-wrap');
    if (wrap) wrap.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  }

  async function runWatch() {
    var skip = { label: 'Skip tour', fn: function () { endTour('exit'); } };
    var w = widget();

    setCard({ text: '<strong>Here’s how to find and order parts</strong> in about a minute. Sit back and watch — it plays by itself. Use <strong>Skip tour</strong> to stop.', buttons: [skip] });
    await sleep(3200);

    // 1. Section arrows
    var arrow = navArrow() || toggleBtn();
    await ensureVisible(navBar() || arrow, 'start');
    setCard({ step: 1, target: arrow, text: 'Use the <strong>arrow buttons</strong> to flip to the previous or next section of this catalog.', buttons: [skip] });
    await moveTo(pointOf(arrow, 0.5, 0.6), 1100);
    await sleep(2900);

    // 2. Sections list
    var tog = toggleBtn();
    setCard({ step: 2, target: tog, text: 'Or click <strong>☰ Sections</strong> to jump straight to any part of the machine.', buttons: [skip] });
    await moveTo(pointOf(tog, 0.5, 0.6), 900);
    await sleep(1500);
    await clickFx();
    if (tog) tog.click();
    await sleep(450);
    T.target = openDropdown; T.pad = 4;
    var dd = openDropdown();
    if (dd) {
      var items = [].slice.call(dd.children);
      var scrolls = dd.scrollHeight > dd.clientHeight + 4;
      setCard({ step: 2, target: openDropdown, pad: 4, side: true, text: scrolls
        ? 'Every section is listed here. <strong>Scroll down</strong> to see them all…'
        : 'Every section is listed here.', buttons: [skip] });
      await moveTo(pointOf(dd, 0.5, 0.25), 800);
      await sleep(1300);
      // Pick a section near the bottom that isn't the one already open.
      var pick = null;
      for (var pi = items.length - 2; pi <= items.length && !pick; pi++) {
        var cand = items[(pi + items.length) % items.length];
        if (cand && cand.style.fontWeight !== '700') pick = cand;
      }
      if (scrolls && pick) {
        var targetTop = Math.max(0, Math.min(pick.offsetTop - dd.clientHeight * 0.55, dd.scrollHeight - dd.clientHeight));
        var startTop = dd.scrollTop, t0 = performance.now(), tok = T;
        // Smooth-scroll the list while the pointer drifts down with it.
        await moveTo(pointOf(dd, 0.5, 0.8), 1800, function () {
          var k = Math.min(1, (performance.now() - t0) / 1800);
          if (alive(tok)) dd.scrollTop = startTop + (targetTop - startTop) * ease(k);
        });
        dd.scrollTop = targetTop;
        await sleep(500);
      }
      if (pick) {
        setCard({ step: 2, target: pick, pad: 2, side: true, text: 'Click a section to open it.', buttons: [skip] });
        await moveTo(pointOf(pick, 0.35, 0.5), 900);
        await sleep(1000);
        await clickFx();
        var oldTitle = sectionTitle(widget());
        pick.click();
        setCard({ step: 2, text: 'Opening <strong>' + esc(pick.textContent) + '</strong>…', buttons: [skip] });
        // Wait for book mode to fetch + build the new section (gives up after 12s).
        var waited = 0;
        while (waited < 12000) {
          var nw = widget();
          if (nw && sectionTitle(nw) !== oldTitle && nw.querySelector('.hotspot')) break;
          await sleep(200); waited += 200;
        }
        await sleep(700);
      } else {
        await sleep(1500);
        closeDropdown();
        await sleep(300);
      }
    }

    // Make sure the section we demo on actually has something in stock
    // (and that live stock data has finished loading) before going further.
    await ensureStockedSection(2, skip);

    // 3. Magnifier
    var wrap = q('.diagram-wrap');
    await ensureVisible(q('.spread') || wrap, 'start');
    setCard({ step: 3, target: wrap, pad: 2, text: isTouch
      ? '<strong>Touch and drag</strong> on the diagram to magnify it…'
      : '<strong>Move your mouse</strong> over the diagram to magnify it…', buttons: [skip] });
    await moveTo(pointOf(wrap, 0.25, 0.3), 1000, hoverDiagram);
    var prev = q('.zoom-preview');
    setCard({ step: 3, target: prev || wrap, text: '…and a <strong>zoomed view</strong> appears here, so the small numbers are easy to read.', buttons: [skip] });
    await moveTo(pointOf(wrap, 0.7, 0.45), 1900, hoverDiagram);
    await moveTo(pointOf(wrap, 0.45, 0.7), 1700, hoverDiagram);
    if (wrap) wrap.dispatchEvent(new MouseEvent('mouseleave'));

    // 4. Click a dot
    await waitStock(15000);
    var rows = demoRows();
    var rowA = rows[Math.min(2, rows.length - 1)];
    var refA = rowA && rowA.dataset.ref;
    var dot = dotFor(refA) || q('.hotspot');
    if (dot) {
      setCard({ step: 4, target: dot, side: true, text: 'Each <strong>numbered dot</strong> is a part. Point at one to see its name, stock and price.', buttons: [skip] });
      await moveTo(pointOf(dot), 1100, hoverDiagram);
      dot.dispatchEvent(new MouseEvent('mouseenter'));
      await sleep(2600);
      await clickFx();
      dot.dispatchEvent(new MouseEvent('mouseleave'));
      if (wrap) wrap.dispatchEvent(new MouseEvent('mouseleave'));
      dot.click();
      await sleep(750);
      var activeRow = function () { return q('.parts-row.active'); };
      await ensureVisible(activeRow());
      setCard({ step: 4, target: activeRow, pad: 2, text: 'Click it, and that part is <strong>highlighted in the parts list</strong>.', buttons: [skip] });
      await moveTo(pointOf(activeRow, 0.3, 0.5), 900);
      await sleep(2600);
    }

    // 5. Click a row
    var rowB = rows[Math.min(5, rows.length - 1)] || rowA;
    if (rowB && rowB === rowA && rows.length > 1) rowB = rows[rows.length - 1];
    if (rowB) {
      var refB = rowB.dataset.ref;
      var rowBNow = function () { return q('.parts-row[data-ref="' + refB + '"]'); };
      rowB.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(600);
      setCard({ step: 5, target: rowBNow, pad: 2, text: 'It works the other way too — <strong>click a row</strong> in the list…', buttons: [skip] });
      await moveTo(pointOf(rowBNow, 0.35, 0.5), 1000);
      await sleep(1300);
      await clickFx();
      var rb = rowBNow(); if (rb) rb.click();
      await sleep(500);
      var dotB = function () { return dotFor(refB); };
      await ensureVisible(dotB());
      setCard({ step: 5, target: dotB, side: true, text: '…and its <strong>dot lights up</strong> on the diagram.', buttons: [skip] });
      await moveTo(pointOf(dotB), 1000);
      await sleep(2400);
    }

    // 6. Stock / Add to Cart
    // Use the in-stock row itself (a ref can have several serial-number
    // variant rows, and the first one isn't necessarily the in-stock one).
    var row = null;
    if (rowB) {
      var inStockBtn = q('.parts-row[data-ref="' + rowB.dataset.ref + '"] .add-btn[href]');
      row = inStockBtn ? inStockBtn.closest('.parts-row') : q('.parts-row[data-ref="' + rowB.dataset.ref + '"]');
    }
    var btn = row && row.querySelector('.add-btn');
    if (row) {
      await ensureVisible(row);
      setCard({ step: 6, target: row, pad: 2, text: 'A <strong>green price and Add to Cart</strong> button means it’s in stock. Grey “Out of Stock” or “Not Sold Sep.” parts can’t be ordered online.', buttons: [skip] });
      await moveTo(pointOf(btn || row, 0.5, 0.5), 1000);
      await sleep(3600);
    }
    if (btn && btn.getAttribute('href')) {
      setCard({ step: 6, target: btn, pad: 4, text: 'Click <strong>Add to Cart</strong> to open that part’s page.', buttons: [skip] });
      await sleep(1500);
      await clickFx();
      // Hand off to the REAL product page. The demo's state goes in
      // localStorage and the tour picks back up after the page loads
      // (maybeResume -> runProductStage). Nothing is added to the cart.
      recordCatalogState({ ref: row.dataset.ref, restore: true });
      lsSet(K_RESUME, { stage: 'product', t: Date.now() });
      var dest = btn.getAttribute('href');
      endTour('handoff');
      location.href = dest;
      return;
    }

    // Fallback (this section has nothing in stock): example product page in a pop-up.
    await runMockProduct(row, w, skip);
    finishWatch();
  }

  async function runMockProduct(row, w, skip) {
    var pn = row ? (row.querySelector('.partno-cell') || {}).textContent : '';
    var desc = row ? (row.querySelector('.desc-cell') || {}).textContent : '';
    var price = row && row.querySelector('.price') ? row.querySelector('.price').textContent : '';
    desc = (desc || '').replace(price, '').trim();
    var mock = el('div', 'ing-tour-mock',
      '<div class="m-bar">Product page (example)</div>' +
      '<div class="m-body"><div class="m-img">Photo</div><div>' +
      '<h4>' + esc(desc || 'Example part') + '</h4><div class="m-pn">Part # ' + esc(pn) + '</div>' +
      '<div class="m-price">' + esc(price || '$0.00') + '</div>' +
      '<span class="m-add">Add to Cart</span>' +
      '<div class="m-ok">✓ Added to your cart</div></div></div>' +
      '<div class="m-foot"><div class="ing-back-pill"><a><strong>← Back to diagram</strong><small>' +
      esc(catalogLabel(w) + ' · ' + sectionTitle(w)) + '</small></a></div></div>');
    T.ui.layer.insertBefore(mock, T.ui.ring);
    T.cleanups.push(function () { mock.remove(); });
    await sleep(30);
    mock.classList.add('on');
    var mAdd = mock.querySelector('.m-add');
    setCard({ step: 7, target: mAdd, pad: 4, text: 'On the part’s page, click <strong>Add to Cart</strong>.', buttons: [skip] });
    await moveTo(pointOf(mAdd), 1000);
    await sleep(1400);
    await clickFx();
    mock.querySelector('.m-ok').classList.add('on');
    await sleep(1200);
    var mPill = mock.querySelector('.ing-back-pill');
    mPill.classList.add('on');
    setCard({ step: 8, target: mPill, pad: 4, text: 'Then click <strong>← Back to diagram</strong> to return to the exact section and part you were on.', buttons: [skip] });
    await moveTo(pointOf(mPill), 1000);
    await sleep(3200);
    await clickFx();
    mock.classList.remove('on');
    await sleep(350);
    mock.remove();
  }

  function finishWatch() {
    if (!T) return;
    var launch = q('.ing-tour-launch');
    T.cur = null; T.ui.cursor.style.display = 'none';
    var blocker = T.ui.layer.querySelector('.ing-tour-blocker'); if (blocker) blocker.remove();
    setCard({ target: launch, pad: 4, text: '<strong>That’s it!</strong> Replay this tour anytime with the <strong>How to use this catalog</strong> button. Want to try it yourself?',
      buttons: [
        { label: 'Done', fn: function () { endTour('complete'); } },
        { label: 'Try it step by step', cls: 'primary', fn: function () { endTour('complete'); startTour('show'); } }
      ] });
  }

  /* ---------------- Watch demo, continued on the real product page ---------------- */
  var DUDA_ADD_BTN = '[data-auto="add-to-cart-button"]';
  var DUDA_CART = '[data-auto="ssr-cart-widget"], [data-auto="cart-icon"]';

  function demoToast(nearEl, text) {
    var r = nearEl.getBoundingClientRect();
    var t = el('div', 'ing-tour-toast', text);
    t.style.left = Math.round(r.left + r.width / 2) + 'px';
    t.style.top = Math.round(r.bottom + 12) + 'px';
    T.ui.layer.appendChild(t);
    return t;
  }

  async function waitEl(sel, ms) {
    var waited = 0, e;
    while (!(e = document.querySelector(sel)) && waited < ms) { await sleep(200); waited += 200; }
    return e;
  }

  async function runProductStage() {
    var skip = { label: 'Skip tour', fn: function () { endTour('exit'); } };
    var rec = lsGet(K_BACK);
    var add = await waitEl(DUDA_ADD_BTN, 8000);
    var title = document.querySelector('h1');
    setCard({ step: 7, target: title || add, pad: 6, text: 'This is the <strong>part’s own page</strong> — photo, price and details.', buttons: [skip] });
    if (title) await moveTo(pointOf(title, 0.4, 0.5), 1100);
    await sleep(2600);

    if (add && visible(add)) {
      await ensureVisible(add);
      setCard({ step: 7, target: add, pad: 4, text: 'Click <strong>Add to Cart</strong> to put it in your cart.<br><small style="color:#7a766c">(Just a demo — nothing is actually being added.)</small>', buttons: [skip] });
      await moveTo(pointOf(add), 1000);
      await sleep(1700);
      await clickFx();
      var toast = demoToast(add, '✓ Added to cart');
      await sleep(2000);
      toast.remove();
    }

    var cart = [].slice.call(document.querySelectorAll(DUDA_CART)).filter(visible)[0];
    if (cart) {
      var cr = cart.getBoundingClientRect();
      if (cr.top < 0) { window.scrollTo({ top: 0, behavior: 'smooth' }); await sleep(600); }
      setCard({ step: 7, target: cart, pad: 6, text: 'Your <strong>cart</strong> is up here — click it when you’re ready to check out.', buttons: [skip] });
      await moveTo(pointOf(cart), 1100);
      await sleep(2800);
    }

    maybeShowPill();
    var pill = await waitEl('.ing-back-pill.left, .ing-back-pill.right', 2500);
    setCard({ step: 8, target: pill, pad: 4, text: 'When you’re done, click <strong>← Back to diagram</strong> to go right back to the section and part you were on. (Your browser’s back button works too.)', buttons: [skip] });
    if (pill) {
      await moveTo(pointOf(pill, 0.35, 0.5), 1200);
      await sleep(3400);
      await clickFx();
    } else {
      await sleep(3000);
    }
    if (rec && rec.href) {
      lsSet(K_RESUME, { stage: 'finish', t: Date.now(), href: rec.href });
      endTour('handoff');
      location.href = rec.href;
    } else {
      endTour('complete');
    }
  }

  async function runFinishStage() {
    var skip = { label: 'Skip tour', fn: function () { endTour('exit'); } };
    var activeRow = function () { return q('.parts-row.active'); };
    var waited = 0;
    while (!activeRow() && waited < 4000) { await sleep(200); waited += 200; }
    if (activeRow()) {
      await ensureVisible(activeRow());
      setCard({ step: 8, target: activeRow, pad: 2, text: '<strong>You’re right back where you left off</strong> — same section, with your part highlighted.', buttons: [skip] });
      await moveTo(pointOf(activeRow, 0.4, 0.5), 1000);
      await sleep(3200);
    }
    finishWatch();
  }

  var resumeLock = false;
  function maybeResume() {
    if (T || resumeLock) return;
    var st = lsGet(K_RESUME);
    if (!st) return;
    if (Date.now() - st.t > RESUME_TTL_MS) { lsDel(K_RESUME); return; }
    var w = widget();
    if (st.stage === 'product' && !w && /\/product\//.test(location.pathname)) {
      resumeLock = true; lsDel(K_RESUME);
      begin('watch', function () { return runProductStage().then(function () { resumeLock = false; }, function (e) { resumeLock = false; throw e; }); });
    } else if (st.stage === 'finish' && w && w.querySelector('.hotspot')) {
      resumeLock = true; lsDel(K_RESUME);
      begin('watch', function () { return runFinishStage().then(function () { resumeLock = false; }, function (e) { resumeLock = false; throw e; }); });
    } else if (w && st.stage === 'product') {
      lsDel(K_RESUME); // visitor came back to the catalog some other way
    }
  }


  /* ---------------- In-stock guarantees for the Watch demo ---------------- */
  // Stock data is "ready" once no row still shows the grey "Checking..." badge.
  function stockReady() {
    var w = widget();
    return !!(w && w.querySelector('.parts-row') && !w.querySelector('.stock-btn.pending'));
  }
  function hasStock() {
    var w = widget();
    return !!(w && w.querySelector('.parts-row .add-btn[href]'));
  }
  async function waitStock(ms) {
    var waited = 0;
    while (!stockReady() && waited < ms) { await sleep(250); waited += 250; }
    return stockReady();
  }
  async function waitSectionChange(oldTitle, ms) {
    var waited = 0;
    while (waited < ms) {
      var nw = widget();
      if (nw && sectionTitle(nw) !== oldTitle && nw.querySelector('.hotspot')) return true;
      await sleep(200); waited += 200;
    }
    return false;
  }
  // Makes sure the open section has at least one in-stock part. If it
  // doesn't, quietly opens the next sections (via the Sections list) until
  // one does, trying at most MAX_TRIES so a catalog with nothing in stock
  // never loops forever (the demo then falls back to the example pop-up).
  var MAX_STOCK_TRIES = 8;
  async function ensureStockedSection(step, skip) {
    if (!(await waitStock(15000))) return false;
    if (hasStock()) return true;
    var tog = toggleBtn(); if (!tog) return false;
    tog.click(); await sleep(350);
    var dd = openDropdown(); if (!dd) return false;
    var n = dd.children.length, cur = 0;
    for (var i = 0; i < n; i++) if (dd.children[i].style.fontWeight === '700') cur = i;
    closeDropdown(); await sleep(250);
    for (var k = 1; k < n && k <= MAX_STOCK_TRIES; k++) {
      setCard({ step: step, text: 'Nothing in this section is in stock right now — finding one that is…', buttons: [skip] });
      tog = toggleBtn(); if (!tog) return false;
      tog.click(); await sleep(350);
      dd = openDropdown(); if (!dd) return false;
      var item = dd.children[(cur + k) % n];
      var oldTitle = sectionTitle(widget());
      item.click();
      await waitSectionChange(oldTitle, 12000);
      if ((await waitStock(15000)) && hasStock()) {
        setCard({ step: step, text: 'Here’s <strong>' + esc(sectionTitle(widget())) + '</strong>.', buttons: [skip] });
        await sleep(900);
        return true;
      }
    }
    return false;
  }

  /* ---------------- Show-me mode ---------------- */
  // Resolves when fn(event) returns truthy for a click anywhere on the page.
  function waitClick(match) {
    var tok = T;
    return new Promise(function (res, rej) {
      function h(e) { if (match(e.target)) { done(); setTimeout(res, 50); } }
      function done() { document.removeEventListener('click', h, true); clearInterval(iv); }
      var iv = setInterval(function () { if (!alive(tok)) { done(); rej(new Cancelled()); } }, 250);
      document.addEventListener('click', h, true);
      tok.cleanups.push(done);
      tok.skip = function () { done(); res('skip'); };
    });
  }
  function waitFor(cond) {
    var tok = T;
    return new Promise(function (res, rej) {
      var iv = setInterval(function () {
        if (!alive(tok)) { clearInterval(iv); return rej(new Cancelled()); }
        if (cond()) { clearInterval(iv); res(); }
      }, 150);
      tok.cleanups.push(function () { clearInterval(iv); });
      tok.skip = function () { clearInterval(iv); res('skip'); };
    });
  }
  function closest(t, sel) { return t && t.closest ? t.closest(sel) : null; }

  async function runShow() {
    var skipBtn = { label: 'Skip this step', fn: function () { if (T && T.skip) T.skip(); } };
    var w = widget();
    var r;

    // 1. Arrows
    await ensureVisible(navBar() || navArrow(), 'start');
    setCard({ step: 1, target: navArrow, text: 'Click an <strong>arrow button</strong> to flip to the next (or previous) section.', buttons: [skipBtn] });
    r = await waitClick(function (t) { return closest(t, '.book-nav-prev,.book-nav-next,.section-nav-prev,.section-nav-next'); });
    if (r !== 'skip') { setCard({ step: 1, target: function () { return q('.section-bar'); }, text: '✔ Nice — you’re now on a different section.' }); await sleep(1800); }

    // 2. Sections list
    setCard({ step: 2, target: toggleBtn, text: 'Now click <strong>☰ Sections</strong> to see every section in this catalog.', buttons: [skipBtn] });
    r = await waitClick(function (t) { return closest(t, '.book-nav-toggle,.section-nav-toggle'); });
    if (r !== 'skip') {
      await sleep(250);
      setCard({ step: 2, target: openDropdown, pad: 4, text: 'Pick any section from the list (or click outside it to close).' });
      await waitFor(function () { return !openDropdown(); });
      await sleep(400);
    }

    // 3. Magnifier
    await ensureVisible(q('.spread') || q('.diagram-wrap'), 'start');
    setCard({ step: 3, target: function () { return q('.diagram-wrap'); }, pad: 2, text: isTouch
      ? '<strong>Touch and drag your finger</strong> across the diagram.'
      : '<strong>Move your mouse</strong> slowly across the diagram.', buttons: [skipBtn] });
    r = await waitFor(function () { var p = q('.zoom-preview'); return p && p.classList.contains('active'); });
    if (r !== 'skip') {
      setCard({ step: 3, target: function () { return q('.zoom-preview'); }, text: 'See the <strong>zoomed view</strong>? It follows your pointer so small numbers are easy to read.' });
      await sleep(3200);
    }

    // 4. Dot
    setCard({ step: 4, target: function () { return q('.diagram-wrap'); }, pad: 2, text: 'Click any <strong>numbered dot</strong> on the diagram.', buttons: [skipBtn] });
    r = await waitClick(function (t) { return closest(t, '.hotspot'); });
    if (r !== 'skip') {
      await sleep(600);
      await ensureVisible(q('.parts-row.active'));
      setCard({ step: 4, target: function () { return q('.parts-row.active'); }, pad: 2, text: '✔ That part is now <strong>highlighted in the list</strong>.' });
      await sleep(2800);
    }

    // 5. Row
    setCard({ step: 5, target: function () { return q('.parts-panel'); }, pad: 0, text: 'Now click <strong>any row</strong> in the parts list.', buttons: [skipBtn] });
    var clickedRef = null;
    r = await waitClick(function (t) {
      var row = closest(t, '.parts-row');
      if (row && !closest(t, '.add-btn')) { clickedRef = row.dataset.ref; return true; }
      return false;
    });
    if (r !== 'skip' && clickedRef != null) {
      await sleep(300);
      await ensureVisible(dotFor(clickedRef));
      setCard({ step: 5, target: function () { return dotFor(clickedRef); }, text: '✔ And its <strong>dot lights up</strong> on the diagram.' });
      await sleep(2800);
    }

    // 6. Add to Cart (real navigation — we hand off to the back-link pill)
    var firstBtn = function () { var b = q('.parts-row.active .add-btn'); if (b && visible(b)) return b; var rs = demoRows(); return rs[0] ? rs[0].querySelector('.add-btn') : null; };
    var fb = firstBtn(); if (fb) await ensureVisible(fb);
    setCard({ step: 6, target: firstBtn, pad: 4,
      text: 'When you find your part, click <strong>Add to Cart</strong>. You’ll go to that part’s page — add it to your cart there, then click <strong>← Back to diagram</strong> (bottom corner) to come right back here.',
      buttons: [{ label: 'Finish tour', cls: 'primary', fn: function () { endTour('complete'); } }] });
    lsSet(K_HINT, { t: Date.now() });
    await waitClick(function (t) { return closest(t, '.add-btn'); }).catch(function () {});
    if (T) endTour('complete');
  }

  /* ======================================================================
     Launch button + first-visit offer
     ====================================================================== */
  function addLaunchButtons() {
    var ws = document.querySelectorAll('.ingersoll-catalog-widget');
    for (var i = 0; i < ws.length; i++) {
      var hdr = ws[i].querySelector('header');
      if (!hdr || hdr.querySelector('.ing-tour-launch')) continue;
      var b = el('button', 'ing-tour-launch', '<b>?</b><span class="l-long">How to use this catalog</span><span class="l-short">How to use</span>');
      b.type = 'button';
      b.title = 'How to use this catalog';
      b.setAttribute('aria-label', 'How to use this catalog');
      b.addEventListener('click', function (e) { e.stopPropagation(); openChooser(); });
      hdr.appendChild(b);
    }
  }

  var offerEl = null;
  function closeOffer(markSeen) {
    if (offerEl) { offerEl.remove(); offerEl = null; }
    document.removeEventListener('keydown', offerKey);
    if (markSeen) lsSet(K_SEEN, { t: Date.now() });
  }
  function offerKey(e) { if (e.key === 'Escape') closeOffer(true); }
  function offerCard(title, body, dismissLabel) {
    closeOffer(false);
    document.addEventListener('keydown', offerKey);
    // Centered card over a dimmed page. Clicking the dimmed area, the x,
    // the text link, or pressing Esc all close it.
    offerEl = el('div', 'ing-tour-offer-bg');
    var card = el('div', 'ing-tour-offer',
      '<button type="button" class="o-x" aria-label="Close">&times;</button>' +
      '<div class="o-icon">?</div><h5>' + title + '</h5><p>' + body + '</p><div class="t-btns"></div>' +
      '<button type="button" class="o-skip">' + dismissLabel + '</button>');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    offerEl.appendChild(card);
    var btns = card.querySelector('.t-btns');
    [['▶ Watch a 1-min demo', 'primary', function () { startTour('watch'); }],
     ['Show me step by step', 'go', function () { startTour('show'); }]].forEach(function (d) {
      var b = el('button', 'ing-tour-btn ' + d[1], d[0]); b.type = 'button';
      b.onclick = function () { closeOffer(true); d[2](); };
      btns.appendChild(b);
    });
    card.querySelector('.o-x').onclick = card.querySelector('.o-skip').onclick = function () { closeOffer(true); };
    offerEl.addEventListener('click', function (e) { if (e.target === offerEl) closeOffer(true); });
    document.body.appendChild(offerEl);
    var b0 = btns.querySelector('.primary'); if (b0) b0.focus();
  }
  function openChooser() {
    offerCard('How to use this catalog', 'Watch a quick demo, or let us walk you through it one click at a time.', 'Cancel');
  }
  var offered = false;
  function maybeOffer() {
    if (offered || !CFG.offerFirstVisit || lsGet(K_SEEN)) return;
    offered = true;
    setTimeout(function () {
      if (T || lsGet(K_SEEN) || !widget()) return;
      offerCard('New to our interactive catalogs?', 'Take a 1-minute tour to see how to find parts and order them.', 'No thanks');
    }, CFG.offerDelayMs);
  }

  /* ======================================================================
     Back-to-diagram link
     ====================================================================== */
  function here() { return location.pathname + location.search; }

  function recordCatalogState(extra) {
    var w = widget(); if (!w) return;
    var rec = lsGet(K_BACK) || {};
    var sec = sectionTitle(w);
    if (rec.href !== here() || rec.section !== sec) { rec.ref = null; rec.restore = false; }
    rec.href = here();
    rec.catalog = catalogLabel(w);
    rec.section = sec;
    rec.t = Date.now();
    rec.dismissed = false;
    Object.assign(rec, extra || {});
    lsSet(K_BACK, rec);
  }

  // Track which part was picked / sent to cart, so we can re-highlight it on return.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!closest(t, '.ingersoll-catalog-widget')) return;
    var row = closest(t, '.parts-row'), dot = closest(t, '.hotspot');
    if (closest(t, '.add-btn') && row) recordCatalogState({ ref: row.dataset.ref, restore: true });
    else if (row) recordCatalogState({ ref: row.dataset.ref, restore: false });
    else if (dot) recordCatalogState({ ref: dot.dataset.hsRef, restore: false });
  }, true);

  var lastRestoreKey = null;
  function maybeRestoreSelection() {
    var rec = lsGet(K_BACK), w = widget();
    if (!rec || !w || !rec.restore || rec.href !== here() || rec.section !== sectionTitle(w) || rec.ref == null) return;
    var key = rec.href + '|' + rec.section + '|' + rec.ref;
    if (lastRestoreKey === key) return;
    var d = dotFor(rec.ref);
    if (!d) return; // hotspots not built yet; observer will call again
    lastRestoreKey = key;
    rec.restore = false; lsSet(K_BACK, rec);
    setTimeout(function () { var d2 = dotFor(rec.ref); if (d2) d2.click(); }, 400);
  }

  var pillEl = null, hintEl = null;
  function removePill() { if (pillEl) { pillEl.remove(); pillEl = null; } if (hintEl) { hintEl.remove(); hintEl = null; } }
  function maybeShowPill() {
    if (!CFG.backLinkEnabled) return;
    if (widget()) { removePill(); return; }
    var rec = lsGet(K_BACK);
    if (!rec || !rec.href || rec.dismissed || Date.now() - rec.t > CFG.backLinkMaxAgeMs || rec.href === here()) { removePill(); return; }
    if (pillEl) return;
    var side = CFG.backLinkPosition === 'right' ? 'right' : 'left';
    pillEl = el('div', 'ing-back-pill ' + side,
      '<a href="' + esc(rec.href) + '"><strong>← Back to diagram</strong><small>' +
      esc([rec.catalog, rec.section].filter(Boolean).join(' · ')) + '</small></a>' +
      '<button type="button" aria-label="Hide">&times;</button>');
    pillEl.querySelector('a').addEventListener('click', function (e) {
      track('catalog_back_link_click', { catalog: rec.catalog, section: rec.section });
      // Full navigation (not Duda soft-nav) so book mode restores cleanly.
      e.preventDefault();
      var r2 = lsGet(K_BACK); if (r2) { r2.dismissed = false; lsSet(K_BACK, r2); }
      location.href = rec.href;
    });
    pillEl.querySelector('button').addEventListener('click', function () {
      var r2 = lsGet(K_BACK); if (r2) { r2.dismissed = true; lsSet(K_BACK, r2); }
      removePill();
    });
    document.body.appendChild(pillEl);

    // Right after a "Show me" tour, point the pill out once.
    var hint = lsGet(K_HINT);
    if (hint && Date.now() - hint.t < 30 * 60 * 1000) {
      lsDel(K_HINT);
      pillEl.classList.add('pulse');
      hintEl = el('div', 'ing-back-hint ' + side, 'When you’re done here, click this to go back to your diagram.');
      document.body.appendChild(hintEl);
      setTimeout(function () { if (hintEl) { hintEl.remove(); hintEl = null; } if (pillEl) pillEl.classList.remove('pulse'); }, 9000);
    }
  }

  /* ======================================================================
     Watch the page: Duda soft navigation + book-mode section remounts
     ====================================================================== */
  var lastSectionKey = null, scanTimer = null, lastPath = here();
  function scan() {
    scanTimer = null;
    var w = widget();
    var onCatalogPage = !!document.querySelector('.ingersoll-book-shell, .ingersoll-catalog-widget');
    if (!w && onCatalogPage) return; // book mode is between sections ("Loading section..."), not a new page
    if (w) {
      addLaunchButtons();
      removePill();
      var key = here() + '|' + sectionTitle(w);
      if (key !== lastSectionKey && w.querySelector('.hotspot')) { lastSectionKey = key; recordCatalogState(); }
      maybeRestoreSelection();
      maybeResume();
      if (!lsGet(K_RESUME)) maybeOffer();
    } else {
      maybeShowPill();
      maybeResume();
    }
  }
  function schedule(ms) { if (!scanTimer) scanTimer = setTimeout(scan, ms || 250); }

  function boot() {
    new MutationObserver(function () { schedule(250); }).observe(document.body, { childList: true, subtree: true });
    setInterval(function () {
      if (here() !== lastPath) { lastPath = here(); lastSectionKey = null; removePill(); if (T) endTour('navigated'); schedule(1200); }
    }, 800);
    schedule(1200);
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);

  window.IngersollTour = { start: startTour, end: endTour, chooser: openChooser };
})();