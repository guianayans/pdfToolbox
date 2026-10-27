// Seleção de área (estilo Cmd+Shift+4): injetado sob demanda pelo background.
(() => {
  if (window.__pdfToolboxSelect) return;
  window.__pdfToolboxSelect = true;

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(0, 0, 0, 0.25); }
      .layer.has-box { background: transparent; }
      .layer.done { cursor: default; }
      .hint {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        background: rgba(20, 20, 24, 0.9); color: #fff; padding: 8px 14px; border-radius: 8px;
        pointer-events: none;
      }
      .box {
        position: fixed; border: 1.5px solid #fff; outline: 1px dashed rgba(0, 0, 0, 0.6);
        box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.45);
      }
      .size {
        position: absolute; right: 0; bottom: -24px; background: rgba(20, 20, 24, 0.9); color: #fff;
        padding: 2px 6px; border-radius: 4px; font-size: 11px; white-space: nowrap;
      }
      .bar {
        position: fixed; display: flex; gap: 4px; padding: 5px; border-radius: 10px;
        background: rgba(20, 20, 24, 0.95); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      }
      .bar button {
        border: 0; border-radius: 6px; padding: 7px 11px; cursor: pointer;
        background: rgba(255, 255, 255, 0.1); color: #fff; font-weight: 600;
      }
      .bar button:hover { background: #e5322d; }
      .bar button.ghost { background: transparent; font-weight: 400; }
      .bar button.ghost:hover { background: rgba(255, 255, 255, 0.15); }
      [hidden] { display: none !important; }
    </style>
    <div class="layer">
      <div class="hint">Arraste para selecionar a área · Esc cancela</div>
      <div class="box" hidden><span class="size"></span></div>
      <div class="bar" hidden>
        <button data-act="png">PNG</button>
        <button data-act="jpg">JPG</button>
        <button data-act="pdf">PDF</button>
        <button data-act="copy">Copiar</button>
        <button data-act="redo" class="ghost" title="Selecionar de novo">Refazer</button>
        <button data-act="close" class="ghost" title="Cancelar (Esc)">✕</button>
      </div>
    </div>`;
  document.documentElement.append(host);

  const layer = root.querySelector('.layer');
  const hint = root.querySelector('.hint');
  const box = root.querySelector('.box');
  const size = root.querySelector('.size');
  const bar = root.querySelector('.bar');

  let start = null;
  let rect = null;
  let cropped = null; // canvas com a área recortada

  function cleanup() {
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    delete window.__pdfToolboxSelect;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }
  document.addEventListener('keydown', onKey, true);

  function drawBox() {
    Object.assign(box.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  }

  function reset() {
    rect = cropped = null;
    box.hidden = bar.hidden = true;
    hint.hidden = false;
    hint.textContent = 'Arraste para selecionar a área · Esc cancela';
    layer.classList.remove('has-box', 'done');
  }

  layer.addEventListener('mousedown', (e) => {
    if (layer.classList.contains('done') || e.button !== 0) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    rect = { x: start.x, y: start.y, w: 0, h: 0 };
    hint.hidden = true;
    box.hidden = false;
    layer.classList.add('has-box');
    drawBox();
  });

  layer.addEventListener('mousemove', (e) => {
    if (!start) return;
    const x = Math.max(0, Math.min(e.clientX, innerWidth));
    const y = Math.max(0, Math.min(e.clientY, innerHeight));
    rect = { x: Math.min(x, start.x), y: Math.min(y, start.y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
    drawBox();
  });

  layer.addEventListener('mouseup', async () => {
    if (!start) return;
    start = null;
    if (rect.w < 5 || rect.h < 5) return reset();
    await captureRect();
  });

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function captureRect() {
    // esconde o overlay para ele não aparecer no print
    host.style.display = 'none';
    await nextFrame();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'capture-visible' });
    } catch (e) {
      res = { error: String(e.message || e) };
    }
    host.style.display = '';
    if (!res?.dataUrl) {
      hint.hidden = false;
      hint.textContent = `Não foi possível capturar: ${res?.error || 'erro desconhecido'}`;
      setTimeout(cleanup, 3000);
      return;
    }

    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    const ratio = img.naturalWidth / innerWidth;
    cropped = document.createElement('canvas');
    cropped.width = Math.round(rect.w * ratio);
    cropped.height = Math.round(rect.h * ratio);
    cropped.getContext('2d').drawImage(img, rect.x * ratio, rect.y * ratio, rect.w * ratio, rect.h * ratio, 0, 0, cropped.width, cropped.height);

    layer.classList.add('done');
    bar.hidden = false;
    const barW = bar.offsetWidth;
    const barH = bar.offsetHeight;
    // abaixo da seleção; se não couber, acima; senão, dentro dela
    let top = rect.y + rect.h + 30;
    if (top + barH > innerHeight - 8) top = rect.y - barH - 8 >= 8 ? rect.y - barH - 8 : rect.y + 8;
    const left = Math.max(8, Math.min(rect.x + rect.w - barW, innerWidth - barW - 8));
    Object.assign(bar.style, { top: `${top}px`, left: `${left}px` });
  }

  function flash(msg) {
    bar.hidden = true;
    hint.hidden = false;
    hint.textContent = msg;
    setTimeout(cleanup, 1200);
  }

  bar.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') return cleanup();
    if (act === 'redo') return reset();

    if (act === 'copy') {
      try {
        const blob = await new Promise((ok) => cropped.toBlob(ok, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flash('Copiado para a área de transferência ✓');
      } catch {
        flash('Este site não permite copiar. Use PNG para salvar.');
      }
      return;
    }

    const dataUrl = act === 'jpg' ? cropped.toDataURL('image/jpeg', 0.92) : cropped.toDataURL('image/png');
    const res = await chrome.runtime
      .sendMessage({ type: 'save-crop', format: act, dataUrl, width: rect.w, height: rect.h, title: document.title })
      .catch((err) => ({ error: String(err.message || err) }));
    flash(res?.error ? `Erro: ${res.error}` : 'Salvo ✓');
  });
})();
