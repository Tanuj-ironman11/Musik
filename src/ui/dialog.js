// src/ui/dialog.js
//
// Electron's renderer doesn't support window.prompt()/window.confirm() —
// calling either throws "is and will not be supported" instead of
// blocking. This is a same-shape async replacement:
//   window.MusikDialog
//     .prompt(message, defaultValue)  -> Promise<string|null>
//     .confirm(title, opts?)          -> Promise<boolean>
//     .alert(title, opts?)            -> Promise<void>
//
// confirm/alert opts (all optional):
//   detail       — one dimmer line under the title (what actually happens)
//   confirmLabel — primary button text (confirm: "Confirm", alert: "OK")
//   cancelLabel  — confirm only, default "Cancel"
//   danger       — confirm only, default true. Red primary; false = accent.
//   defaultFocus — confirm only, 'confirm' (default) or 'cancel'. Enter
//                  activates the focused button; use 'cancel' for wipes.
// A bare confirm('some sentence') still works exactly as before.
//
// Styled to match the glass-card aesthetic used elsewhere (settings
// sections, playlist header) via the existing CSS variables, so it
// doesn't need its own stylesheet file — just this one <style> injected
// once on first use.

window.MusikDialog = (function () {
  let stylesInjected = false;

  // Waveform mark, same idea as the sidebar logo.
  const MARK = `<svg class="musik-dialog-mark" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8.5 6v12M13 3v18M17.5 7v10M21 10v4"/></svg>`;

  const keycap = (text) => `<kbd class="musik-dialog-key">${text}</kbd>`;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .musik-dialog-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 20000;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .musik-dialog-overlay--visible { opacity: 1; }

      .musik-dialog-card {
        --musik-danger: var(--color-danger, #df5b72);
        width: min(400px, calc(100vw - 48px));
        background: color-mix(in srgb, var(--color-accent) 5%, color-mix(in srgb, var(--color-bg-surface) 94%, transparent));
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md, 14px);
        padding: 22px 22px 18px;
        box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        transform: translateY(6px) scale(0.98);
        transition: transform 0.22s var(--ease-spring, ease);
      }
      .musik-dialog-overlay--visible .musik-dialog-card {
        transform: translateY(0) scale(1);
      }

      .musik-dialog-mark {
        display: block;
        color: var(--color-accent);
        margin-bottom: 18px;
      }

      .musik-dialog-title {
        font-size: 16px;
        font-weight: 600;
        line-height: 1.35;
        color: var(--color-text);
        margin-bottom: 6px;
      }

      .musik-dialog-detail {
        font-size: 13px;
        line-height: 1.5;
        color: var(--color-text-secondary);
      }

      /* prompt() keeps its original single-message layout */
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
        margin-top: 22px;
      }
      .musik-dialog-input + .musik-dialog-actions { margin-top: 0; }

      .musik-dialog-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 36px;
        padding: 0 14px;
        border-radius: 9px;
        border: none;
        background: rgba(255, 255, 255, 0.06);
        color: var(--color-text);
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s ease, transform 0.15s ease;
      }
      .musik-dialog-btn:hover { background: rgba(255, 255, 255, 0.1); }
      .musik-dialog-btn:active { transform: scale(0.98); }
      .musik-dialog-btn:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }

      .musik-dialog-btn--primary {
        background: var(--color-accent);
        color: var(--color-bg);
      }
      .musik-dialog-btn--primary:hover {
        background: color-mix(in srgb, var(--color-accent) 88%, #fff);
      }

      .musik-dialog-btn--danger {
        background: var(--musik-danger);
        color: #1c0a0e;
      }
      .musik-dialog-btn--danger:hover {
        background: color-mix(in srgb, var(--musik-danger) 88%, #fff);
      }

      .musik-dialog-key {
        font: inherit;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        padding: 2px 6px;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.08);
        color: var(--color-text-secondary);
      }
      .musik-dialog-btn--primary .musik-dialog-key,
      .musik-dialog-btn--danger .musik-dialog-key {
        background: rgba(0, 0, 0, 0.16);
        color: inherit;
        opacity: 0.75;
      }
    `;
    document.head.appendChild(style);
  }

  function openOverlay(cardHTML) {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'musik-dialog-overlay';
    overlay.innerHTML = `<div class="musik-dialog-card" role="dialog" aria-modal="true">${cardHTML}</div>`;
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

  // Shared by confirm() and alert(): mark, title, optional detail, buttons.
  function choice(title, opts, cancellable) {
    const {
      detail = '',
      confirmLabel = cancellable ? 'Confirm' : 'OK',
      cancelLabel = 'Cancel',
      danger = cancellable,
      defaultFocus = 'confirm',
    } = opts || {};
    const confirmIsDefault = !cancellable || defaultFocus !== 'cancel';

    return new Promise((resolve) => {
      const overlay = openOverlay(`
        ${MARK}
        <div class="musik-dialog-title"></div>
        ${detail ? '<div class="musik-dialog-detail"></div>' : ''}
        <div class="musik-dialog-actions">
          ${cancellable ? `<button class="musik-dialog-btn" data-action="cancel"><span></span>${keycap('Esc')}</button>` : ''}
          <button class="musik-dialog-btn ${danger ? 'musik-dialog-btn--danger' : 'musik-dialog-btn--primary'}" data-action="ok"><span></span>${confirmIsDefault ? keycap('Enter') : ''}</button>
        </div>
      `);

      overlay.querySelector('.musik-dialog-title').textContent = title;
      if (detail) overlay.querySelector('.musik-dialog-detail').textContent = detail;
      overlay.querySelector('[data-action="ok"] span').textContent = confirmLabel;
      if (cancellable) overlay.querySelector('[data-action="cancel"] span').textContent = cancelLabel;

      const okBtn = overlay.querySelector('[data-action="ok"]');
      const cancelBtn = overlay.querySelector('[data-action="cancel"]');
      const buttons = [cancelBtn, okBtn].filter(Boolean);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        closeOverlay(overlay);
        resolve(value);
      };

      // Capture phase + stopPropagation so Space/F/etc. don't reach the
      // app's global shortcuts while a dialog is up.
      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(cancellable ? false : undefined);
        } else if (e.key === 'Enter' || (e.key === ' ' && buttons.includes(document.activeElement))) {
          e.preventDefault();
          e.stopPropagation();
          const target = buttons.includes(document.activeElement)
            ? document.activeElement
            : (confirmIsDefault ? okBtn : cancelBtn);
          target.click();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          const i = buttons.indexOf(document.activeElement);
          buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
        }
      }
      document.addEventListener('keydown', onKey, true);

      okBtn.addEventListener('click', () => finish(cancellable ? true : undefined));
      cancelBtn?.addEventListener('click', () => finish(false));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) finish(cancellable ? false : undefined);
      });

      requestAnimationFrame(() => (confirmIsDefault ? okBtn : cancelBtn).focus());
    });
  }

  const confirm = (title, opts) => choice(title, opts, true);
  const alert = (title, opts) => choice(title, opts, false);

  return { prompt, confirm, alert };
})();
