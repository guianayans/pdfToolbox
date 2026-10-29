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
    if (!fresh.length) return;
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

async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    return await fn((method, params) => chrome.debugger.sendCommand(target, method, params));
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
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

// Página inteira sem a API debugger (bloqueada em alguns navegadores, como o Comet):
// rola a janela, captura cada tela e junta tudo num único canvas.
async function stitchFullPage(tab) {
  const m = await inTab(tab.id, () => {
    const el = document.scrollingElement || document.documentElement;
    // scrollbar: largura da barra de rolagem, cortada da imagem final
    return { vw: innerWidth, vh: innerHeight, scrollbar: innerWidth - el.clientWidth, total: el.scrollHeight, startY: scrollY };
  });
  const total = Math.min(m.total, MAX_SHOT);
  const shots = [];
  try {
    for (let y = 0; ; y += m.vh) {
      const actualY = await inTab(tab.id, (top) => {
        scrollTo(0, top);
        return scrollY;
      }, [y]);
      // depois da 1ª tela, esconde cabeçalhos fixos para não se repetirem no meio da imagem
      if (shots.length === 1) {
        await inTab(tab.id, () => {
          for (const el of document.querySelectorAll('body *')) {
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') {
              el.dataset.pdfToolboxHidden = el.style.visibility;
              el.style.visibility = 'hidden';
            }
          }
        });
      }
      await sleep(550); // captureVisibleTab permite ~2 capturas por segundo
      const dataUrl = await captureTab(tab.windowId);
      shots.push({ y: actualY, bitmap: await createImageBitmap(await (await fetch(dataUrl)).blob()) });
      if (actualY + m.vh >= total || actualY < y) break;
    }
  } finally {
    await inTab(tab.id, (startY) => {
      for (const el of document.querySelectorAll('[data-pdf-toolbox-hidden]')) {
        el.style.visibility = el.dataset.pdfToolboxHidden;
        delete el.dataset.pdfToolboxHidden;
      }
      scrollTo(0, startY);
    }, [m.startY]).catch(() => {});
  }
  const ratio = shots[0].bitmap.width / m.vw;
  const canvas = new OffscreenCanvas(Math.round((m.vw - Math.max(0, m.scrollbar)) * ratio), Math.round(Math.min(total, shots.at(-1).y + m.vh) * ratio));
  const ctx = canvas.getContext('2d');
  for (const s of shots) ctx.drawImage(s.bitmap, 0, Math.round(s.y * ratio));
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
  'Este navegador bloqueia o PDF com texto; o PDF foi gerado como imagem. Para texto selecionável use Cmd+P → Salvar como PDF.';

async function capturePage(tab, mode) {
  const base = `${safeName(tab.title)} ${stamp()}`;
  if (mode === 'visible') {
    await download(await captureTab(tab.windowId), `${base}.png`);
    return {};
  }
  if (mode === 'pdf') {
    try {
      const { data } = await withDebugger(tab.id, (send) =>
        send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true })
      );
      await download(`data:application/pdf;base64,${data}`, `${base}.pdf`);
      return {};
    } catch (e) {
      console.info('printToPDF indisponível, usando captura por rolagem', e);
    }
    await download(await canvasToPdf(await stitchFullPage(tab)), `${base}.pdf`);
    return { note: NOTE_IMAGE_PDF };
  }
  if (mode === 'png') {
    try {
      const { data } = await withDebugger(tab.id, async (send) => {
        const m = await send('Page.getLayoutMetrics');
        const content = m.cssContentSize || m.contentSize;
        const width = Math.ceil(content.width);
        const height = Math.min(Math.ceil(content.height), MAX_SHOT);
        const scale = Math.max(0.5, Math.min(2, MAX_SHOT / height, MAX_SHOT / width));
        return send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale },
        });
      });
      await download(`data:image/png;base64,${data}`, `${base}.png`);
      return {};
    } catch (e) {
      console.info('captureScreenshot indisponível, usando captura por rolagem', e);
    }
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
  if (/another debugger|already attached/i.test(msg)) return 'Feche o DevTools desta aba e tente de novo.';
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
