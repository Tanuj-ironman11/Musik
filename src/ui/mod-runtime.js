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
    return css.replace(/url\(\s*(['"]?)(https?:)?\/\/[^)]*\1\s*\)/gi, 'url()');
  }

  function handleInjectCss(css) {
    const target = document.getElementById(CSS_TARGET_ID);
    if (!target) {
      console.warn('[Musik] mod-runtime: #' + CSS_TARGET_ID + ' not found in DOM');
      return;
    }
    // Append rather than clobber — multiple mods may inject CSS independently.
    target.textContent += '\n' + sanitizeCss(css) + '\n';
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
    if (!targetSelector) return document.getElementById(MOD_ROOT_ID);
    // Mods only get to target inside #mod-root — never arbitrary app
    // chrome (sidebar, player bar, etc). Selector must resolve to a node
    // that IS #mod-root or a descendant of it.
    const modRoot = document.getElementById(MOD_ROOT_ID);
    if (!modRoot) return null;
    const candidate = modRoot.querySelector(targetSelector);
    return candidate || modRoot;
  }

  function handleInjectElement({ html, targetSelector } = {}) {
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

    const elementId = 'mod-el-' + nextElementId++;
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
  // Wire up to the shared event bus (see preload.js listeners map).
  // ---------------------------------------------------------------------
  window.Musik?.events?.on('inject-css', handleInjectCss);
  window.Musik?.events?.on('inject-element', handleInjectElement);
  window.Musik?.events?.on('remove-element', handleRemoveElement);
})();
