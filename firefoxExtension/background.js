// Service worker: coleta PDFs e documentos Word detectados por aba, atualiza o badge e faz o ícone piscar.
// Também captura a página (PDF/PNG/área selecionada) quando não há PDF para salvar.

// no Firefox o background é uma página de eventos e o manifest já carrega a lib
if (typeof importScripts === 'function') importScripts('lib/pdf-lib.min.js');

const ICON_NORMAL = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
const ICON_ALERT = { 16: 'icons/alert16.png', 32: 'icons/alert32.png' };
const MAX_ITEMS = 200;

const key = (tabId) => `tab_${tabId}`;

async function getItems(tabId) {
  const k = key(tabId);
  return (await chrome.storage.session.get(k))[k] || [];
}

// Serializa escritas por aba para evitar condições de corrida.
const queues = new Map();
function enqueue(tabId, fn) {
  const next = (queues.get(tabId) || Promise.resolve()).then(fn).catch(console.error);
  queues.set(tabId, next);
  return next;
}

function addItems(tabId, items) {
  if (tabId == null || tabId < 0 || !items.length) return;
  return enqueue(tabId, async () => {
    const current = await getItems(tabId);
    const known = new Set(current.map((i) => i.url));
    const fresh = items.filter((i) => i.url && !known.has(i.url) && known.add(i.url));
    // arquivo em blob: detectado antes de o nome ser conhecido: atualiza o nome
    let renamed = false;
    for (const c of current) {
      const i = c.rename && items.find((n) => n.url === c.url && !n.rename);
      if (!i) continue;
      Object.assign(c, { name: i.name, rename: false });
      renamed = true;
    }
    if (!fresh.length) {
      if (renamed) await chrome.storage.session.set({ [key(tabId)]: current });
      return;
    }
    const all = current.concat(fresh.map((i) => ({ ...i, ts: Date.now() }))).slice(-MAX_ITEMS);
    await chrome.storage.session.set({ [key(tabId)]: all });
    await updateBadge(tabId, all.length);
    blink(tabId);
  });
}

// O tabId pode não ser uma aba real (páginas pré-carregadas pelo navegador) ou a aba pode
// ter sido fechada. chrome.action.setIcon reporta isso como "Unchecked runtime.lastError"
// mesmo com .catch(), então as chamadas usam callback e leem lastError.
function actionCall(method, details) {
  return new Promise((resolve) => {
    if (!chrome.action[method]) return resolve(false);
    chrome.action[method](details, () => resolve(!chrome.runtime.lastError));
  });
}

const tabExists = (tabId) => chrome.tabs.get(tabId).then(() => true, () => false);

async function updateBadge(tabId, count) {
  if (!(await tabExists(tabId))) return;
  await actionCall('setBadgeText', { tabId, text: count ? String(count) : '' });
  await actionCall('setBadgeBackgroundColor', { tabId, color: '#E5322D' });
  await actionCall('setBadgeTextColor', { tabId, color: '#FFFFFF' });
}

const blinkers = new Map();
function stopBlink(tabId, resetIcon = true) {
  clearInterval(blinkers.get(tabId));
  blinkers.delete(tabId);
  if (!resetIcon) return;
  actionCall('setIcon', { tabId, path: ICON_NORMAL });
  actionCall('setBadgeBackgroundColor', { tabId, color: '#E5322D' });
}

async function blink(tabId) {
  stopBlink(tabId, false);
  if (!(await tabExists(tabId))) return;
  clearInterval(blinkers.get(tabId)); // outra chamada pode ter começado durante o await
  let on = false;
  let ticks = 0;
  const timer = setInterval(async () => {
    on = !on;
    if (!(await actionCall('setIcon', { tabId, path: on ? ICON_ALERT : ICON_NORMAL }))) return stopBlink(tabId, false);
    actionCall('setBadgeBackgroundColor', { tabId, color: on ? '#FFAA00' : '#E5322D' });
    if (++ticks >= 20) stopBlink(tabId);
  }, 450);
  blinkers.set(tabId, timer);
}

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return decodeURIComponent(last) || 'documento';
  } catch {
    return 'documento';
  }
}

const WORD_TYPE = /application\/(msword|vnd\.openxmlformats-officedocument\.wordprocessingml)/i;

// Respostas de rede com Content-Type PDF ou Word (abas, iframes, XHR, downloads).
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    let type = '';
    let disposition = '';
    for (const h of d.responseHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === 'content-type') type = h.value || '';
      else if (n === 'content-disposition') disposition = h.value || '';
    }
    const fname = filenameFromDisposition(disposition);
    let kind = null;
    if (/application\/(x-)?pdf/i.test(type) || /\.pdf$/i.test(fname || '')) kind = 'pdf';
    else if (WORD_TYPE.test(type) || /\.docx?$/i.test(fname || '')) kind = 'word';
    if (!kind) return;
    let name = fname || filenameFromUrl(d.url);
    if (kind === 'pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
    if (kind === 'word' && !/\.docx?$/i.test(name)) name += /msword/i.test(type) ? '.doc' : '.docx';
    addItems(d.tabId, [{ url: d.url, name, source: 'rede', frameId: d.frameId, kind }]);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Nova página carregada na aba: descarta a lista antiga (mantém o próprio documento, se for PDF).
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  enqueue(d.tabId, async () => {
    const kept = (await getItems(d.tabId)).filter((i) => i.url === d.url);
    await chrome.storage.session.set({ [key(d.tabId)]: kept });
    await updateBadge(d.tabId, kept.length);
  });
});

// Página pré-carregada ativada: o navegador troca o tabId, então a lista acompanha.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  stopBlink(removedTabId, false);
  enqueue(addedTabId, async () => {
    const items = await getItems(removedTabId);
    await chrome.storage.session.remove(key(removedTabId));
    if (!items.length) return;
    await chrome.storage.session.set({ [key(addedTabId)]: items });
    await updateBadge(addedTabId, items.length);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopBlink(tabId, false);
  chrome.storage.session.remove(key(tabId));
});

// ---------- Captura da página ----------
function safeName(title) {
  return (title || 'pagina').replace(/[\\/:*?"<>|~]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'pagina';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

// O Firefox não baixa URLs data:, só blob: (no service worker do Chrome não existe createObjectURL)
async function download(url, filename) {
  if (!url.startsWith('data:') || typeof URL.createObjectURL !== 'function') {
    return chrome.downloads.download({ url, filename });
  }
  const blobUrl = URL.createObjectURL(await (await fetch(url)).blob());
  try {
    return await chrome.downloads.download({ url: blobUrl, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
}

const MAX_SHOT = 16000; // limite prático de altura/largura de uma captura em pixels

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const blobToDataUrl = async (blob) => `data:${blob.type};base64,${bufferToBase64(await blob.arrayBuffer())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// captureVisibleTab tem limite de ~2 chamadas/s; tenta de novo se estourar
async function captureTab(windowId) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      if (i >= 4 || !/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(e.message))) throw e;
      await sleep(600);
    }
  }
}

async function inTab(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// ---- funções executadas dentro da página (serializadas pelo executeScript) ----

// Acha o que rola: a janela ou, em apps como o Gmail, o painel que rola por dentro.
// Marca o painel com data-pdf-toolbox-scroller e diz se ele existe.
function findScroller() {
  for (const old of document.querySelectorAll('[data-pdf-toolbox-scroller]')) delete old.dataset.pdfToolboxScroller;
  const root = document.scrollingElement || document.documentElement;
  if (root.scrollHeight - root.clientHeight > 50) return false;
  let best = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.scrollHeight - el.clientHeight < 50 || el.clientHeight < innerHeight * 0.3) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (area > bestArea) (bestArea = area), (best = el);
  }
  if (best) best.dataset.pdfToolboxScroller = '';
  return !!best;
}

function preparePage() {
  const el = document.querySelector('[data-pdf-toolbox-scroller]');
  const root = document.scrollingElement || document.documentElement;
  // sem rolagem suave (a posição só mudaria depois da animação) nem transições
  const style = document.createElement('style');
  style.id = 'pdf-toolbox-freeze';
  style.textContent = 'html, body, [data-pdf-toolbox-scroller] { scroll-behavior: auto !important; } *, *::before, *::after { transition: none !important; }';
  document.documentElement.append(style);
  for (const img of document.querySelectorAll('img[loading="lazy"]')) img.loading = 'eager';
  let box = { x: 0, y: 0, w: root.clientWidth, h: innerHeight }; // clientWidth corta a barra de rolagem
  if (el) {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left + el.clientLeft);
    const y = Math.max(0, r.top + el.clientTop);
    box = { x, y, w: Math.min(el.clientWidth, innerWidth - x), h: Math.min(el.clientHeight, innerHeight - y) };
  }
  return { vw: innerWidth, box, inner: !!el, total: (el || root).scrollHeight, startY: el ? el.scrollTop : scrollY };
}

// Rola até `top`, conclui animações de entrada e espera as imagens visíveis carregarem.
async function scrollStep(top) {
  const el = document.querySelector('[data-pdf-toolbox-scroller]');
  const root = el || document.scrollingElement || document.documentElement;
  if (el) el.scrollTop = top;
  else scrollTo({ left: 0, top, behavior: 'instant' });
  // requestAnimationFrame não dispara em aba oculta: o timeout evita ficar preso
  const frame = () => new Promise((r) => (requestAnimationFrame(() => requestAnimationFrame(r)), setTimeout(r, 100)));
  // animações finitas vão direto ao fim (conteúdo que surge ao rolar); as infinitas param, para o
  // fundo não mudar entre as telas
  const paused = (window.__pdfToolboxPaused ||= new Set());
  const settle = () => {
    for (const a of document.getAnimations()) {
      try {
        if (a.effect?.getComputedTiming().endTime === Infinity) {
          if (a.playState === 'running') a.pause(), paused.add(a);
        } else if (a.playState !== 'finished') a.finish();
      } catch {}
    }
  };
  await frame();
  settle();
  const deadline = performance.now() + 2000;
  const loading = () =>
    [...document.images].some((img) => {
      if (img.complete) return false;
      const r = img.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    });
  while (loading() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await frame();
  settle();
  await frame();
  return { y: el ? el.scrollTop : scrollY, total: root.scrollHeight };
}

// Depois da 1ª tela, esconde cabeçalhos fixos para não se repetirem no meio da imagem
function hideFixed() {
  const scroller = document.querySelector('[data-pdf-toolbox-scroller]');
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (scroller && el.contains(scroller)) continue; // a moldura do app que contém o painel
    // fundos fixos que cobrem a tela toda continuam (senão o resto da página fica sem fundo)
    const r = el.getBoundingClientRect();
    const isBackdrop = r.left <= 0 && r.top <= 0 && r.right >= innerWidth && r.bottom >= innerHeight;
    if (isBackdrop && (parseInt(cs.zIndex, 10) < 0 || cs.pointerEvents === 'none')) continue;
    el.dataset.pdfToolboxHidden = el.style.visibility;
    el.style.visibility = 'hidden';
  }
}

function restorePage(startY) {
  for (const el of document.querySelectorAll('[data-pdf-toolbox-hidden]')) {
    el.style.visibility = el.dataset.pdfToolboxHidden;
    delete el.dataset.pdfToolboxHidden;
  }
  const el = document.querySelector('[data-pdf-toolbox-scroller]');
  if (el) {
    el.scrollTop = startY;
    delete el.dataset.pdfToolboxScroller;
  } else {
    scrollTo({ left: 0, top: startY, behavior: 'instant' });
  }
  for (const a of window.__pdfToolboxPaused || []) a.play();
  delete window.__pdfToolboxPaused;
  document.getElementById('pdf-toolbox-freeze')?.remove();
}

// Página inteira: rola (a página ou o painel interno que rola), captura cada tela e junta tudo num canvas.
async function stitchFullPage(tab) {
  await inTab(tab.id, findScroller);
  const m = await inTab(tab.id, preparePage);
  const { box } = m;
  const shots = [];
  let total = Math.min(m.total, MAX_SHOT);
  let lastShot = 0;
  try {
    for (let y = 0; ; y += box.h) {
      const step = await inTab(tab.id, scrollStep, [y]);
      total = Math.min(step.total, MAX_SHOT); // a página pode crescer ao carregar mais conteúdo
      if (shots.length === 1) await inTab(tab.id, hideFixed);
      await sleep(Math.max(0, lastShot + 550 - Date.now())); // captureVisibleTab permite ~2 capturas por segundo
      const dataUrl = await captureTab(tab.windowId);
      lastShot = Date.now();
      shots.push({ y: step.y, bitmap: await createImageBitmap(await (await fetch(dataUrl)).blob()) });
      if (step.y + box.h >= total || step.y < y) break;
    }
  } finally {
    await inTab(tab.id, restorePage, [m.startY]).catch(() => {});
  }
  const r = shots[0].bitmap.width / m.vw;
  // painel que ocupa a largura toda: mantém o cabeçalho do app acima dele
  const prefix = m.inner && box.w >= m.vw * 0.9 ? box.y : 0;
  const height = prefix + Math.min(total, shots.at(-1).y + box.h);
  const canvas = new OffscreenCanvas(Math.round(box.w * r), Math.round(height * r));
  const ctx = canvas.getContext('2d');
  if (prefix) ctx.drawImage(shots[0].bitmap, box.x * r, 0, box.w * r, prefix * r, 0, 0, box.w * r, prefix * r);
  for (const s of shots) {
    ctx.drawImage(s.bitmap, box.x * r, box.y * r, box.w * r, box.h * r, 0, Math.round((prefix + s.y) * r), box.w * r, box.h * r);
  }
  return canvas;
}

// Fatia a imagem da página em folhas A4 (proporção) e monta um PDF.
async function canvasToPdf(canvas) {
  const doc = await PDFLib.PDFDocument.create();
  const sliceH = Math.round(canvas.width * (842 / 595));
  for (let y = 0; y < canvas.height; y += sliceH) {
    const h = Math.min(sliceH, canvas.height - y);
    const slice = new OffscreenCanvas(canvas.width, h);
    slice.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    const jpg = await doc.embedJpg(await (await slice.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    const pageH = (h / canvas.width) * 595;
    doc.addPage([595, pageH]).drawImage(jpg, { x: 0, y: 0, width: 595, height: pageH });
  }
  return doc.saveAsBase64({ dataUri: true });
}

const NOTE_IMAGE_PDF =
  'O PDF foi gerado como imagem da página. Para texto selecionável use Cmd/Ctrl+P → Salvar como PDF.';

async function capturePage(tab, mode) {
  const base = `${safeName(tab.title)} ${stamp()}`;
  if (mode === 'visible') {
    await download(await captureTab(tab.windowId), `${base}.png`);
    return {};
  }
  if (mode === 'pdf') {
    await download(await canvasToPdf(await stitchFullPage(tab)), `${base}.pdf`);
    return { note: NOTE_IMAGE_PDF };
  }
  if (mode === 'png') {
    const canvas = await stitchFullPage(tab);
    await download(await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' })), `${base}.png`);
    return {};
  }
  throw new Error(`modo desconhecido: ${mode}`);
}

async function startSelection(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['capture.js'] });
}

async function saveCrop({ format, dataUrl, width, height, title }) {
  const base = `${safeName(title)} recorte ${stamp()}`;
  if (format !== 'pdf') return download(dataUrl, `${base}.${format === 'jpg' ? 'jpg' : 'png'}`);
  // recorte bem mais alto que uma folha A4 (seleção com rolagem): divide em folhas A4
  if (height > width * (842 / 595) * 1.25) {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return download(await canvasToPdf(canvas), `${base}.pdf`);
  }
  // página do PDF no tamanho da área selecionada (1 px CSS = 0,75 pt)
  const doc = await PDFLib.PDFDocument.create();
  const img = await doc.embedPng(dataUrl);
  const w = width * 0.75;
  const h = height * 0.75;
  doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return download(await doc.saveAsBase64({ dataUri: true }), `${base}.pdf`);
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/cannot (access|attach|be scripted)|chrome:\/\/|extensions gallery|webstore|comet:\/\/|policy/i.test(msg)) {
    return 'O navegador não permite extensões nesta página (páginas internas, loja ou sites protegidos pelo navegador).';
  }
  return msg;
}

// Pelo atalho não há popup para mostrar o erro: sinaliza no ícone por alguns segundos.
async function flashError(tabId, message) {
  await actionCall('setBadgeText', { tabId, text: '✕' });
  await actionCall('setBadgeBackgroundColor', { tabId, color: '#555555' });
  await actionCall('setTitle', { tabId, title: `PDF Toolbox: ${message}` });
  setTimeout(async () => {
    await actionCall('setTitle', { tabId, title: 'PDF Toolbox' });
    await updateBadge(tabId, (await getItems(tabId)).length);
  }, 4000);
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'select-area' && tab) {
    startSelection(tab.id).catch((e) => flashError(tab.id, friendlyError(e)));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(
      (value) => sendResponse(value ?? { ok: true }),
      (e) => sendResponse({ error: friendlyError(e) })
    );
    return true;
  };

  if (msg.type === 'capture-page') {
    return reply(chrome.tabs.get(msg.tabId).then((tab) => capturePage(tab, msg.mode)).then((r) => ({ ok: true, ...r })));
  }
  if (msg.type === 'start-selection') return reply(startSelection(msg.tabId).then(() => ({ ok: true })));
  if (msg.type === 'capture-visible' && sender.tab) {
    return reply(captureTab(sender.tab.windowId).then((dataUrl) => ({ dataUrl })));
  }
  if (msg.type === 'save-crop') return reply(saveCrop(msg).then(() => ({ ok: true })));

  if (msg.type === 'pdfs-found' && sender.tab) {
    addItems(
      sender.tab.id,
      msg.items.map((i) => ({ ...i, frameId: sender.frameId }))
    );
  } else if (msg.type === 'stop-blink') {
    stopBlink(msg.tabId);
  } else if (msg.type === 'clear-tab') {
    enqueue(msg.tabId, async () => {
      await chrome.storage.session.set({ [key(msg.tabId)]: [] });
      await updateBadge(msg.tabId, 0);
    }).then(() => sendResponse(true));
    return true;
  }
});
