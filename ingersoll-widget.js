/* ==========================================================================
   Ingersoll Catalog Widget — shared rendering logic
   --------------------------------------------------------------------------
   Hosted at:
     https://raw.githubusercontent.com/ingersollsteve90-ux/ingersoll-catalog-widget/main/ingersoll-widget.js

   This file is loaded via <script src="..."> from every catalog-section
   widget on caseingersollparts.com. It defines:

     1. window.IngersollCatalog — the shared live-Duda-store lookup module.
        Guarded so however many section widgets are on one page, the
        ~8,700-product catalog is fetched exactly ONCE and shared by all
        of them.

     2. window.IngersollWidgetInit(root, hotspots, footnotesText) — call
        this once per widget instance, passing:
          - root:          the widget's own .ingersoll-catalog-widget element
          - hotspots:       that section's hotspot array (ref/x/y/partNo/desc,
                            or ref/x/y/variants for serial-number splits)
          - footnotesText: that section's free-text serial-number notes,
                            or "" if none

   DATA MODEL (per hotspot)
   ------------------------
   Each hotspot has a ref/x/y (position on the diagram) plus EITHER:
     - flat fields: partNo, desc                          (single-part ref)
   OR:
     - a "variants" array, each entry shaped like the flat fields above,
       plus a "serialNote" string describing which serial-number range it
       applies to (e.g. "* Prior to S/N 12345", "** S/N 12345 & up").

   Stock status, price, and the Add-to-Cart link are NOT stored here —
   they're resolved live from the Duda store at page-load time via
   IngersollCatalog, keyed off partNo. If a partNo has no match in the live
   catalog, that reliably means it's NSS/O·L (not sold separately / obtain
   locally) for this project.

   Do not hand-edit this file per catalog page — it's identical for every
   section. Per-section data lives inline in each widget's own small
   <script> block that calls IngersollWidgetInit().
   ========================================================================== */

/* ---------------------------------------------------------------------- */
/* Shared live-catalog module — ONE instance for the whole page, however  */
/* many catalog-section widgets are stacked on it.                       */
/* ---------------------------------------------------------------------- */
/* ---------------------------------------------------------------------- */
/* Mobile layout fix — injected once per page. Every already-pasted       */
/* section widget carries its own embedded copy of the mobile CSS, baked  */
/* in at build time. Rather than require re-pasting all of them whenever  */
/* a shared style bug is found, inject a corrected stylesheet here that   */
/* naturally overrides the embedded copies (later same-specificity rules  */
/* win the cascade) — this one file update fixes every section already   */
/* on the page, old and new, with no re-pasting needed.                   */
/* --------------------------------------------------------------------- */
(function () {
  if (window.__ingersollMobileFixInjected) return;
  window.__ingersollMobileFixInjected = true;

  var style = document.createElement('style');
  style.textContent =
    '@media(max-width:768px){' +
    '.ingersoll-catalog-widget{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;}' +
    '.spread{flex-direction:column!important;overflow:visible!important;min-height:0!important;}' +
    '.diagram-panel{flex:0 0 auto!important;width:100%!important;height:60vh!important;min-height:350px!important;max-height:550px!important;border-right:none!important;border-bottom:2px solid #D9D4C8!important;}' +
    '.parts-panel{flex:0 0 auto!important;overflow-y:visible!important;max-height:none!important;}' +
    '}';
  document.head.appendChild(style);
})();

window.IngersollCatalog = window.IngersollCatalog || (function () {
  var cache = null;
  var byNamePrefix = {};
  var bySku = {};
  var loadPromise = null;

  function normalize(s) {
    return (s || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  }

  // Pull the leading part-number token off a product name like
  // "C20738 GASKET - COVER TO VALVE PLATE - ONAN 149-1323" -> "C20738"
  function namePrefixPartNo(name) {
    if (!name) return '';
    var firstToken = name.trim().split(/\s+/)[0];
    return normalize(firstToken);
  }

  function indexItems(items) {
    byNamePrefix = {};
    bySku = {};
    items.forEach(function (item) {
      var d = item && item.data;
      if (!d) return;
      var prefixKey = namePrefixPartNo(d.name);
      if (prefixKey) byNamePrefix[prefixKey] = item;
      var skuKey = normalize(d.sku);
      if (skuKey) bySku[skuKey] = item;
    });
  }

  function fetchAllPages() {
    return new Promise(function (resolve, reject) {
      dmAPI.runOnReady('ingersollCatalogFetch', function () {
        dmAPI.loadCollectionsAPI().then(function (api) {
          return api.storeData('catalog_product').select('name', 'sku', 'price', 'stock_status', 'seo_url').pageSize(100).pageNumber(0).get();
        }).then(function (firstPage) {
          var totalPages = (firstPage.page && firstPage.page.totalPages) || 1;
          var allValues = (firstPage.values || []).slice();

          if (totalPages <= 1) {
            resolve(allValues);
            return;
          }

          var pagePromises = [];
          for (var p = 1; p < totalPages; p++) {
            (function (pageNum) {
              pagePromises.push(
                dmAPI.loadCollectionsAPI().then(function (api) {
                  return api.storeData('catalog_product').select('name', 'sku', 'price', 'stock_status', 'seo_url').pageSize(100).pageNumber(pageNum).get();
                })
              );
            })(p);
          }

          Promise.all(pagePromises).then(function (pages) {
            pages.forEach(function (pg) {
              if (pg && pg.values) allValues.push.apply(allValues, pg.values);
            });
            resolve(allValues);
          }).catch(reject);
        }).catch(reject);
      });
    });
  }

  var CACHE_KEY = 'ingersollCatalogCache_v1';
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — long enough to cover a normal browsing session

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.t > CACHE_TTL_MS) return null;
      return parsed.items;
    } catch (e) {
      return null; // storage unavailable/corrupt — just refetch normally
    }
  }

  function writeCache(items) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), items: items }));
    } catch (e) {
      // storage full or unavailable — not fatal, just skip caching this time
    }
  }

  function load() {
    if (loadPromise) return loadPromise;

    var cached = readCache();
    if (cached) {
      cache = cached;
      indexItems(cached);
      loadPromise = Promise.resolve(cached);
      return loadPromise;
    }

    loadPromise = fetchAllPages().then(function (items) {
      cache = items;
      indexItems(items);
      writeCache(items);
      return items;
    });
    return loadPromise;
  }

  // Returns { found, name, description, price, status, url } or null.
  // null reliably means NSS/O·L for this project (see note above).
  function lookup(partNo) {
    if (!cache) return null;
    var key = normalize(partNo);
    if (!key) return null;

    var item = byNamePrefix[key] || bySku[key];

    if (!item) {
      item = cache.find(function (it) {
        var d = it && it.data;
        if (!d) return false;
        return normalize(d.name).indexOf(key) !== -1 ||
               normalize(d.description).indexOf(key) !== -1;
      });
    }

    if (!item || !item.data) return null;

    var d = item.data;
    return {
      found: true,
      name: d.name,
      description: d.description,
      price: typeof d.price === 'number' ? d.price : null,
      status: d.stock_status || null,
      // Duda's Store API has no "page_item_url" field (that assumption was
      // wrong and caused every Add to Cart link to 404). The real product
      // page path is built from seo_url, prefixed with /product/.
      url: d.seo_url ? ('/product/' + d.seo_url) : null
    };
  }

  return { load: load, lookup: lookup };
})();

/* ---------------------------------------------------------------------- */
/* Auto-refresh on back-button return. Add to Cart navigates in the same */
/* tab, so the most common return path is the browser's own Back button. */
/* pageshow with event.persisted=true fires specifically on a bfcache    */
/* restore (the instant, no-reload page-restore browsers do on Back),    */
/* which is an unambiguous signal they just came back from adding        */
/* something to cart, so refresh automatically rather than asking.       */
/* ------------------------------------------------------------------- */
window.addEventListener('pageshow', function (event) {
  if (event.persisted && document.querySelector('.ingersoll-catalog-widget')) {
    location.reload();
  }
});

/* ---------------------------------------------------------------------- */
/* Catalog navigation — each section gets its own prev/next + a shared    */
/* section-index dropdown. The nav bar lives in NORMAL page flow, right   */
/* below each section's own header (outside the internally-scrolling      */
/* diagram/parts panels), so it naturally stays visible while that        */
/* section is on screen and scrolls away with it once you move past —     */
/* no position:fixed/sticky needed, and no scroll-tracking required,      */
/* since each section's prev/next is fully known from its own position    */
/* in the registry, not from "what's currently visible."                  */
/* ---------------------------------------------------------------------- */
/* ---------------------------------------------------------------------- */
/* Shared activation queue — spreads each section's initial DOM build     */
/* (hotspot dots + parts table rows) across idle time instead of doing    */
/* ALL sections synchronously in one blocking burst on page load. This is */
/* NOT visibility-based (unlike the abandoned IntersectionObserver        */
/* attempt above) — every section still activates, in the same page       */
/* order as before, just spread out over several idle slices rather than  */
/* one long main-thread block. On a 60+ section catalog page this is the  */
/* difference between the tab freezing for a couple seconds vs. the top   */
/* of the page being interactive almost immediately while the rest        */
/* finishes in the background. Falls back to setTimeout chunking on       */
/* browsers without requestIdleCallback (Safari).                         */
/* ---------------------------------------------------------------------- */
window.IngersollActivationQueue = window.IngersollActivationQueue || (function () {
  var queue = [];
  var scheduled = false;

  function runChunk(deadline) {
    while (queue.length && (!deadline || deadline.timeRemaining() > 4 || deadline.didTimeout)) {
      var fn = queue.shift();
      try { fn(); } catch (e) { console.error('Ingersoll widget: section activation failed', e); }
    }
    if (queue.length) {
      schedule();
    } else {
      scheduled = false;
    }
  }

  function schedule() {
    scheduled = true;
    if (window.requestIdleCallback) {
      requestIdleCallback(runChunk, { timeout: 200 });
    } else {
      setTimeout(function () { runChunk(null); }, 16);
    }
  }

  function enqueue(fn) {
    queue.push(fn);
    if (!scheduled) schedule();
  }

  return { enqueue: enqueue };
})();

window.IngersollCatalogNav = window.IngersollCatalogNav || (function () {
  var sections = []; // { title, root }
  var dropdown;

  function buildDropdown() {
    dropdown = document.createElement('div');
    dropdown.setAttribute('style',
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'z-index:99997;background:#fff;border-radius:8px;' +
      'box-shadow:0 6px 24px rgba(0,0,0,.35);max-height:70vh;overflow-y:auto;' +
      'display:none;min-width:300px;max-width:90vw;font-family:Georgia,serif;'
    );
    document.body.appendChild(dropdown);

    var backdrop = document.createElement('div');
    backdrop.setAttribute('style',
      'position:fixed;inset:0;z-index:99996;background:rgba(0,0,0,.35);display:none;'
    );
    document.body.appendChild(backdrop);
    dropdown.__backdrop = backdrop;

    backdrop.addEventListener('click', closeDropdown);
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.__backdrop.style.display = 'none';
  }

  function renderDropdown(currentRoot) {
    dropdown.innerHTML = '';
    sections.forEach(function (s) {
      var item = document.createElement('div');
      item.textContent = s.title;
      var active = s.root === currentRoot;
      item.setAttribute('style',
        'padding:11px 18px;cursor:pointer;border-bottom:1px solid #eee;' +
        'font-size:13px;color:#1A1A1A;' +
        (active ? 'background:#F5F3EE;font-weight:700;' : '')
      );
      item.addEventListener('mouseenter', function () { item.style.background = '#F5F3EE'; });
      item.addEventListener('mouseleave', function () { item.style.background = active ? '#F5F3EE' : ''; });
      item.addEventListener('click', function () {
        s.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeDropdown();
      });
      dropdown.appendChild(item);
    });
  }

  // Every registered section's own bar reflects its true neighbors, so
  // this needs to re-run for ALL sections whenever a new one registers
  // (an earlier section's "next" label may only become known once a
  // later section finishes loading in).
  function updateAllBars() {
    sections.forEach(function (s, i) {
      var bar = s.root.querySelector('.section-nav-bar');
      if (!bar) return;
      var prevBtn = bar.querySelector('.section-nav-prev');
      var nextBtn = bar.querySelector('.section-nav-next');

      if (i > 0) {
        var prevTarget = sections[i - 1];
        prevBtn.textContent = '← ' + prevTarget.title;
        prevBtn.onclick = function () {
          prevTarget.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
      } else {
        prevBtn.textContent = '';
        prevBtn.onclick = null;
      }

      if (i < sections.length - 1) {
        var nextTarget = sections[i + 1];
        nextBtn.textContent = nextTarget.title + ' →';
        nextBtn.onclick = function () {
          nextTarget.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
      } else {
        nextBtn.textContent = '';
        nextBtn.onclick = null;
      }
    });
  }

  // Called once per widget, as each section initializes. Sections may
  // register slightly out of order relative to on-screen position if
  // their scripts happen to resolve at different times, so keep the
  // list sorted by each root's actual position in the document.
  function register(title, root) {
    if (!dropdown) buildDropdown();

    sections.push({ title: title, root: root });
    sections.sort(function (a, b) {
      return a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    var toggleBtn = root.querySelector('.section-nav-toggle');
    if (toggleBtn && !toggleBtn.dataset.ingersollWired) {
      toggleBtn.dataset.ingersollWired = 'true';
      toggleBtn.addEventListener('click', function () {
        var showing = dropdown.style.display === 'block';
        if (showing) {
          closeDropdown();
        } else {
          renderDropdown(root);
          dropdown.style.display = 'block';
          dropdown.__backdrop.style.display = 'block';
        }
      });
    }

    updateAllBars();
  }

  return { register: register };
})();

/* ---------------------------------------------------------------------- */
/* Per-widget rendering logic — call once per widget instance, passing   */
/* that widget's own root element, hotspots array, footnotes text, and    */
/* section title (used for the shared prev/next nav + section index).    */
/* ---------------------------------------------------------------------- */
window.IngersollWidgetInit = function (root, hotspots, footnotesText, sectionTitle) {
  window.IngersollCatalogNav.register(sectionTitle, root);

  let catalogLoaded = false;
  let activeRef = null;
  let hoveredIndex = null; // which hotspot (by array index) the cursor is over, for the zoom preview to highlight

  // Normalize every hotspot to always have a `variants` array internally,
  // so the rest of the code only has to handle one shape.
  function normalizedVariants(h) {
    if (h.variants && h.variants.length) return h.variants;
    return [{
      serialNote: null,
      partNo: h.partNo,
      desc: h.desc
    }];
  }

  // Merges live catalog data onto a variant, non-destructively. Before
  // IngersollCatalog.load() resolves, live is null and isInStock is false;
  // the rendering functions show a "checking stock" state in that window.
  function withLive(v) {
    const live = window.IngersollCatalog.lookup(v.partNo);
    return Object.assign({}, v, {
      live: live,
      isInStock: !!live && live.status === 'IN_STOCK'
    });
  }

  // A hotspot is "out of stock" for dot-coloring purposes only once the
  // catalog has finished loading AND every variant came back unavailable.
  // Before that, dots render in their normal color rather than flashing.
  function hotspotIsOut(h) {
    if (!catalogLoaded) return false;
    return normalizedVariants(h).map(withLive).every(v => !v.isInStock);
  }

  function buildHotspots() {
    const wrap = root.querySelector('.diagram-wrap');
    wrap.querySelectorAll('.hotspot').forEach(e => e.remove());

    hotspots.forEach((h, idx) => {
      const dot = document.createElement('div');
      const variants = normalizedVariants(h);
      dot.className = 'hotspot' + (hotspotIsOut(h) ? ' is-out' : '') + (variants.length > 1 ? ' has-variants' : '');
      dot.dataset.hsRef = h.ref;
      dot.dataset.hsIndex = idx;
      dot.textContent = h.ref;
      dot.style.left = h.x + '%';
      dot.style.top = h.y + '%';

      dot.addEventListener('mouseenter', (e) => { showTooltip(e, h); hoveredIndex = idx; refreshZoomDots(); });
      dot.addEventListener('mouseleave', () => { hideTooltip(); hoveredIndex = null; refreshZoomDots(); });
      dot.addEventListener('click', () => selectPart(h.ref));

      wrap.appendChild(dot);
      sizeHotspot(dot);
    });
  }

  // Keeps the mirrored dots inside the zoom preview in sync with which
  // hotspot (if any) the cursor is currently over. Called whenever hover
  // state changes AND every time the zoom preview repositions itself.
  function refreshZoomDots() {
    const zpDots = root.querySelectorAll('.zp-dot');
    zpDots.forEach(d => d.classList.toggle('zp-active', Number(d.dataset.hsIndex) === hoveredIndex));
  }

  // Sizes the diagram to fit the available panel space as large as
  // possible while preserving its aspect ratio, tightly hugging the
  // rendered image (critical: hotspot dots are positioned as % of
  // .diagram-wrap, so wrap must always exactly match the image's own
  // rendered bounding box, never a padded/letterboxed container).
  //
  // This is done with real measured pixel values rather than CSS
  // percentages deliberately: percentage height only resolves against
  // an ancestor with an explicit (non-auto-derived) height, and every
  // pure-CSS approach tried here (flex, grid, aspect-ratio) reintroduced
  // that same ambiguity in a different guise. Measuring directly with
  // JS and setting explicit px values sidesteps the issue entirely.
  function sizeDiagramContainer() {
    const panel = root.querySelector('.diagram-panel');
    const wrap = root.querySelector('.diagram-wrap');
    const img = root.querySelector('.diagram-img');
    const cs = getComputedStyle(panel);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = panel.clientWidth - padX;
    const availH = panel.clientHeight - padY;
    wrap.style.maxWidth = availW + 'px';
    wrap.style.maxHeight = availH + 'px';
    img.style.maxWidth = availW + 'px';
    img.style.maxHeight = availH + 'px';
  }
  function setupDiagramSizing() {
    sizeDiagramContainer();
    new ResizeObserver(sizeDiagramContainer).observe(root.querySelector('.diagram-panel'));
  }

  function sizeHotspot(el) {
    const wrapWidth = root.querySelector('.diagram-wrap').offsetWidth;
    // 2.16% of a normal-width diagram looks right, but the same percentage
    // on a narrow diagram (e.g. the tall, skinny ring/piston pages) shrinks
    // to an illegible sliver. Clamp to a sensible min/max instead of pure
    // percentage scaling, so every diagram gets a legible, clickable dot.
    const size = Math.min(32, Math.max(18, wrapWidth * 0.0216));
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.fontSize = Math.max(9, size * 0.4) + 'px';
  }

  function setupHotspotResize() {
    new ResizeObserver(() => root.querySelectorAll('.hotspot').forEach(sizeHotspot))
      .observe(root.querySelector('.diagram-wrap'));
  }

  // Magnifier lens: lets people read fine print / closely-packed ref numbers
  // without needing the whole diagram to be huge. Works with mouse hover
  // (desktop) and touch drag (mobile/tablet).
  function initMagnifier() {
    const wrap = root.querySelector('.diagram-wrap');
    const img = root.querySelector('.diagram-img');
    const preview = root.querySelector('.zoom-preview');
    const zpDotsContainer = root.querySelector('.zp-dots');
    const hint = root.querySelector('.mag-hint');
    const ZOOM = 2.5;
    let hintShown = false;

    // Mirror every hotspot as a small dot inside the zoom preview, in the
    // same left-to-right order as the real dots (so array index lines up
    // with dataset.hsIndex on the real dots for highlight matching).
    // Built lazily on first actual use, not eagerly here — on a large
    // catalog page, building this for every section on activation roughly
    // doubles the DOM node count for sections nobody ends up hovering.
    let zpDotsBuilt = false;
    function ensureZpDots() {
      if (zpDotsBuilt) return;
      zpDotsBuilt = true;
      hotspots.forEach((h, idx) => {
        const zd = document.createElement('div');
        zd.className = 'zp-dot';
        zd.textContent = h.ref;
        zd.dataset.hsIndex = idx;
        zpDotsContainer.appendChild(zd);
      });
    }

    // The zoomed view lives in a FIXED spot in the parts panel, not floating
    // over the cursor - a floating lens covers exactly the dot you're trying
    // to click, and can run off-screen near the edges of the diagram. A
    // fixed preview area never overlaps anything you need to interact with.
    function updateLens(clientX, clientY) {
      const imgRect = img.getBoundingClientRect();
      const x = clientX - imgRect.left;
      const y = clientY - imgRect.top;

      if (x < 0 || y < 0 || x > imgRect.width || y > imgRect.height) {
        preview.classList.remove('active');
        return;
      }
      ensureZpDots();
      if (!hintShown) { hint.classList.add('hidden'); hintShown = true; }

      preview.classList.add('active');
      const pw = preview.offsetWidth, ph = preview.offsetHeight;
      const bgX = pw / 2 - x * ZOOM;
      const bgY = ph / 2 - y * ZOOM;
      preview.style.backgroundImage = `url(${img.src})`;
      preview.style.backgroundSize = `${imgRect.width * ZOOM}px ${imgRect.height * ZOOM}px`;
      preview.style.backgroundPosition = `${bgX}px ${bgY}px`;

      // Reposition every mirrored dot to match the current pan/zoom, hiding
      // any that have panned outside the visible preview area, and light up
      // whichever one the cursor is actually over on the real diagram -
      // this is what lets someone confirm they've got the right ref number
      // before clicking, rather than guessing from a tightly-packed cluster.
      hotspots.forEach((h, idx) => {
        const zd = zpDotsContainer.children[idx];
        const dotX = (h.x / 100) * imgRect.width * ZOOM + bgX;
        const dotY = (h.y / 100) * imgRect.height * ZOOM + bgY;
        if (dotX < -12 || dotX > pw + 12 || dotY < -12 || dotY > ph + 12) {
          zd.style.display = 'none';
        } else {
          zd.style.display = 'flex';
          zd.style.left = dotX + 'px';
          zd.style.top = dotY + 'px';
        }
        zd.classList.toggle('zp-active', idx === hoveredIndex);
      });
    }

    function hideLens() { preview.classList.remove('active'); }

    // Listeners go on `wrap` (the container), NOT the image - the image has
    // pointer-events:none (so clicks reach the hotspot dots layered on top
    // of it), which means it can never itself receive mouse/touch events.
    // The wrap container sits underneath everything and correctly receives
    // bubbled events regardless of which child (image or a dot) the cursor
    // is actually over.
    wrap.addEventListener('mousemove', (e) => updateLens(e.clientX, e.clientY));
    wrap.addEventListener('mouseleave', hideLens);

    wrap.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      updateLens(t.clientX, t.clientY);
    }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      updateLens(t.clientX, t.clientY);
    }, { passive: true });
    wrap.addEventListener('touchend', hideLens);

    // Auto-hide the hint after a few seconds even if never touched, so it
    // doesn't linger as clutter on a page a customer is just skimming.
    setTimeout(() => hint.classList.add('hidden'), 4000);
  }

  function showTooltip(e, h) {
    const tt = root.querySelector('.tooltip');
    const panel = root.querySelector('.diagram-panel');
    const pr = panel.getBoundingClientRect();
    const dot = e.target.getBoundingClientRect();

    const variants = normalizedVariants(h).map(withLive);
    const body = variants.map(v => {
      const serialLine = v.serialNote ? `<div class="tt-serial">${v.serialNote}</div>` : '';
      let statusLine;
      if (!catalogLoaded) {
        statusLine = '<div class="tt-status pending">Checking stock…</div>';
      } else if (v.isInStock) {
        statusLine = '<div class="tt-status in">In Stock' + (v.live.price != null ? ' — $' + v.live.price.toFixed(2) : '') + '</div>';
      } else {
        statusLine = '<div class="tt-status out">' + (v.live ? 'Out of Stock' : 'Not Sold Sep. / Obtain Locally') + '</div>';
      }
      return `<div class="tt-variant">${serialLine}<div style="font-weight:700">${v.desc}</div><div class="tt-part">${v.partNo}</div>${statusLine}</div>`;
    }).join('');

    tt.innerHTML = `<div class="tt-ref">REF. ${h.ref}</div>${body}`;

    let left = dot.left - pr.left + dot.width / 2;
    let top = dot.top - pr.top - 8 + panel.scrollTop;

    tt.style.left = left + 'px';
    tt.style.top = top + 'px';
    tt.style.transform = 'translate(-50%, -100%)';
    tt.classList.add('visible');
  }

  function hideTooltip() {
    root.querySelector('.tooltip').classList.remove('visible');
  }

  function selectPart(ref) {
    if (activeRef !== null) {
      root.querySelector('.hotspot[data-hs-ref="' + activeRef + '"]')?.classList.remove('active');
      root.querySelectorAll('.parts-row[data-ref="' + activeRef + '"]').forEach(r => r.classList.remove('active'));
    }
    activeRef = ref;
    root.querySelector('.hotspot[data-hs-ref="' + ref + '"]')?.classList.add('active');
    const rows = root.querySelectorAll('.parts-row[data-ref="' + ref + '"]');
    rows.forEach(r => r.classList.add('active'));

    // Collapse the magnifier first — it only shows on hover/touch, but if
    // it's still active right when a part is selected, it sits on top of
    // the sticky header and can cover the row that's about to scroll into
    // view underneath it.
    root.querySelector('.zoom-preview')?.classList.remove('active');

    if (rows[0]) rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Builds the ENTIRE parts table from `hotspots` — this is the single
  // source of truth. There is no separate hardcoded table markup anywhere,
  // so the table and the hotspot data can never drift out of sync with
  // each other.
  function renderTable() {
    const tbody = root.querySelector('.parts-tbody');
    tbody.innerHTML = '';

    hotspots.forEach(h => {
      const variants = normalizedVariants(h).map(withLive);
      variants.forEach((v, i) => {
        const tr = document.createElement('tr');
        tr.className = 'parts-row' + (i > 0 ? ' variant-row' : '') + (catalogLoaded && !v.isInStock ? ' row-out' : '');
        tr.dataset.ref = h.ref;
        tr.onclick = () => selectPart(h.ref);

        const refCell = i === 0 ? `<td class="ref-cell" rowspan="${variants.length}">${h.ref}</td>` : '';
        const serialCell = `<td class="serial-cell">${v.serialNote || ''}</td>`;
        const partnoCell = `<td class="partno-cell">${v.partNo}</td>`;
        const descCell = `<td class="desc-cell">${v.desc}${v.live && v.live.price != null ? ` <span class="price">$${v.live.price.toFixed(2)}</span>` : ''}</td>`;

        let btnCell;
        if (!catalogLoaded) {
          btnCell = `<td class="btn-cell"><span class="stock-btn pending">Checking…</span></td>`;
        } else if (v.isInStock && v.live.url) {
          btnCell = `<td class="btn-cell"><a href="${v.live.url}" class="add-btn" onclick="event.stopPropagation()">Add to Cart</a></td>`;
        } else {
          const label = v.live ? 'Out of Stock' : 'Not Sold Sep.';
          btnCell = `<td class="btn-cell"><span class="stock-btn">${label}</span></td>`;
        }

        tr.innerHTML = refCell + serialCell + partnoCell + descCell + btnCell;
        tbody.appendChild(tr);
      });
    });
  }

  function renderFootnotes() {
    const box = root.querySelector('.footnotes-box');
    const text = root.querySelector('.footnotes-text');
    if (!footnotesText || !footnotesText.trim()) {
      box.classList.add('empty');
      return;
    }
    text.textContent = footnotesText;
    box.classList.remove('empty');
  }

  // Lazy activation: building hundreds of hotspot dots and table rows for
  // every section immediately (times however many sections are on the
  // page) is real, avoidable work most of which isn't even visible yet.
  // Instead, each section activates itself only once it's about to
  // scroll into view — a generous rootMargin means it's ready well
  // before you actually reach it, so nothing feels delayed.
  let activated = false;
  function activate() {
    if (activated) return;
    activated = true;

    setupDiagramSizing();
    setupHotspotResize();
    initMagnifier();

    // Initial render happens immediately using only the static PDF-sourced
    // data (ref/x/y/partNo/desc), so the widget is usable the instant it
    // activates. Once the shared live Duda catalog resolves (or resolves
    // instantly from cache — see IngersollCatalog above), everything
    // re-renders in place with real stock status, price, and Add-to-Cart
    // links merged in.
    buildHotspots();
    renderTable();
    renderFootnotes();

    window.IngersollCatalog.load().then(() => {
      catalogLoaded = true;
      buildHotspots();
      renderTable();
    }).catch(err => {
      console.error('IngersollCatalog failed to load — stock status unavailable this session.', err);
    });
  }

  // NOTE: this used to be gated behind an IntersectionObserver so each
  // section only built its DOM once scrolled near, instead of all at once
  // on page load. That was confirmed NOT to work in Duda's actual runtime —
  // a fresh, minimal IntersectionObserver tested directly on a live page
  // never fired at all, even after several seconds, on a fully-visible
  // element. Rather than depend on an API that silently doesn't work here,
  // every section still activates unconditionally — but now via the shared
  // IngersollActivationQueue above, which spreads the (potentially 60+)
  // sections' DOM-building work across idle time instead of doing it all
  // synchronously in one blocking burst. This is pacing, not visibility —
  // it doesn't reintroduce the IntersectionObserver failure mode, since
  // nothing is ever skipped, just spread out.
  window.IngersollActivationQueue.enqueue(activate);
};

/* ---------------------------------------------------------------------- */
/* Fetch-based entry point — loads a section's hotspots/footnotes from an */
/* external JSON URL instead of requiring them inlined in the widget's    */
/* own <script> block. This is ADDITIVE and fully backward-compatible:    */
/* window.IngersollWidgetInit above is completely unchanged, so every     */
/* already-pasted widget (which calls it directly with a literal          */
/* hotspots array) keeps working forever, untouched, no migration needed. */
/*                                                                        */
/* WHY: per-widget inline data means fixing a typo'd description or a     */
/* mis-clicked hotspot coordinate requires re-pasting that whole widget   */
/* in Duda. With externalized data, the same kind of fix becomes editing  */
/* a JSON file on GitHub and pushing — identical to how diagram image     */
/* corrections already work, no Duda interaction at all.                 */
/*                                                                        */
/* USAGE (opt-in — NOT wired into the master template's default output   */
/* yet; adopting this in a given catalog's build pipeline is a separate,  */
/* deliberate step — see Ingersoll_Handoff_v2.md before switching a       */
/* catalog's generation script over to this):                            */
/*   window.IngersollWidgetInitFromData(root, {                          */
/*     dataUrl: "https://cdn.jsdelivr.net/gh/ingersollsteve90-ux/"        */
/*             + "ingersoll-catalog-diagrams@main/8-3200/"                */
/*             + "01_crankshaft_camshaft_flywheel.json",                  */
/*     sectionTitle: "Crankshaft, Camshaft & Flywheel"                    */
/*   });                                                                  */
/* Expected JSON shape at dataUrl: { "hotspots": [...], "footnotes": "" } */
/* — same shape already produced by the hotspot editor's Export.          */
/*                                                                        */
/* Cached in sessionStorage per URL, same 30-min-session pattern as the   */
/* live product catalog fetch, so a multi-section page doesn't re-fetch   */
/* JSON it already has. On fetch failure, shows a plain in-place error    */
/* message rather than a silently blank/broken widget.                   */
/* ---------------------------------------------------------------------- */
window.IngersollWidgetInitFromData = function (root, opts) {
  var dataUrl = opts && opts.dataUrl;
  var sectionTitle = opts && opts.sectionTitle;
  var CACHE_PREFIX = 'ingersollSectionData_v1:';

  if (!dataUrl) {
    console.error('Ingersoll widget: IngersollWidgetInitFromData called without a dataUrl.');
    return;
  }

  function renderWithData(data) {
    var hotspots = (data && data.hotspots) || [];
    var footnotesText = (data && data.footnotes) || '';
    window.IngersollWidgetInit(root, hotspots, footnotesText, sectionTitle);
  }

  function showError() {
    root.innerHTML = '<div style="padding:40px;text-align:center;color:#900;'
      + 'font-family:Georgia,serif">Unable to load this section\'s data. '
      + 'Please refresh the page, or contact us if this keeps happening.</div>';
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_PREFIX + dataUrl);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + dataUrl, JSON.stringify(data));
    } catch (e) {
      // storage full/unavailable — not fatal, just skip caching this time
    }
  }

  var cached = readCache();
  if (cached) {
    renderWithData(cached);
    return;
  }

  fetch(dataUrl)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (data) {
      writeCache(data);
      renderWithData(data);
    })
    .catch(function (err) {
      console.error('Ingersoll widget: failed to load section data from ' + dataUrl, err);
      showError();
    });
};
