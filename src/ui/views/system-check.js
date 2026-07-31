// src/ui/views/system-check.js
//
// The old boot-check content, moved off the homepage into its own route
// at #/system-check. Same functionality as before (bridge checks, pick
// file, play/pause, now-playing readout) — just no longer squatting on
// the home view.

window.MusikViews = window.MusikViews || {};

window.MusikViews['system-check'] = function renderSystemCheck(main) {
  const musikOk = typeof window.Musik !== 'undefined';
  const aureliusOk = typeof window.Aurelius !== 'undefined';
  const playerOk = typeof window.MusikPlayerUI !== 'undefined';

  function statusRow(label, ok) {
    return `
      <div style="display:flex; align-items:center; gap:10px; padding:4px 0;">
        <span style="width:7px; height:7px; border-radius:50%;
          background:${ok ? 'var(--color-accent)' : 'var(--color-danger)'};
          box-shadow:${ok ? '0 0 6px var(--color-accent-glow)' : '0 0 6px rgba(var(--color-danger-rgb),0.4)'};
          flex-shrink:0;"></span>
        <span style="font-family:var(--font-mono); font-size:11px; letter-spacing:0.04em;
          color:var(--color-text-secondary); text-transform:uppercase;">${label}</span>
        <span style="font-family:var(--font-mono); font-size:11px; font-weight:700;
          color:${ok ? 'var(--color-accent)' : 'var(--color-danger)'}; margin-left:auto;">
          ${ok ? 'OK' : 'MISSING'}
        </span>
      </div>
    `;
  }

  main.innerHTML = `
    <div style="max-width: 560px; margin: 64px auto; padding: 0 32px; color: var(--color-text);">
      <h1 style="font-family: var(--font-display); font-size: var(--font-size-xl);
        letter-spacing: -0.5px; margin-bottom: 4px;">Musik</h1>
      <p style="font-family: var(--font-mono); font-size: var(--font-size-xs);
        color: var(--color-text-dim); letter-spacing: 0.08em; text-transform: uppercase;
        margin-bottom: 28px;">System check</p>

      <div style="background: var(--color-bg-surface); border: 1px solid var(--color-border);
        border-radius: var(--radius-md); padding: 18px 20px; margin-bottom: 24px;">
        ${statusRow('window.Musik bridge', musikOk)}
        ${statusRow('window.Aurelius bridge', aureliusOk)}
        ${statusRow('player-ui', playerOk)}
      </div>

      <div style="display: flex; gap: 10px; margin-bottom: 20px;">
        <button id="pick-folder-btn" class="btn btn-primary">Pick music file(s)</button>
        <button id="play-pause-btn" class="btn">Play / Pause</button>
      </div>

      <pre id="scan-result" style="font-family: var(--font-mono); font-size: 11px;
        color: var(--color-text-dim); background: var(--color-bg-inset);
        border: 1px solid var(--color-border); border-radius: var(--radius-sm);
        padding: 12px 14px; margin-top: 4px; white-space: pre-wrap; min-height: 18px;"></pre>

      <p id="now-playing" style="font-family: var(--font-mono); font-size: 12px;
        color: var(--color-accent); margin-top: 14px;"></p>
    </div>
  `;

  document.getElementById('pick-folder-btn').addEventListener('click', async () => {
    const paths = await window.Musik.dialog.openFile();
    document.getElementById('scan-result').textContent = JSON.stringify(paths, null, 2);
    if (paths && paths.length && window.MusikPlayerUI) {
      await window.MusikPlayerUI.playFiles(paths);
    }
  });

  document.getElementById('play-pause-btn').addEventListener('click', () => {
    window.MusikPlayerUI?.togglePlayPause();
  });

  window.Musik?.events?.on('trackupdate', (track) => {
    const el = document.getElementById('now-playing');
    if (el && track) el.textContent = `Now playing: ${track.artist} — ${track.title}`;
  });
};
