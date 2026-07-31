// src/ui/dialog.js
//
// Electron's renderer doesn't support window.prompt()/window.confirm() —
// calling either throws "is and will not be supported" instead of
// blocking. This is a same-shape async replacement: window.MusikDialog
// .prompt(message, defaultValue) -> Promise<string|null>
// .confirm(message) -> Promise<boolean>
//
// Styled to match the glass-card aesthetic used elsewhere (settings
// sections, playlist header) via the existing CSS variables, so it
// doesn't need its own stylesheet file — just this one <style> injected
// once on first use.

window.MusikDialog = (function () {
  let stylesInjected = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .musik-dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20000;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .musik-dialog-overlay--visible { opacity: 1; }

      .musik-dialog-card {
        width: min(360px, calc(100vw - 48px));
        background: color-mix(in srgb, var(--color-bg-surface) 92%, transparent);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md, 14px);
        padding: 20px 20px 16px;
        box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        transform: translateY(6px) scale(0.98);
        transition: transform 0.15s ease;
      }
      .musik-dialog-overlay--visible .musik-dialog-card {
        transform: translateY(0) scale(1);
      }

      .musik-dialog-message {
        font-size: 13px;
        color: var(--color-text);
        margin-bottom: 14px;
        line-height: 1.45;
      }

      .musik-dialog-input {
        width: 100%;
        box-sizing: border-box;
        background: color-mix(in srgb, var(--color-bg) 70%, transparent);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        color: var(--color-text);
        font-size: 13px;
        padding: 9px 11px;
        margin-bottom: 16px;
        outline: none;
        transition: border-color 0.15s ease;
      }
      .musik-dialog-input:focus {
        border-color: var(--color-accent);
      }

      .musik-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .musik-dialog-btn {
        padding: 7px 16px;
        border-radius: 999px;
        border: 1px solid var(--color-border);
        background: color-mix(in srgb, var(--color-bg-surface) 60%, transparent);
        color: var(--color-text);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s ease, border-color 0.15s ease;
      }
      .musik-dialog-btn:hover { transform: translateY(-1px); }
      .musik-dialog-btn--primary {
        background: var(--color-accent);
        border-color: var(--color-accent);
        color: var(--color-bg);
      }
      .musik-dialog-btn--danger {
        border-color: color-mix(in srgb, #df5b72 60%, var(--color-border));
        color: #df5b72;
      }
    `;
    document.head.appendChild(style);
  }

  function openOverlay(cardHTML) {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'musik-dialog-overlay';
    overlay.innerHTML = `<div class="musik-dialog-card">${cardHTML}</div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('musik-dialog-overlay--visible'));
    return overlay;
  }

  function closeOverlay(overlay) {
    overlay.classList.remove('musik-dialog-overlay--visible');
    setTimeout(() => overlay.remove(), 150);
  }

  function prompt(message, defaultValue = '') {
    return new Promise((resolve) => {
      const overlay = openOverlay(`
        <div class="musik-dialog-message"></div>
        <input class="musik-dialog-input" type="text" />
        <div class="musik-dialog-actions">
          <button class="musik-dialog-btn" data-action="cancel">Cancel</button>
          <button class="musik-dialog-btn musik-dialog-btn--primary" data-action="ok">OK</button>
        </div>
      `);

      const msgEl = overlay.querySelector('.musik-dialog-message');
      msgEl.textContent = message;
      const input = overlay.querySelector('.musik-dialog-input');
      input.value = defaultValue;

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        closeOverlay(overlay);
        resolve(value);
      };

      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
      overlay.querySelector('[data-action="ok"]').addEventListener('click', () => finish(input.value));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value);
        if (e.key === 'Escape') finish(null);
      });

      requestAnimationFrame(() => { input.focus(); input.select(); });
    });
  }

  function confirm(message) {
    return new Promise((resolve) => {
      const overlay = openOverlay(`
        <div class="musik-dialog-message"></div>
        <div class="musik-dialog-actions">
          <button class="musik-dialog-btn" data-action="cancel">Cancel</button>
          <button class="musik-dialog-btn musik-dialog-btn--danger" data-action="ok">Confirm</button>
        </div>
      `);

      overlay.querySelector('.musik-dialog-message').textContent = message;

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        closeOverlay(overlay);
        resolve(value);
      };

      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(false));
      overlay.querySelector('[data-action="ok"]').addEventListener('click', () => finish(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(false); }
      });
    });
  }

  return { prompt, confirm };
})();
