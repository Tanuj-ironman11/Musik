// src/ui/mod-runtime.js
//
// Renderer-side consumer for mod-driven UI injection. main.js broadcasts
// 'inject-css' / 'inject-element' / 'remove-element' over the musik:event
// channel (see ui:inject-css / ui:inject-element handlers in main.js) —
// this is the file that actually catches them and touches the DOM.
//
// Security note: this is the ONE place raw strings from a mod become real
// DOM/CSSOM. Everything here must stay sanitized. Do not add a second
// consumer elsewhere — one injection point, one place to audit.

(function () {
  const CSS_TARGET_ID = 'mod-css-injection-point';
  const MOD_ROOT_ID = 'mod-root';

  // elementId (as returned to the mod) -> live DOM node, so
  // ui:remove-element can find what it's removing.
  const injectedElements = new Map();
  let nextElementId = 1;

  // ---------------------------------------------------------------------
  // CSS injection — textContent only, never innerHTML, so a <style> block
  // can't smuggle executable markup. Still strip url(...) that points off
  // -machine (data:/relative/local file: OK, remote http(s) blocked) since
  // CSS can exfiltrate via background-image / @font-face pings.
  // ---------------------------------------------------------------------
  function sanitizeCss(css) {
    if (typeof css !== 'string') return '';
    return css
      .replace(/@import\s+[^;]+;/gi, '') // Block remote @import sheets
      .replace(/url\(\s*(['"]?)(https?:)?\/\/[^)]*\1\s*\)/gi, 'url()');
  }

  function handleInjectCss(payload) {
    const rawCss = typeof payload === 'string' ? payload : payload?.css;
    const cleanCss = sanitizeCss(rawCss);
    if (!cleanCss) return;

    const target = document.getElementById(CSS_TARGET_ID);
    if (target) {
      target.textContent += '\n' + cleanCss + '\n';
    }
  }

  function handleRemoveCss(modId) {
    if (!modId) return;
    document.getElementById('mod-css-' + modId)?.remove();
  }

  // ---------------------------------------------------------------------
  // Element injection — DOMPurify strips executable content (script tags,
  // event-handler attributes, javascript: URLs, etc.) before anything
  // touches the live DOM.
  // ---------------------------------------------------------------------
  const purifyConfig = {
    // Belt-and-suspenders on top of DOMPurify's own script/handler
    // stripping: explicitly forbid tags/attrs with no legitimate use in a
    // mod's injected fragment.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    FORBID_ATTR: ['srcdoc'],
  };

  function sanitizeHtml(html) {
    if (typeof html !== 'string') return '';
    if (!window.DOMPurify) {
      console.error('[Musik] mod-runtime: DOMPurify not loaded, refusing to inject unsanitized HTML');
      return '';
    }
    return window.DOMPurify.sanitize(html, purifyConfig);
  }

  function resolveTarget(targetSelector) {
    const modRoot = document.getElementById(MOD_ROOT_ID);
    if (!modRoot) return null;
    if (!targetSelector) return modRoot;

    try {
      return modRoot.querySelector(targetSelector) || null;
    } catch (err) {
      console.warn('[Musik] Invalid CSS selector:', targetSelector);
      return null;
    }
  }

  function handleInjectElement({ html, targetSelector, id } = {}) {
    const target = resolveTarget(targetSelector);
    if (!target) {
      console.warn('[Musik] mod-runtime: injection target not found for selector', targetSelector);
      return null;
    }

    const clean = sanitizeHtml(html);
    if (!clean) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'mod-injected-element';
    wrapper.innerHTML = clean; // safe: `clean` is DOMPurify output, not raw mod input

    // NEW — optional mod-supplied id turns injection into an upsert: the same
    // id replaces the previous node, and removeElement(id) works without the
    // mod ever needing a return value (the event bus drops it). Ids shaped
    // like the auto ones (mod-el-N) are rejected so a mod can't collide with
    // or remove another element's auto id.
    const validId = typeof id === 'string' && /^[\w:.-]{1,64}$/.test(id) && !/^mod-el-\d+$/.test(id);
    const elementId = validId ? id : 'mod-el-' + nextElementId++;
    if (injectedElements.has(elementId)) handleRemoveElement(elementId);
    wrapper.dataset.modElementId = elementId;

    target.appendChild(wrapper);
    injectedElements.set(elementId, wrapper);
    return elementId;
  }

  function handleRemoveElement(elementId) {
    const el = injectedElements.get(elementId);
    if (!el) return false;
    el.remove();
    injectedElements.delete(elementId);
    return true;
  }

  // ---------------------------------------------------------------------
  // NEW — return channel. DOMPurify strips inline handlers, so injected HTML
  // can't react to the user on its own. Mods mark elements with
  // data-mod-action="<name>" and this ONE delegated listener forwards the
  // interaction over the events bus as 'mod-ui-event'. Payload is plain data
  // only (strings/booleans) — never DOM nodes.
  //   click on  [data-mod-action]        -> fires (inputs/selects/textareas excluded)
  //   Enter in  input[data-mod-action]   -> fires
  // `fields` = name -> value for every named input/select/textarea inside the
  // nearest [data-mod-scope] (falling back to the injected wrapper), so an
  // action carries the current form state with it.
  // ---------------------------------------------------------------------
  function collectFields(fromEl) {
    const scope = fromEl.closest('[data-mod-scope]') || fromEl.closest('.mod-injected-element');
    const fields = {};
    if (!scope) return fields;
    scope.querySelectorAll('input[name], select[name], textarea[name]').forEach((f) => {
      fields[f.name] = f.type === 'checkbox' ? f.checked : f.value;
    });
    return fields;
  }

  function forwardModEvent(actionEl) {
    const modRoot = document.getElementById(MOD_ROOT_ID);
    if (!modRoot || !modRoot.contains(actionEl)) return;
    const wrapper = actionEl.closest('.mod-injected-element');
    window.Musik?.events?.emit?.('mod-ui-event', {
      action: actionEl.dataset.modAction,
      data: { ...actionEl.dataset },
      fields: collectFields(actionEl),
      elementId: wrapper?.dataset.modElementId ?? null,
    });
  }

  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-mod-action]');
    if (el && !el.matches('input, textarea, select')) forwardModEvent(el);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target?.closest?.('input[data-mod-action]');
    if (el) forwardModEvent(el);
  });

  // ---------------------------------------------------------------------
  // Wire up to the shared event bus (see preload.js listeners map).
  // ---------------------------------------------------------------------
  window.Musik?.events?.on('inject-css', handleInjectCss);
  window.Musik?.events?.on('remove-css', handleRemoveCss);
  window.Musik?.events?.on('inject-element', handleInjectElement);
  window.Musik?.events?.on('remove-element', handleRemoveElement);
})();
