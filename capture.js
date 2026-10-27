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
      .layer.done .box { cursor: move; }
      .h { position: absolute; display: none; width: 16px; height: 16px; margin: -8px 0 0 -8px; }
      .h::after {
        content: ''; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px;
        transform: translate(-50%, -50%); background: #fff;
        border: 1px solid rgba(0, 0, 0, 0.6); border-radius: 2px;
      }
      .layer.done .h { display: block; }
      /* bordas inteiras arrastáveis; cantos por cima delas */
      .h[data-h="n"], .h[data-h="s"] { left: 0; width: 100%; margin-left: 0; cursor: ns-resize; }
      .h[data-h="e"], .h[data-h="w"] { top: 0; height: 100%; margin-top: 0; cursor: ew-resize; }
      .h[data-h="n"] { top: 0; }
      .h[data-h="s"] { top: 100%; }
      .h[data-h="e"] { left: 100%; }
      .h[data-h="w"] { left: 0; }
      .h[data-h="nw"], .h[data-h="ne"], .h[data-h="se"], .h[data-h="sw"] { z-index: 1; }
      .h[data-h="nw"] { left: 0; top: 0; cursor: nwse-resize; }
      .h[data-h="ne"] { left: 100%; top: 0; cursor: nesw-resize; }
      .h[data-h="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
      .h[data-h="sw"] { left: 0; top: 100%; cursor: nesw-resize; }
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
      <div class="hint"></div>
      <div class="box" hidden>
        <span class="size"></span>
        ${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<div class="h" data-h="${h}"></div>`).join('')}
      </div>
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

  // x/w em coordenadas da janela; y/h em coordenadas do documento (a seleção acompanha a rolagem)
  let drag = null; // { mode: 'new' | 'move' | alça (n, se, w…) }
  let rect = null;
  let mouse = null;
  let startScrollY = 0;
  let cropped = null; // canvas com a área recortada
  const HINT = 'Arraste para selecionar · encoste na borda para rolar a página · Esc cancela';
  const EDGE = 60; // px perto da borda que disparam a rolagem automática
  const MAX_PX = 30000; // altura máxima do canvas final

  function cleanup() {
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('mousemove', onMove, true);
    removeEventListener('mouseup', onUp, true);
    removeEventListener('scroll', onScroll, true);
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

  const docHeight = () => (document.scrollingElement || document.documentElement).scrollHeight;

  function drawBox() {
    Object.assign(box.style, {
      left: `${rect.x}px`,
      top: `${rect.y - scrollY}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    });
    size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
    // etiqueta de tamanho sempre visível, mesmo com a base da seleção fora da tela
    const bottom = rect.y - scrollY + rect.h;
    size.style.bottom = bottom > innerHeight - 4 ? `${bottom - innerHeight + 30}px` : '-24px';
  }

  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
  const fromEdges = (l, t, r, b) => ({ x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) });

  function updateRect() {
    const x = clamp(mouse.x, 0, innerWidth);
    const y = clamp(mouse.y + scrollY, 0, docHeight());
    if (drag.mode === 'new') {
      rect = fromEdges(drag.x, drag.y, x, y);
    } else if (drag.mode === 'move') {
      rect = { ...rect, x: clamp(x - drag.dx, 0, innerWidth - rect.w), y: clamp(y - drag.dy, 0, docHeight() - rect.h) };
    } else {
      let { l, t, r, b } = drag.edges;
      if (drag.mode.includes('w')) l = x;
      if (drag.mode.includes('e')) r = x;
      if (drag.mode.includes('n')) t = y;
      if (drag.mode.includes('s')) b = y;
      rect = fromEdges(l, t, r, b);
    }
    drawBox();
  }

  function reset() {
    rect = cropped = drag = null;
    box.hidden = bar.hidden = true;
    hint.hidden = false;
    hint.textContent = HINT;
    layer.classList.remove('has-box', 'done');
  }
  hint.textContent = HINT;

  // Rolagem automática enquanto arrasta perto da borda (mais rápida quanto mais perto)
  function autoScroll() {
    if (!drag) return;
    let dy = 0;
    if (mouse.y > innerHeight - EDGE) dy = Math.min(EDGE, mouse.y - (innerHeight - EDGE));
    else if (mouse.y < EDGE) dy = -Math.min(EDGE, EDGE - mouse.y);
    if (dy) scrollBy(0, Math.ceil(Math.abs(dy) / 2.5) * Math.sign(dy));
    requestAnimationFrame(autoScroll);
  }

  function onMove(e) {
    if (!drag) return;
    mouse = { x: e.clientX, y: e.clientY };
    updateRect();
  }

  function onScroll() {
    if (drag) updateRect();
    else if (rect && !box.hidden) drawBox();
  }

  async function onUp() {
    if (!drag) return;
    const { before } = drag;
    drag = null;
    removeEventListener('mousemove', onMove, true);
    removeEventListener('mouseup', onUp, true);
    if (rect.w < 5 || rect.h < 5) return reset();
    // clique sem arrastar: mantém o recorte já capturado
    if (before && ['x', 'y', 'w', 'h'].every((k) => before[k] === rect[k])) return void (bar.hidden = false);
    await captureRect();
  }

  // Arrastar: fora da seleção cria outra; dentro move; nas alças redimensiona
  layer.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || bar.contains(e.target)) return;
    e.preventDefault();
    mouse = { x: e.clientX, y: e.clientY };
    const x = e.clientX;
    const y = e.clientY + scrollY;
    const handle = e.target.closest('[data-h]')?.dataset.h;
    if (rect && layer.classList.contains('done') && (handle || box.contains(e.target))) {
      drag = handle
        ? { mode: handle, edges: { l: rect.x, t: rect.y, r: rect.x + rect.w, b: rect.y + rect.h } }
        : { mode: 'move', dx: x - rect.x, dy: y - rect.y };
      drag.before = { ...rect };
    } else {
      drag = { mode: 'new', x, y };
      layer.classList.remove('done');
    }
    startScrollY = scrollY;
    hint.hidden = bar.hidden = true;
    box.hidden = false;
    layer.classList.add('has-box');
    updateRect();
    // na janela (e não no overlay) para continuar recebendo eventos fora dela
    addEventListener('mousemove', onMove, true);
    addEventListener('mouseup', onUp, true);
    requestAnimationFrame(autoScroll);
  });
  addEventListener('scroll', onScroll, true);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function shoot() {
    await nextFrame();
    const res = await chrome.runtime.sendMessage({ type: 'capture-visible' }).catch((e) => ({ error: String(e.message || e) }));
    if (!res?.dataUrl) throw new Error(res?.error || 'erro desconhecido');
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    return img;
  }

  async function scrollToY(y) {
    scrollTo(scrollX, y);
    await nextFrame();
    return scrollY;
  }

  // Cabeçalhos fixos/sticky se repetiriam em cada trecho: some com eles após o 1º trecho
  function hideFixed() {
    const hidden = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el === host) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        hidden.push([el, el.style.visibility]);
        el.style.visibility = 'hidden';
      }
    }
    return () => hidden.forEach(([el, v]) => (el.style.visibility = v));
  }

  async function captureRect() {
    const endScrollY = scrollY;
    const vh = innerHeight;
    const top = rect.y;
    const bottom = rect.y + rect.h;
    let restoreFixed = () => {};
    let scale = 0;
    cropped = null;
    // esconde o overlay para ele não aparecer no print
    host.style.display = 'none';
    try {
      // 1º trecho: a tela onde a seleção começou, como o usuário a viu
      const paint = (img, sy, from, to) => {
        const a = Math.max(from, sy);
        const b = Math.min(to, sy + vh);
        if (b <= a) return;
        const ratio = img.naturalWidth / innerWidth;
        if (!cropped) {
          scale = Math.min(ratio, MAX_PX / rect.h);
          cropped = document.createElement('canvas');
          cropped.width = Math.round(rect.w * scale);
          cropped.height = Math.round(rect.h * scale);
        }
        cropped.getContext('2d').drawImage(
          img,
          rect.x * ratio, (a - sy) * ratio, rect.w * ratio, (b - a) * ratio,
          0, (a - top) * scale, rect.w * scale, (b - a) * scale
        );
      };
      const firstY = await scrollToY(startScrollY);
      paint(await shoot(), firstY, top, bottom);

      const above = [top, Math.min(bottom, firstY)];
      const below = [Math.max(top, firstY + vh), bottom];
      if (above[1] > above[0] || below[1] > below[0]) restoreFixed = hideFixed();
      for (const [from, to] of [above, below]) {
        for (let y = from; y < to; ) {
          await sleep(520); // o navegador permite ~2 capturas por segundo
          const sy = await scrollToY(y);
          paint(await shoot(), sy, y, to);
          if (sy + vh <= y) break; // não rolou mais (fim da página)
          y = sy + vh;
        }
      }
    } catch (e) {
      host.style.display = '';
      restoreFixed();
      hint.hidden = false;
      hint.textContent = `Não foi possível capturar: ${e.message || e}`;
      setTimeout(cleanup, 3000);
      return;
    }
    restoreFixed();
    await scrollToY(endScrollY);
    host.style.display = '';
    drawBox();

    layer.classList.add('done');
    bar.hidden = false;
    const barW = bar.offsetWidth;
    const barH = bar.offsetHeight;
    // abaixo da seleção; se não couber, acima; senão, dentro da parte visível dela
    const boxTop = rect.y - scrollY;
    const boxBottom = boxTop + rect.h;
    let barTop = boxBottom + 30;
    if (barTop + barH > innerHeight - 8) {
      barTop = boxTop - barH - 8 >= 8 ? boxTop - barH - 8 : Math.min(innerHeight - barH - 8, Math.max(8, boxBottom - barH - 8));
    }
    const left = Math.max(8, Math.min(rect.x + rect.w - barW, innerWidth - barW - 8));
    Object.assign(bar.style, { top: `${barTop}px`, left: `${left}px` });
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
