// src/ui/app.js
//
// Hash-based view router and sidebar controller. #main renders whichever
// view matches location.hash, defaulting to #/home.
//
// Views must expose window.MusikViews.<name>(mainEl) — see home.js and
// system-check.js for examples. Mods that add a new page should register
// under this same object and can link to it with a normal #/<name> href
// in the nav or elsewhere in the UI.
//
// #/system-check is a valid route but isn't in the default sidebar nav —
// it's reachable from a button in Settings.

(function () {
  const DEFAULT_VIEW = 'home';

  function currentRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (!hash) return { view: DEFAULT_VIEW, param: undefined };
    const [view, ...rest] = hash.split('/');
    const param = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
    return { view: view || DEFAULT_VIEW, param };
  }

  function setActiveNav(viewName) {
    document.querySelectorAll('.nav-link').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === viewName);
    });
  }

  // View swaps fade the outgoing content out, swap innerHTML, then fade
  // the new content in. Kept short (120ms) so it reads as a transition,
  // not a loading delay.
  const VIEW_FADE_MS = 120;

  function render() {
    const main = document.getElementById('main');
    if (!main) {
      console.error('[Musik] #main not found in DOM');
      return;
    }
    const { view: viewName, param } = currentRoute();
    const renderFn = window.MusikViews && window.MusikViews[viewName];

    const doRender = () => {
      if (!renderFn) {
        console.warn(`[Musik] no view registered for "${viewName}", falling back to home`);
        window.MusikViews?.home?.(main);
        setActiveNav('home');
      } else {
        renderFn(main, param);
        setActiveNav(viewName);
      }
      window.Musik?.events?.emit('viewchange', viewName);

      main.classList.remove('view-leaving');
      main.classList.add('view-entering');
      // Force reflow so the entering transition actually plays instead of
      // being coalesced with the class add.
      void main.offsetWidth;
      main.classList.remove('view-entering');
    };

    if (main.childElementCount === 0) {
      // First render, nothing to fade out.
      doRender();
      return;
    }

    main.classList.add('view-leaving');
    setTimeout(doRender, VIEW_FADE_MS);
  }

  function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) {
      console.error('[Musik] #sidebar not found in DOM');
      return;
    }

    sidebar.innerHTML = `
      <div id="app-name">
        <span id="sidebar-logo">
          <!-- Square viewBox with the .sidebar-icon class so this icon is
               centered/sized identically to every other rail icon. -->
          <svg class="sidebar-icon" viewBox="-3 -6 30 30" fill="currentColor">
            <rect class="viz-bar" data-bar="0" x="0" y="6" width="3" height="6" rx="1.5"/><rect class="viz-bar" data-bar="1" x="5.25" y="1" width="3" height="16" rx="1.5"/><rect class="viz-bar" data-bar="2" x="10.5" y="7" width="3" height="4" rx="1.5"/><rect class="viz-bar" data-bar="3" x="15.75" y="0" width="3" height="18" rx="1.5"/><rect class="viz-bar" data-bar="4" x="21" y="4" width="3" height="10" rx="1.5"/>
          </svg>
        </span>
        <span class="logo-text-wrap">Musik</span>
        <button class="sidebar-collapse-btn" id="sidebar-collapse-btn" title="Icon-only sidebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <button class="sidebar-pin-btn" id="sidebar-pin-btn" title="Pin sidebar open">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <rect x="3" y="4" width="18" height="16" rx="3"/>
            <rect class="pin-panel-active" x="3" y="4" width="8" height="16" rx="3" stroke="none"/>
            <line x1="11" y1="4" x2="11" y2="20"/>
          </svg>
        </button>
      </div>
      <div id="nav-links"></div>
      <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>
    `;

    renderNavLinks();
    initSidebarLayout();
    initSidebarResize();
    initSidebarCollapse();
    initSidebarLogo();
    initWordmarkEgg();
  }

  // ── Nav items: data-driven, reorderable, hideable ─────────────────────
  // Config array for the sidebar nav. Order and visibility are user-
  // controlled and persisted (see getNavOrder/getNavHidden below). Each
  // item's svg is a complete <svg> element rather than just inner paths,
  // since different icons need different attrs on the outer tag (fill vs
  // stroke).
  const NAV_ITEMS = [
    {
      id: 'home',
      label: 'Home',
      href: '#/home',
      title: 'Home',
      svg: `<svg class="sidebar-icon" viewBox="0 0 24 24"><path d="M12 3l9 8h-3v9h-5v-6H11v6H6v-9H3l9-8z"/></svg>`,
    },
    {
      id: 'search',
      label: 'Search',
      action: 'open-search',
      title: 'Search (Ctrl+K)',
      // Not a route — doesn't navigate, opens the search overlay instead
      // (see wireSearchTrigger below). User can drag it anywhere via the
      // reorder system like any other nav item.
      svg: `<svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><line x1="19.5" y1="19.5" x2="16.6" y2="16.6"/></svg>`,
    },
    {
      id: 'library',
      label: 'Library',
      href: '#/library',
      title: 'Library',
      svg: `<svg class="sidebar-icon" viewBox="0 0 24 24"><rect class="lib-bar" x="4" y="4" width="7" height="7" rx="1.6"/><rect class="lib-bar" x="13" y="4" width="7" height="7" rx="1.6"/><rect class="lib-bar" x="4" y="13" width="7" height="7" rx="1.6"/><rect class="lib-bar" x="13" y="13" width="7" height="7" rx="1.6"/></svg>`,
    },
    {
      id: 'settings',
      label: 'Settings',
      href: '#/settings',
      title: 'Settings',
      svg: `<svg class="sidebar-icon" viewBox="0 0 24 24" style="fill:none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>`,
    },
    {
      id: 'profile',
      label: 'Profile',
      href: '#/profile',
      title: 'Profile',
      svg: `<svg class="sidebar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
    },
  ];

  // Nav items are fully user-reorderable, including Settings — no item
  // is pinned to a fixed position. Default order/visibility comes from
  // NAV_ITEMS above until the user drags something or hides a section.
  const NAV_ORDER_KEY = 'musikNavOrder';
  const NAV_HIDDEN_KEY = 'musikNavHidden';

  function getNavOrder() {
    const ids = NAV_ITEMS.map((i) => i.id);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || 'null'); } catch (_) {}
    if (!Array.isArray(saved)) return ids;
    const validSaved = saved.filter((id) => ids.includes(id));
    const missing = ids.filter((id) => !validSaved.includes(id)); // future-proofing if NAV_ITEMS grows
    return [...validSaved, ...missing];
  }
  function setNavOrder(order) {
    localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order));
  }
  function getNavHidden() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(NAV_HIDDEN_KEY) || 'null'); } catch (_) {}
    return Array.isArray(saved) ? saved : [];
  }
  function setNavHidden(hidden) {
    localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify(hidden));
  }

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function navLinkHTML(item) {
    if (item.action) {
      // Action items (currently just search) don't navigate, so they're
      // buttons, not anchors — same .nav-link class for shared styling.
      return `<button type="button" class="nav-link nav-link--action" data-view="${item.id}" data-action="${item.action}" title="${escapeHTML(item.title)}" draggable="true">${item.svg}<span class="nav-text">${escapeHTML(item.label)}</span><span class="nav-shortcut-hint">CTRL K</span></button>`;
    }
    return `<a class="nav-link" data-view="${item.id}" href="${item.href}" title="${escapeHTML(item.title)}" draggable="true">${item.svg}<span class="nav-text">${escapeHTML(item.label)}</span></a>`;
  }

  function hiddenToggleHTML(count) {
    if (!count) return '';
    return `<button class="nav-hidden-toggle" id="nav-hidden-toggle" title="Hidden sections">+${count} hidden</button>`;
  }

  function renderNavLinks() {
    const container = document.getElementById('nav-links');
    if (!container) return;

    const order = getNavOrder();
    const hidden = new Set(getNavHidden());
    const visibleItems = order
      .map((id) => NAV_ITEMS.find((i) => i.id === id))
      .filter(Boolean)
      .filter((i) => !hidden.has(i.id));

    container.innerHTML = visibleItems.map(navLinkHTML).join('') + hiddenToggleHTML(hidden.size);

    wireNavLinkDrag(container);
    wireNavLinkContextMenu();
    wireHiddenToggle();
    wireSearchTrigger(container);
    initNavIconKicks();
    setActiveNav(currentRoute().view);
    applyIconOnlyHintVisibility(getIconOnly());
  }

  // The search nav item is the only .nav-link with a 3rd child
  // (.nav-shortcut-hint, the "CTRL K" pill) alongside icon + .nav-text.
  // In icon-only mode this button needs explicit flex-centering to keep
  // its icon centered as a compact square — inline styles are cleared
  // back to '' when not collapsed so navigation.css's normal icon+label
  // row layout applies.
  function applyIconOnlySearchFix(iconOnly) {
    const btn = document.querySelector('.nav-link--action[data-action="open-search"]');
    if (!btn) return;
    btn.style.display = iconOnly ? 'flex' : '';
    btn.style.alignItems = iconOnly ? 'center' : '';
    btn.style.justifyContent = iconOnly ? 'center' : '';
  }

  function applyIconOnlyHintVisibility(iconOnly) {
    document.querySelectorAll('.nav-shortcut-hint').forEach((el) => {
      el.style.display = iconOnly ? 'none' : '';
    });
    applyIconOnlySearchFix(iconOnly);
  }

  // ── Search trigger ── opens the overlay in search.js, doesn't route
  function wireSearchTrigger(container) {
    const btn = container.querySelector('.nav-link--action[data-action="open-search"]');
    if (!btn) return;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.classList.remove('search-trigger-kick');
      void btn.offsetWidth;
      btn.classList.add('search-trigger-kick');
      setTimeout(() => btn.classList.remove('search-trigger-kick'), 200);
      window.MusikSearch?.open({ trigger: btn, originRect: btn.getBoundingClientRect() });
    });
  }

  // ── Drag-to-reorder ── native HTML5 drag-and-drop, no library.
  // Same before/after midpoint pattern as miniplayer-ui.js's queue
  // reorder — a single "highlight the target" class doesn't tell you
  // which side of it you'll land on, which is why this felt like it had
  // no UI at all.
  function wireNavLinkDrag(container) {
    let dragFromId = null;

    function clearDropIndicators() {
      container.querySelectorAll('.nav-link--drop-before, .nav-link--drop-after').forEach((el) => {
        el.classList.remove('nav-link--drop-before', 'nav-link--drop-after');
      });
    }

    container.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('dragstart', (e) => {
        dragFromId = link.dataset.view;
        link.classList.add('nav-link--dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragFromId); // Firefox needs a data payload to allow the drag
      });

      link.addEventListener('dragend', () => {
        link.classList.remove('nav-link--dragging');
        clearDropIndicators();
        dragFromId = null;
      });

      link.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragFromId || dragFromId === link.dataset.view) return;
        e.dataTransfer.dropEffect = 'move';

        // Topbar mode lays nav items out horizontally — split on X
        // instead of Y so the line lands on the correct side. (Sidebar
        // mode is the default/vertical case.)
        const rect = link.getBoundingClientRect();
        const isTopbar = document.body.classList.contains('layout-topbar');
        const before = isTopbar
          ? (e.clientX - rect.left) < rect.width / 2
          : (e.clientY - rect.top) < rect.height / 2;

        clearDropIndicators();
        link.classList.toggle('nav-link--drop-before', before);
        link.classList.toggle('nav-link--drop-after', !before);
      });

      link.addEventListener('dragleave', () => {
        link.classList.remove('nav-link--drop-before', 'nav-link--drop-after');
      });

      link.addEventListener('drop', (e) => {
        e.preventDefault();
        const before = link.classList.contains('nav-link--drop-before');
        clearDropIndicators();
        const toId = link.dataset.view;
        if (!dragFromId || dragFromId === toId) return;

        const order = getNavOrder();
        const fromIndex = order.indexOf(dragFromId);
        let toIndex = order.indexOf(toId);
        if (fromIndex === -1 || toIndex === -1) return;

        if (!before) toIndex += 1;
        order.splice(fromIndex, 1);
        // Removing the dragged item first shifts everything after it
        // down by one, so a target past the source needs adjusting —
        // same fix miniplayer-ui.js's queue reorder needed.
        if (fromIndex < toIndex) toIndex -= 1;
        order.splice(toIndex, 0, dragFromId);

        setNavOrder(order);
        renderNavLinks();
      });
    });
  }

  // ── Hide / restore sections ── right-click to hide (can't hide the
  // last visible item). Hidden ones surface via a "+N hidden" pill.
  let openNavMenuEl = null;

  function closeNavMenu() {
    if (openNavMenuEl) {
      openNavMenuEl.remove();
      openNavMenuEl = null;
    }
    document.removeEventListener('mousedown', onOutsideNavMenuClick, true);
    document.removeEventListener('keydown', onNavMenuKeydown, true);
  }
  function onOutsideNavMenuClick(e) {
    if (openNavMenuEl && !openNavMenuEl.contains(e.target)) closeNavMenu();
  }
  function onNavMenuKeydown(e) {
    if (e.key === 'Escape') closeNavMenu();
  }
  function armNavMenuClose() {
    setTimeout(() => {
      document.addEventListener('mousedown', onOutsideNavMenuClick, true);
      document.addEventListener('keydown', onNavMenuKeydown, true);
    }, 0);
  }
  function positionNavMenu(menu, x, y) {
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    menu.style.position = 'fixed';
    // #sidebar is z-index:10050 (navigation.css) — a plain position:fixed
    // menu with z-index:auto loses to that regardless of DOM order,
    // which is why this was opening behind the sidebar.
    menu.style.zIndex = '10100';
    menu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
    openNavMenuEl = menu;
    armNavMenuClose();
  }

  function wireNavLinkContextMenu() {
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showNavItemMenu(e.clientX, e.clientY, link.dataset.view);
      });
    });
  }

  function showNavItemMenu(x, y, id) {
    closeNavMenu();
    const item = NAV_ITEMS.find((i) => i.id === id);
    if (!item) return;

    const order = getNavOrder();
    const hidden = getNavHidden();
    const visibleCount = order.filter((i) => !hidden.includes(i)).length;
    const canHide = visibleCount > 1;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <div class="ctx-menu-label">${escapeHTML(item.label)}</div>
      <button class="ctx-menu-item" data-hide ${canHide ? '' : 'disabled'}>${canHide ? 'Hide from sidebar' : "Can't hide last section"}</button>
    `;
    positionNavMenu(menu, x, y);

    menu.querySelector('[data-hide]')?.addEventListener('click', () => {
      if (!canHide) return;
      setNavHidden([...getNavHidden(), id]);
      closeNavMenu();
      renderNavLinks();
    });
  }

  function wireHiddenToggle() {
    const btn = document.getElementById('nav-hidden-toggle');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showHiddenMenu(btn);
    });
  }

  function showHiddenMenu(anchorEl) {
    closeNavMenu();
    const hidden = getNavHidden();
    const items = hidden.map((id) => NAV_ITEMS.find((i) => i.id === id)).filter(Boolean);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu glass-surface--elevated';
    menu.innerHTML = `
      <div class="ctx-menu-label">Hidden Sections</div>
      ${items.length
        ? items.map((i) => `<button class="ctx-menu-item ctx-menu-item--new" data-restore="${escapeHTML(i.id)}">+ ${escapeHTML(i.label)}</button>`).join('')
        : `<div class="ctx-menu-empty">None</div>`}
    `;
    const rect = anchorEl.getBoundingClientRect();
    positionNavMenu(menu, rect.left, rect.bottom + 6);

    menu.querySelectorAll('[data-restore]').forEach((btn) => {
      btn.addEventListener('click', () => {
        setNavHidden(getNavHidden().filter((h) => h !== btn.dataset.restore));
        closeNavMenu();
        renderNavLinks();
      });
    });
  }

  // ── Icon-only collapse ── forces icon-only regardless of hover/pin
  const ICON_ONLY_KEY = 'musikSidebarIconOnly';

  function getIconOnly() {
    return localStorage.getItem(ICON_ONLY_KEY) === '1';
  }
  function setIconOnly(value) {
    localStorage.setItem(ICON_ONLY_KEY, value ? '1' : '0');
    document.body.classList.toggle('sidebar-icon-only', value);
    applyIconOnlyHintVisibility(value);
  }

  function initSidebarCollapse() {
    document.body.classList.toggle('sidebar-icon-only', getIconOnly());
    const btn = document.getElementById('sidebar-collapse-btn');
    if (!btn) return;
    btn.classList.toggle('is-active', getIconOnly());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !getIconOnly();
      setIconOnly(next);
      btn.classList.toggle('is-active', next);
    });
  }

  // Nav icon click-kick — same .icon-kick pattern as every other icon
  // bounce in the app (animations.css).
  function initNavIconKicks() {
    document.querySelectorAll('.nav-link').forEach((link) => {
      link.addEventListener('click', () => {
        link.classList.remove('icon-kick');
        void link.offsetWidth; // force reflow so re-adding replays the animation
        link.classList.add('icon-kick');
      });
      link.addEventListener('animationend', () => link.classList.remove('icon-kick'));
    });
  }

  // Wordmark click easter egg — shares confetti/colorway helpers below,
  // own click counter.
  function initWordmarkEgg() {
    const word = document.querySelector('.logo-text-wrap');
    const logo = document.getElementById('sidebar-logo');
    if (!word) return;

    const CLICK_KEY = 'wordmarkLogoClicks';
    let clickCount = parseInt(localStorage.getItem(CLICK_KEY) || '0', 10);

    word.addEventListener('click', () => {
      clickCount += 1;
      localStorage.setItem(CLICK_KEY, String(clickCount));

      word.classList.remove('egg-pop');
      void word.offsetWidth;
      word.classList.add('egg-pop');

      spawnLogoConfetti(word);

      if (logo && clickCount % 5 === 0) cycleLogoColorway(logo, clickCount / 5);
    });
    word.addEventListener('animationend', () => word.classList.remove('egg-pop'));
  }

  // Sidebar logo: playback-reactive glow + beat pulse + click easter egg.
  // Beat pulse reads player-ui.js's live AnalyserNode via getAnalyser().
  function initSidebarLogo() {
    const logo = document.getElementById('sidebar-logo');
    if (!logo || !window.Musik) return;

    // --- Idle glow: reflect current playback state -------------------
    window.Musik.events.on('play', () => logo.classList.add('is-playing'));
    window.Musik.events.on('pause', () => logo.classList.remove('is-playing'));
    window.Musik.player.getState().then((state) => {
      if (state && state.isPlaying) logo.classList.add('is-playing');
    }).catch(() => {});

    // --- Beat pulse: 5 bars, each its own frequency band -------------
    const VIZ_BARS = logo.querySelectorAll('.viz-bar');
    let beatDataArray = null;
    let beatRafId = null;
    let barLevels = new Array(VIZ_BARS.length).fill(0); // smoothed, persists across frames
    const BAND_EDGES = [0, 0.04, 0.1, 0.22, 0.4, 0.65]; // fraction of bin range, low->high
    const ATTACK = 0.9; // fast rise on transients
    const DECAY = 0.16; // slower fall so it doesn't flicker to zero

    function beatTick() {
      const analyser = window.MusikPlayerUI?.getAnalyser?.();
      const playing = !window.MusikPlayerUI?.isPaused?.();

      if (analyser && playing && VIZ_BARS.length) {
        if (!beatDataArray || beatDataArray.length !== analyser.frequencyBinCount) {
          beatDataArray = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(beatDataArray);

        const binCount = beatDataArray.length;
        let maxLevel = 0;

        VIZ_BARS.forEach((bar, i) => {
          const lo = Math.floor(BAND_EDGES[i] * binCount);
          const hi = Math.max(lo + 1, Math.floor(BAND_EDGES[i + 1] * binCount));
          let sum = 0;
          for (let b = lo; b < hi; b++) sum += beatDataArray[b];
          const rawLevel = sum / (hi - lo) / 255;

          const coeff = rawLevel > barLevels[i] ? ATTACK : DECAY;
          barLevels[i] += (rawLevel - barLevels[i]) * coeff;
          maxLevel = Math.max(maxLevel, barLevels[i]);

          const scale = 0.22 + barLevels[i] * 1.6; // floor keeps bars from flattening to zero
          bar.style.transform = `scaleY(${scale.toFixed(3)})`;
        });

        // Overall level still drives the glow intensity so the whole mark
        // brightens on peaks, on top of the per-bar EQ motion.
        logo.style.setProperty('--beat-scale', (maxLevel * 0.22).toFixed(3));
      } else {
        barLevels = barLevels.map(() => 0);
        VIZ_BARS.forEach((bar) => { bar.style.transform = 'scaleY(1)'; });
        logo.style.setProperty('--beat-scale', '0');
      }

      beatRafId = requestAnimationFrame(beatTick);
    }
    beatRafId = requestAnimationFrame(beatTick);

    // --- Click easter egg: confetti + secret shuffle every 5th click -
    const CLICK_KEY = 'sidebarLogoClicks';
    let clickCount = parseInt(localStorage.getItem(CLICK_KEY) || '0', 10);

    logo.addEventListener('click', () => {
      clickCount += 1;
      localStorage.setItem(CLICK_KEY, String(clickCount));

      logo.classList.add('egg-spin');
      setTimeout(() => logo.classList.remove('egg-spin'), 650);

      spawnLogoConfetti(logo);

      if (clickCount % 5 === 0) cycleLogoColorway(logo, clickCount / 5);
    });
  }

  // Colored squares flung outward from the logo's center, Web Animations
  // API (particle shape lives in layouts.css). Self-cleans up.
  function spawnLogoConfetti(logo) {
    const rect = logo.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#7dd3fc';
    const colors = [accent, '#ffffff', accent, '#ffd166'];
    const PARTICLE_COUNT = 10;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = document.createElement('div');
      p.className = 'logo-confetti-particle';
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      p.style.background = colors[i % colors.length];
      document.body.appendChild(p);

      const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.4;
      const distance = 34 + Math.random() * 26;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      const spin = (Math.random() - 0.5) * 360;

      const anim = p.animate(
        [
          { transform: 'translate(-50%, -50%) rotate(0deg) scale(1)', opacity: 1 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin}deg) scale(0.4)`,
            opacity: 0,
          },
        ],
        { duration: 550 + Math.random() * 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      );
      anim.onfinish = () => p.remove();
    }
  }

  // Every 5th click cycles the logo's glow through a hidden colorway.
  const LOGO_COLORWAY_HUES = [0, 45, 130, 200, 280];
  function cycleLogoColorway(logo, milestoneIndex) {
    const hue = LOGO_COLORWAY_HUES[milestoneIndex % LOGO_COLORWAY_HUES.length];
    logo.style.setProperty('--logo-hue', `${hue}deg`);
  }

  // Nav layout: dynamic (hover-overlay), pinned (locked expanded), or
  // topbar (sidebar flips to a horizontal bar). Source of truth:
  // 'musikLayoutMode' in localStorage, shared with settings.js.
  // Full topbar restyle lives in navigation.css (body.layout-topbar rules).
  const LAYOUT_KEY = 'musikLayoutMode';

  function migrateLegacyPinKey() {
    if (localStorage.getItem(LAYOUT_KEY)) return;
    if (localStorage.getItem('sidebarPinned') === '1') {
      localStorage.setItem(LAYOUT_KEY, 'pinned');
    }
  }

  function getLayoutMode() {
    return localStorage.getItem(LAYOUT_KEY) || 'dynamic';
  }

  function applyLayoutMode(mode) {
    document.body.classList.toggle('sidebar-pinned', mode === 'pinned');
    document.body.classList.toggle('layout-topbar', mode === 'topbar');
    const pinBtn = document.getElementById('sidebar-pin-btn');
    if (pinBtn) pinBtn.classList.toggle('is-pinned', mode === 'pinned');
  }

  function initSidebarLayout() {
    migrateLegacyPinKey();
    applyLayoutMode(getLayoutMode());

    // Quick toggle in the sidebar itself: flips between dynamic and
    // pinned only. Top-bar mode is deliberately settings-only since it's
    // a bigger structural change, not a one-click affordance.
    const pinBtn = document.getElementById('sidebar-pin-btn');
    if (pinBtn) {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = getLayoutMode() === 'pinned' ? 'dynamic' : 'pinned';
        localStorage.setItem(LAYOUT_KEY, next);
        applyLayoutMode(next);
      });
    }

    // Live-update if settings.js changes the mode while app.js is
    // already running (same window, no reload needed).
    window.addEventListener('musik:layout-change', (e) => {
      applyLayoutMode(e.detail?.mode || getLayoutMode());
    });
  }

  // Drag-resize for the sidebar's expanded width. Works whether the
  // expanded state came from hover or from being pinned, since both read
  // --sidebar-width-expanded. Width persists via localStorage.
  function initSidebarResize() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;

    const MIN_WIDTH = 180;
    const MAX_WIDTH = 320;

    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) document.documentElement.style.setProperty('--sidebar-width-expanded', savedWidth);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('is-dragging');
      document.body.classList.add('sidebar-resizing');

      const onMove = (moveEvent) => {
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, moveEvent.clientX - sidebar.getBoundingClientRect().left));
        document.documentElement.style.setProperty('--sidebar-width-expanded', `${newWidth}px`);
      };

      const onUp = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('sidebar-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const finalWidth = document.documentElement.style.getPropertyValue('--sidebar-width-expanded');
        if (finalWidth) localStorage.setItem('sidebarWidth', finalWidth.trim());
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSidebar();
    render();
    // Fire-and-forget: don't block first paint on an IPC round trip.
    window.MusikViews?.syncLastfmCredsToMain?.();
  });

  window.addEventListener('hashchange', render);
})();