// src/ui/views/settings.js
// Settings view. Helpers and prefs are in prefs.js (load it first).

window.MusikViews = window.MusikViews || {};

// Settings re-renders on every visit, so document/window listeners would stack up.
// This controller is aborted at the top of each render to tear the old ones down.
let settingsViewAbortController = null;

window.MusikViews['settings'] = async function renderSettings(main) {
  settingsViewAbortController?.abort();
  settingsViewAbortController = new AbortController();
  const { signal } = settingsViewAbortController;

  const duckSettings = (await window.Musik?.gameDuck?.getSettings?.()) ?? { available: false, enabled: false, sensitivity: 0.5, duckCeiling: 0.4, maxDuck: 0.6, preset: 'gaming' };
  const duckAdvancedOpen = localStorage.getItem('musik.duck.advanced') === '1';
  const scrobblerSettings = (await window.Musik?.scrobble?.getSettings?.()) ?? { connected: false, username: null, enabled: true, usingCustomApiKey: false, lastScrobbleAt: null };

  main.innerHTML = settingsHTML(duckSettings, scrobblerSettings, duckAdvancedOpen);

  const volumeSlider = document.getElementById('settings-default-volume');
  const volumeValue = document.getElementById('settings-default-volume-value');
  bindRangeValueDisplay(volumeSlider, volumeValue, (value) => {
    localStorage.setItem(DEFAULT_VOLUME_KEY, String(Number(value) / 100));
    window.MusikPlayerUI?.setVolume?.(Number(value) / 100);
  });

  document.getElementById('settings-open-system-check').addEventListener('click', () => {
    location.hash = '#/system-check';
  });

  document.getElementById('settings-mini-always-on-top').addEventListener('change', (e) => {
    localStorage.setItem(MINI_ALWAYS_ON_TOP_KEY, String(e.target.checked));
    window.Musik?.miniplayer?.setAlwaysOnTop?.(e.target.checked);
  });

  const settingsPage = main.querySelector('.settings-page');
  const sectionRail = settingsPage?.querySelector('.settings-section-rail');
  const backToTop = settingsPage?.querySelector('.settings-back-to-top');
  const sectionDots = [...(sectionRail?.querySelectorAll('.settings-section-dot') ?? [])];
  const navigableSections = sectionDots
    .map((dot) => document.getElementById(dot.dataset.target))
    .filter(Boolean);

  // A dot click pins its section as active. Sections near the bottom can't
  // scroll up to the threshold (page runs out), so scroll position alone would
  // never light them. The pin drops as soon as the user scrolls by hand.
  let pinnedId = null;

  const paintSectionRail = () => {
    const mainTop = main.getBoundingClientRect().top;
    const threshold = mainTop + 120;
    const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 4;
    let currentId = pinnedId;
    if (!currentId) {
      let current = navigableSections[0];
      let prevTop = null;
      for (const section of navigableSections) {
        const top = section.getBoundingClientRect().top;
        // Side-by-side cards share a top edge - first one in the row owns the scroll position.
        const sameRow = prevTop !== null && Math.abs(top - prevTop) < 4;
        if (!sameRow && top <= threshold) current = section;
        prevTop = top;
      }
      if (atBottom) current = navigableSections[navigableSections.length - 1];
      currentId = current?.id;
    }
    sectionDots.forEach((dot) => {
      dot.classList.toggle('is-active', dot.dataset.target === currentId);
    });
    backToTop?.classList.toggle('is-visible', main.scrollTop > 420);
  };

  const releasePin = () => { if (pinnedId) { pinnedId = null; paintSectionRail(); } };
  main.addEventListener('wheel', releasePin, { signal, passive: true });
  main.addEventListener('touchmove', releasePin, { signal, passive: true });
  main.addEventListener('pointerdown', (e) => { if (e.target === main) releasePin(); }, { signal });
  document.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) releasePin();
  }, { signal });

  sectionDots.forEach((dot) => {
    dot.addEventListener('click', () => {
      pinnedId = dot.dataset.target;
      paintSectionRail();
      document.getElementById(pinnedId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, { signal });
  });
  main.addEventListener('scroll', paintSectionRail, { signal, passive: true });
  backToTop?.addEventListener('click', () => {
    main.scrollTo({ top: 0, behavior: 'smooth' });
  }, { signal });
  paintSectionRail();

  // Feeds the hover spotlight in settings.css (.settings-section::after).
  settingsPage?.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.settings-section');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { signal, passive: true });

  const viewToggle = document.getElementById('settings-view-toggle');
  viewToggle?.addEventListener('click', (e) => {
    const opt = e.target.closest('.settings-view-opt');
    if (!opt) return;
    const compact = opt.dataset.compact === 'true';
    if (compact === (viewToggle.dataset.compact === 'true')) return;

    localStorage.setItem(COMPACT_SETTINGS_KEY, compact ? 'on' : 'off');
    settingsPage?.classList.toggle('settings-page--compact', compact);
    viewToggle.dataset.compact = String(compact);
    viewToggle.querySelectorAll('.settings-view-opt').forEach((o) => {
      o.setAttribute('aria-pressed', String(o === opt));
    });

    // Restart the click-kick on the thumb + the newly selected icon.
    for (const el of [viewToggle.querySelector('.settings-view-toggle-thumb'), opt.querySelector('.settings-view-icon')]) {
      el.classList.remove('is-kick');
      void el.getBoundingClientRect();
      el.classList.add('is-kick');
      el.addEventListener('animationend', () => el.classList.remove('is-kick'), { once: true });
    }
  }, { signal });

  const rescanIntervalSelect = document.getElementById('settings-rescan-interval');
  const rescanNowBtn = document.getElementById('settings-rescan-now');
  const rescanStatus = document.getElementById('settings-rescan-status');

  const rescanIntervalCustomSelect = initCustomSelect(rescanIntervalSelect, (value) => {
    window.Musik?.library?.setRescanInterval?.(Number(value));
  });

  window.Musik?.library?.getRescanSettings?.().then((settings) => {
    rescanIntervalCustomSelect?.setValue(String(settings?.intervalMinutes ?? 0));
  });

  rescanNowBtn?.addEventListener('click', async () => {
    rescanNowBtn.disabled = true;
    rescanStatus.textContent = 'Scanning…';
    try {
      await window.Musik?.library?.rescanAll?.();
      rescanStatus.textContent = 'Done';
    } catch (err) {
      rescanStatus.textContent = 'Failed';
      console.warn('[Musik] rescan failed:', err);
    } finally {
      rescanNowBtn.disabled = false;
      setTimeout(() => { rescanStatus.textContent = ''; }, 3000);
    }
  });

  // Demo reset - wipes tracks, playlists and watched folders (never files on
  // disk). Backend: library.clear -> 'library:clear', which also broadcasts
  // libraryupdate { cleared: true } so open views refresh themselves.
  const libraryResetBtn = document.getElementById('settings-library-reset');
  const libraryResetStatus = document.getElementById('settings-library-reset-status');
  libraryResetBtn?.addEventListener('click', async () => {
    if (typeof window.Musik?.library?.clear !== 'function') {
      libraryResetStatus.textContent = 'Unavailable';
      return;
    }
    const ok = await window.MusikDialog?.confirm?.('Reset your library?', {
      detail: 'This removes every track, playlist and watched folder from Musik. Your audio files stay on your computer.',
      confirmLabel: 'Reset',
      defaultFocus: 'cancel',
    });
    if (!ok) return;
    libraryResetBtn.disabled = true;
    libraryResetStatus.textContent = 'Resetting…';
    try {
      const done = await window.Musik.library.clear();
      libraryResetStatus.textContent = done ? 'Library cleared' : 'Failed';
    } catch (err) {
      libraryResetStatus.textContent = 'Failed';
      console.warn('[Musik] library reset failed:', err);
    } finally {
      libraryResetBtn.disabled = false;
      setTimeout(() => { libraryResetStatus.textContent = ''; }, 3000);
    }
  });

  const searchHistoryClearBtn = document.getElementById('settings-search-history-clear');
  const searchHistoryStatus = document.getElementById('settings-search-history-status');
  if (window.MusikSearch?.clearHistory) {
    searchHistoryClearBtn.addEventListener('click', () => {
      window.MusikSearch.clearHistory();
      searchHistoryStatus.textContent = 'Cleared';
      setTimeout(() => { searchHistoryStatus.textContent = ''; }, 3000);
    }, { signal });
  } else {
    searchHistoryClearBtn.closest('.settings-row').hidden = true;
  }

  const visQualitySelect = document.getElementById('settings-vis-quality');

  const visQualityCustomSelect = initCustomSelect(visQualitySelect, (value) => {
    localStorage.setItem(VIS_QUALITY_KEY, value);
    window.MusikVisualizer?.setQuality?.(value);
    broadcastVisualizerChange({ quality: value });
  });
  visQualityCustomSelect?.setValue(window.MusikVisualizer?.getQuality?.() ?? getVisQuality());

  const sensSlider2 = document.getElementById('settings-vis-sensitivity');
  const sensValue2 = document.getElementById('settings-vis-sensitivity-value');
  bindRangeValueDisplay(sensSlider2, sensValue2, (value) => {
    localStorage.setItem(VIS_SENSITIVITY_KEY, String(Number(value) / 100));
  });

  const customFxCheckbox = document.getElementById('settings-vis-customfx');
  const fresnelCheckbox = document.getElementById('settings-vis-fresnel');
  const ditherCheckbox = document.getElementById('settings-vis-dither');
  const fresnelRow = document.getElementById('settings-vis-fresnel-row');
  const ditherRow = document.getElementById('settings-vis-dither-row');

  const paintSubFxState = (on) => {
    [fresnelCheckbox, ditherCheckbox].forEach((cb) => { if (cb) cb.disabled = !on; });
    [fresnelRow, ditherRow].forEach((row) => row?.classList.toggle('settings-row--sub-disabled', !on));
  };
  paintSubFxState(getCustomFxOn());

  customFxCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(CUSTOM_FX_KEY, on ? 'on' : 'off');
    paintSubFxState(on);
    window.MusikVisualizer?.setCustomFx?.(on);
    broadcastVisualizerChange({ customFx: on });
  });

  fresnelCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(FRESNEL_KEY, on ? 'on' : 'off');
    window.MusikVisualizer?.setFresnel?.(on);
    broadcastVisualizerChange({ fresnel: on });
  });

  ditherCheckbox?.addEventListener('change', (e) => {
    const on = e.target.checked;
    localStorage.setItem(DITHER_KEY, on ? 'on' : 'off');
    window.MusikVisualizer?.setDither?.(on);
    broadcastVisualizerChange({ dither: on });
  });

  // ── Equalizer ─────────────────────────────────────────────────────────
  // window.MusikEQ (eq.js) owns state/persistence/live-node wiring; this
  // block only renders and reads/writes through its API.

  const eqModeSelect = document.getElementById('settings-eq-mode');
  const eqAdvancedCountRow = document.getElementById('settings-eq-advanced-count-row');
  const eqAdvancedCountSelect = document.getElementById('settings-eq-advanced-count');
  const eqPresetsRow = document.getElementById('settings-eq-presets-row');
  const eqPresetsWrap = document.getElementById('settings-eq-presets');
  const eqBandsRow = document.getElementById('settings-eq-bands-row');
  const eqBandsWrap = document.getElementById('settings-eq-bands');

  // Minimal, self-contained wiring for the app's existing .custom-select
  // component (styled in tokens.css, previously unused by any JS) - click
  // trigger to open, click an option to pick it, click outside to close.
  function initCustomSelect(root, onChange) {
    if (!root) return null;
    const trigger = root.querySelector('.custom-select-trigger');
    const label = root.querySelector('.custom-select-trigger-label');
    const optionsPanel = root.querySelector('.custom-select-options');
    const options = root.querySelectorAll('.custom-option');

    // .settings-section's backdrop-filter traps an absolute panel in its own stacking
    // context, so the panel moves to <body> and is fixed-positioned off the trigger.
    optionsPanel.classList.add('custom-select-options--portal');
    document.body.appendChild(optionsPanel);
    // It's now a body-level child, not a descendant of main - the next
    // render's main.innerHTML wipe won't remove it. Clean it up ourselves
    // when this render's lifetime ends.
    signal.addEventListener('abort', () => optionsPanel.remove());

    function positionPanel() {
      const rect = trigger.getBoundingClientRect();
      optionsPanel.style.left = `${rect.left}px`;
      optionsPanel.style.top = `${rect.bottom + 6}px`;
      optionsPanel.style.width = `${rect.width}px`;
    }

    function onScroll() {
      if (root.classList.contains('open')) close();
    }

    function close() {
      root.classList.remove('open');
      optionsPanel.classList.remove('is-open');
      window.removeEventListener('scroll', onScroll, true);
    }

    // Shared by setValue() and the option click handler so the trigger label and
    // .selected state update on user clicks too.
    function applySelection(value) {
      let match = null;
      options.forEach((o) => {
        const isMatch = o.dataset.value === String(value);
        o.classList.toggle('selected', isMatch);
        if (isMatch) match = o;
      });
      if (label && match) label.textContent = match.textContent;
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !root.classList.contains('open');
      // Close any other open portaled select first - otherwise clicking
      // straight from one trigger to another leaves both panels open,
      // since stopPropagation() here skips the document click-close.
      document.querySelectorAll('.custom-select-options--portal.is-open').forEach((p) => p.classList.remove('is-open'));
      document.querySelectorAll('.custom-select.open').forEach((r) => r.classList.remove('open'));
      if (opening) {
        positionPanel();
        root.classList.add('open');
        optionsPanel.classList.add('is-open');
        window.addEventListener('scroll', onScroll, { capture: true, signal });
      }
    }, { signal });
    options.forEach((opt) => {
      opt.addEventListener('click', () => {
        close();
        applySelection(opt.dataset.value);
        onChange(opt.dataset.value);
      }, { signal });
    });
    document.addEventListener('click', close, { signal });
    window.addEventListener('resize', () => { if (root.classList.contains('open')) positionPanel(); }, { signal });

    return {
      setValue: applySelection,
    };
  }

  const eqModeCustomSelect = initCustomSelect(eqModeSelect, (value) => window.MusikEQ?.setMode(value));
  const eqAdvancedCountCustomSelect = initCustomSelect(eqAdvancedCountSelect, (value) => window.MusikEQ?.setBandCount('advanced', Number(value)));

  // Percent-based math against each rail's own rect, not a hardcoded
  // pixel height, so this stays correct if .eq-band-rail's height changes.

  function gainToTopPercent(dB) {
    return (1 - (dB + 12) / 24) * 100; // -12dB -> 100% (bottom), +12dB -> 0% (top)
  }

  // Redraws the connecting curve from live DOM thumb positions - turns
  // separate sliders into one continuous shape. Cheap enough for every
  // drag tick (no re-render, just path-string math).
  function updateEqCurve(consoleEl) {
    const svg = consoleEl.querySelector('.eq-console-curve');
    if (!svg) return;
    const bandEls = Array.from(consoleEl.querySelectorAll('.eq-band'));
    if (bandEls.length < 2) { svg.innerHTML = ''; return; }

    const consoleRect = consoleEl.getBoundingClientRect();

    // The rail's own rect is the exact 0dB reference and the bottom edge the fill stops at.
    const centerline = consoleEl.querySelector('.eq-console-centerline');
    const railRect = bandEls[0].querySelector('.eq-band-rail').getBoundingClientRect();
    const railBottomY = railRect.bottom - consoleRect.top;
    if (centerline) {
      const railMidY = railRect.top + railRect.height / 2 - consoleRect.top;
      centerline.style.top = `${railMidY}px`;
    }

    const points = bandEls.map((el) => {
      const thumb = el.querySelector('.eq-band-thumb');
      const r = thumb.getBoundingClientRect();
      return [r.left + r.width / 2 - consoleRect.left, r.top + r.height / 2 - consoleRect.top];
    });

    svg.setAttribute('viewBox', `0 0 ${consoleRect.width} ${consoleRect.height}`);

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const bottom = railBottomY;
    const fillPath = `M${points[0][0].toFixed(1)},${bottom} ` +
      points.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') +
      ` L${points[points.length - 1][0].toFixed(1)},${bottom} Z`;

    svg.innerHTML = `
      <defs>
        <linearGradient id="eq-fill-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color:var(--color-accent); stop-opacity:0.28" />
          <stop offset="100%" style="stop-color:var(--color-accent); stop-opacity:0" />
        </linearGradient>
      </defs>
      <path class="eq-console-curve-fill" d="${fillPath}" fill="url(#eq-fill-fade)"></path>
      <path class="eq-console-curve-line" d="${linePath}"></path>
    `;
  }

  function attachFaderDrag(bandEl, bandIndex, consoleEl) {
    const rail = bandEl.querySelector('.eq-band-rail');
    const thumb = bandEl.querySelector('.eq-band-thumb');
    const valueEl = bandEl.querySelector('.eq-band-gain-value');

    function applyFromClientY(clientY) {
      const rect = rail.getBoundingClientRect();
      let frac = 1 - (clientY - rect.top) / rect.height; // 1 = top = +12dB, 0 = bottom = -12dB
      frac = Math.max(0, Math.min(1, frac));
      const dB = Math.round((frac * 24 - 12) * 10) / 10; // continuous 0.1dB resolution, no native-slider snapping
      const applied = window.MusikEQ.previewBandGain(bandIndex, dB);
      thumb.style.top = `${gainToTopPercent(applied)}%`;
      valueEl.value = applied;
      updateEqCurve(consoleEl);
      return applied;
    }

    function onPointerMove(e) { applyFromClientY(e.clientY); }

    function onPointerUp(e) {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      thumb.classList.remove('eq-band-thumb--dragging');
      // Commit once at drag end - persists + broadcasts musik:eq-change.
      const finalDb = applyFromClientY(e.clientY);
      window.MusikEQ.commitBandGain(bandIndex, finalDb);
    }

    function onPointerDown(e) {
      e.preventDefault();
      thumb.classList.add('eq-band-thumb--dragging');
      applyFromClientY(e.clientY);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
    }

    thumb.addEventListener('pointerdown', onPointerDown);
    rail.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return; // thumb has its own handler
      onPointerDown(e);
    });
  }

  function renderEqSection() {
    if (!window.MusikEQ) return;
    const state = window.MusikEQ.getState();

    eqModeCustomSelect?.setValue(state.mode);
    eqAdvancedCountCustomSelect?.setValue(String(state.advancedBands));

    eqAdvancedCountRow.style.display = state.mode === 'advanced' ? '' : 'none';
    eqPresetsRow.style.display = state.mode === 'off' ? 'none' : '';
    eqBandsRow.style.display = state.mode === 'off' ? 'none' : '';

    if (state.mode === 'off') return;

    eqPresetsWrap.innerHTML = window.MusikEQ.listPresets().map((p) => `
      <button type="button" class="eq-preset-btn ${state.lastPreset === p.id ? 'eq-preset-btn--active' : ''}" data-preset-id="${p.id}">
        <span class="eq-preset-btn-spark">${p.sparkline}</span>
        <span class="eq-preset-btn-label">${p.label}</span>
      </button>
    `).join('');
    eqPresetsWrap.querySelectorAll('.eq-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => window.MusikEQ.applyPreset(btn.dataset.presetId));
    });

    const indices = window.MusikEQ.getVisibleIndices();
    const labels = window.MusikEQ.getBandLabels();
    const editableFreqQ = state.mode === 'master';

    // One shared glass panel with one centerline + curve overlay, instead
    // of each band being its own isolated box.
    eqBandsWrap.innerHTML = `
      <div class="eq-console" id="eq-console">
        <div class="eq-console-centerline"></div>
        <svg class="eq-console-curve" preserveAspectRatio="none"></svg>
        <div class="eq-console-bands">
          ${indices.map((bandIndex, i) => {
            const band = state.bands[bandIndex];
            return `
              <div class="eq-band" data-band-index="${bandIndex}">
                <span class="eq-band-label">${labels[i]}</span>
                <div class="eq-band-rail">
                  <div class="eq-band-thumb" style="top:${gainToTopPercent(band.gain)}%"></div>
                </div>
                <span class="eq-band-gain-field">
                  <input type="number" class="eq-band-gain-value" min="-12" max="12" step="0.1" value="${band.gain}" aria-label="Gain in decibels" />
                  <span class="eq-band-gain-unit">dB</span>
                </span>
                ${editableFreqQ ? `
                  <label class="eq-band-subfield">Hz <input type="number" class="eq-band-freq" min="20" max="20000" step="1" value="${Math.round(band.freq)}" /></label>
                  <label class="eq-band-subfield">Q <input type="number" class="eq-band-q" min="0.1" max="10" step="0.1" value="${band.q}" /></label>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    const consoleEl = document.getElementById('eq-console');
    const commitOnEnter = (e) => { if (e.key === 'Enter') e.target.blur(); };

    consoleEl.querySelectorAll('.eq-band').forEach((el) => {
      const idx = Number(el.dataset.bandIndex);
      attachFaderDrag(el, idx, consoleEl);
      el.querySelector('.eq-band-gain-value')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandGain(idx, Number(e.target.value));
      });
      el.querySelector('.eq-band-freq')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandFreq(idx, Number(e.target.value));
      });
      el.querySelector('.eq-band-q')?.addEventListener('change', (e) => {
        window.MusikEQ.setBandQ(idx, Number(e.target.value));
      });
      el.querySelectorAll('.eq-band-gain-value, .eq-band-freq, .eq-band-q').forEach((input) => {
        input.addEventListener('keydown', commitOnEnter);
      });
    });
    updateEqCurve(consoleEl);
  }

  // Presets/mode/band-count changes funnel through this event so the UI
  // never drifts from real state. Drag-in-progress updates don't - see
  // previewBandGain in eq.js.
  window.addEventListener('musik:eq-change', renderEqSection, { signal });
  renderEqSection();

  const navGrid = document.getElementById('layout-nav-grid');

  function paintNavActive() {
    const current = getLayoutMode();
    navGrid.querySelectorAll('.layout-card').forEach((card) => {
      card.classList.toggle('layout-card--active', card.dataset.navMode === current);
    });
  }
  paintNavActive();

  navGrid.querySelectorAll('.layout-card').forEach((card) => {
    card.addEventListener('click', () => {
      localStorage.setItem(LAYOUT_MODE_KEY, card.dataset.navMode);
      paintNavActive();
      broadcastLayoutChange();
    });
  });

  if (duckSettings.available) {
    document.getElementById('settings-duck-enabled').addEventListener('change', (e) => {
      window.Musik?.gameDuck?.setEnabled?.(e.target.checked);
    });

    const DUCK_PRESET_DESCS = {
      gaming: 'Follows game audio. Quick to duck, holds through short gaps.',
      meetings: 'Ducks hard and fast when someone talks, holds through pauses.',
      movies: 'Rides along with the audio, no hold.',
      custom: 'Uses the sliders under Advanced.',
    };
    const presetBtns = document.querySelectorAll('#settings-duck-presets [data-duck-preset]');
    const presetDesc = document.getElementById('settings-duck-preset-desc');
    const paintDuckPreset = (name) => {
      presetBtns.forEach((b) => {
        const on = b.dataset.duckPreset === name;
        b.classList.toggle('segmented-btn--active', on);
        b.setAttribute('aria-pressed', on);
      });
      if (presetDesc) presetDesc.textContent = DUCK_PRESET_DESCS[name] || '';
    };
    paintDuckPreset(duckSettings.preset || 'gaming');
    presetBtns.forEach((b) => b.addEventListener('click', () => {
      paintDuckPreset(b.dataset.duckPreset);
      window.Musik?.gameDuck?.setPreset?.(b.dataset.duckPreset);
    }));

    const advToggle = document.getElementById('settings-duck-advanced-toggle');
    advToggle.addEventListener('click', () => {
      const open = advToggle.getAttribute('aria-pressed') !== 'true';
      advToggle.setAttribute('aria-pressed', open);
      advToggle.textContent = open ? 'Hide' : 'Show';
      document.querySelectorAll('.settings-duck-adv').forEach((r) => { r.style.display = open ? '' : 'none'; });
      localStorage.setItem('musik.duck.advanced', open ? '1' : '0');
    });

    const sensSlider = document.getElementById('settings-duck-sensitivity');
    const sensValue = document.getElementById('settings-duck-sensitivity-value');
    bindRangeValueDisplay(sensSlider, sensValue, (value) => {
      paintDuckPreset('custom');
      window.Musik?.gameDuck?.setSensitivity?.(Number(value) / 100);
    });

    const ceilingSlider = document.getElementById('settings-duck-ceiling');
    const ceilingValue = document.getElementById('settings-duck-ceiling-value');
    bindRangeValueDisplay(ceilingSlider, ceilingValue, (value) => {
      paintDuckPreset('custom');
      window.Musik?.gameDuck?.setDuckCeiling?.(Number(value) / 100);
    });

    const maxSlider = document.getElementById('settings-duck-max');
    const maxValue = document.getElementById('settings-duck-max-value');
    bindRangeValueDisplay(maxSlider, maxValue, (value) => {
      paintDuckPreset('custom');
      window.Musik?.gameDuck?.setMaxDuck?.(Number(value) / 100);
    });

    // 'duckdebug' - main.js/game-duck.js don't emit this yet; row stays at "-" until they do.
    // window.Musik.events is a custom bus, not a native EventTarget, so it
    // can't take an AbortSignal directly - remove it by hand on teardown.
    const meterLevel = document.getElementById('settings-duck-meter-level');
    const meterMult = document.getElementById('settings-duck-meter-mult');
    const onDuckDebug = ({ level, smoothed }) => {
      if (meterLevel) meterLevel.textContent = `level: ${Math.round(level * 100)}%`;
      if (meterMult) meterMult.textContent = `volume: ${Math.round(smoothed * 100)}%`;
    };
    window.Musik?.events?.on?.('duckdebug', onDuckDebug);
    signal.addEventListener('abort', () => window.Musik?.events?.off?.('duckdebug', onDuckDebug));
  }

  const searchShortcutBtn = document.getElementById('settings-search-shortcut');
  const searchShortcutReset = document.getElementById('settings-search-shortcut-reset');
  const searchShortcutDesc = document.getElementById('settings-search-shortcut-desc');
  if (window.MusikSearch?.getShortcutLabel) {
    const SHORTCUT_HINT = searchShortcutDesc.textContent;
    const SHORTCUT_ERRORS = {
      'needs-modifier': 'Add Ctrl, Cmd or Alt so it doesn\'t fire while you type.',
      invalid: 'That key can\'t be used.',
    };
    const paintShortcut = () => { searchShortcutBtn.textContent = window.MusikSearch.getShortcutLabel(); };
    paintShortcut();

    searchShortcutBtn.addEventListener('click', async () => {
      searchShortcutBtn.textContent = 'Press keys…';
      searchShortcutDesc.textContent = 'Esc to cancel.';
      const result = await window.MusikSearch.captureShortcut((partial) => {
        searchShortcutBtn.textContent = partial || 'Press keys\u2026';
      });
      paintShortcut();
      searchShortcutDesc.textContent = result.reason === 'conflict'
        ? `Conflicts with ${result.label}. Pick another.`
        : SHORTCUT_ERRORS[result.reason] || SHORTCUT_HINT;
    }, { signal });

    searchShortcutReset.addEventListener('click', () => {
      window.MusikSearch.resetShortcut();
      paintShortcut();
      searchShortcutDesc.textContent = SHORTCUT_HINT;
    }, { signal });

    // Leaving Settings mid-capture shouldn't leave a key grab running.
    signal.addEventListener('abort', () => window.MusikSearch?.cancelShortcutCapture?.());
  } else {
    searchShortcutBtn.closest('.settings-row').hidden = true;
  }

  await refreshModsList();
  document.getElementById('settings-mods-rescan').addEventListener('click', refreshModsList);
  document.getElementById('settings-mods-open-folder').addEventListener('click', () => {
    window.Musik?.mods?.openFolder?.();
  });

  await syncLastfmCredsToMain();
  bindLastfmSection(main);
};
