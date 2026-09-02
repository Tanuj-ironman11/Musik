// src/ui/marquee.js
// Generic scrolling-text utility: any element with class "marquee" that
// overflows its own width gets its text wrapped into a duplicated,
// seamlessly-looping track and animated. Elements that fit do nothing.

(function () {
  const PX_PER_SECOND = 34;      // scroll speed
  const EDGE_PAUSE_MS = 900;     // pause at start before scrolling begins
  const GAP_PX = 48;             // gap between the looped copies

  const observedResize = new Set(); // elements already under ResizeObserver
  let ro = null;
  let mo = null;

  function getInnerText(el) {
    const inner = el.querySelector(':scope > .marquee-inner');
    return inner ? inner.textContent : el.textContent;
  }

  function isOverflowing(el, inner) {
    return inner.scrollWidth > el.clientWidth + 1;
  }

  function teardownAnimation(el) {
    const track = el.querySelector(':scope > .marquee-track');
    if (track) {
      track.getAnimations().forEach((a) => a.cancel());
    }
  }

  function attach(el) {
    if (!el || el.dataset.marqueeBound === '1') {
      if (el) refresh(el);
      return;
    }
    el.dataset.marqueeBound = '1';
    el.classList.add('marquee');
    refresh(el);

    if (!observedResize.has(el)) {
      observedResize.add(el);
      ro?.observe(el);
    }
  }

  function detach(el) {
    if (!el) return;
    teardownAnimation(el);
    const text = getInnerText(el);
    el.innerHTML = '';
    el.textContent = text;
    el.classList.remove('is-marquee-active');
    delete el.dataset.marqueeBound;
    observedResize.delete(el);
    ro?.unobserve(el);
  }

  function refresh(el) {
    if (!el || !el.isConnected) return;
    teardownAnimation(el);

    const text = getInnerText(el);
    el.innerHTML = '';
    el.classList.remove('is-marquee-active');

    const probe = document.createElement('span');
    probe.className = 'marquee-inner';
    probe.textContent = text;
    el.appendChild(probe);

    // Measure on next frame — layout must settle first (e.g. right after
    // a track change swaps in new text at a different width).
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (!isOverflowing(el, probe)) return; // fits — leave as plain static text

      const contentWidth = probe.scrollWidth;
      el.innerHTML = '';

      const track = document.createElement('span');
      track.className = 'marquee-track';
      track.style.setProperty('--marquee-gap', `${GAP_PX}px`);

      const copyA = document.createElement('span');
      copyA.className = 'marquee-inner';
      copyA.textContent = text;
      const copyB = document.createElement('span');
      copyB.className = 'marquee-inner';
      copyB.textContent = text;
      copyB.setAttribute('aria-hidden', 'true');

      track.appendChild(copyA);
      track.appendChild(copyB);
      el.appendChild(track);
      el.classList.add('is-marquee-active');

      const distance = contentWidth + GAP_PX;
      const duration = Math.max(3000, (distance / PX_PER_SECOND) * 1000);

      track.animate(
        [
          { transform: 'translateX(0)' },
          { transform: `translateX(-${distance}px)` },
        ],
        {
          duration,
          delay: EDGE_PAUSE_MS,
          iterations: Infinity,
          easing: 'linear',
        }
      );
    });
  }

  function scanAll(root = document) {
    root.querySelectorAll('.marquee').forEach(attach);
  }

  function initObservers() {
    if (typeof ResizeObserver !== 'undefined' && !ro) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) refresh(entry.target);
      });
    }
    if (typeof MutationObserver !== 'undefined' && !mo) {
      // Catches marquee elements added later by views that render after
      // this script loads (library rows, queue items, sidebar labels).
      mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            if (node.nodeType !== 1) return;
            if (node.classList?.contains('marquee')) attach(node);
            node.querySelectorAll?.('.marquee')?.forEach(attach);
          });
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  function init() {
    initObservers();
    scanAll();
  }

  document.addEventListener('DOMContentLoaded', init);

  window.MusikMarquee = { scanAll, attach, detach, refresh };
})();
