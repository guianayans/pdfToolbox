import * as pdfjsLib from './lib/pdf.min.mjs';
import { pdfToDocx } from './pdf2docx.js';
import { fetchFromPage } from './fetch-file.js';
import { docxToPdf, isZip, isLegacyDoc } from './docx2pdf.js';
import { hasEdits, applyEdits, wordExtras, initAnnotator, openAnnotator } from './annotate.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees } = window.PDFLib;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- Estado ----------
// sources: documentos carregados; pages: páginas na ordem atual (podem vir de vários sources).
const sources = [];
let pages = [];
let initialPages = [];
const history = [];
let nextId = 1;
let lastClicked = null;
let docName = 'documento';

const snapshot = () => pages.map(({ id, src, index, rot }) => ({ id, src, index, rot }));
function pushHistory() {
  history.push(snapshot());
  if (history.length > 50) history.shift();
}
const selected = () => pages.filter((p) => p.selected);
const targets = () => (selected().length ? selected() : pages);
const baseName = () => docName.replace(/\.(pdf|docx?)$/i, '');
const isWordName = (name) => /\.docx?$/i.test(name);

// ---------- Utilidades ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 7000 : 3500);
}

function download(data, filename, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const formatSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

let busy = false;
async function run(label, fn) {
  if (busy) return;
  busy = true;
  $('#loadingText').textContent = label;
  $('#loading').hidden = false;
  $$('.tools button').forEach((b) => (b.dataset.wasDisabled = b.disabled, b.disabled = true));
  try {
    await fn();
  } catch (e) {
    console.error(e);
    toast(`Erro: ${e.message || e}`, true);
  } finally {
    busy = false;
    $('#loading').hidden = true;
    $$('.tools button').forEach((b) => (b.disabled = b.dataset.wasDisabled === 'true'));
    updateUi();
  }
}

function isPdf(buf) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  return head.includes('%PDF');
}

// ---------- Carregamento ----------
async function addSource(buffer, name) {
  const bytes = new Uint8Array(buffer);
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let password = '';
  task.onPassword = (update, reason) => {
    const pw = prompt(reason === 2 ? 'Senha incorreta. Tente novamente:' : `“${name}” é protegido. Digite a senha:`);
    if (pw === null) task.destroy();
    else update((password = pw));
  };
  const doc = await task.promise;

  // PDFs protegidos (comum em faturas) precisam ser descriptografados antes de copiar páginas;
  // se não der, as páginas são exportadas como imagem (ver buildPdf).
  let libDoc = null;
  try {
    libDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, password, updateMetadata: false });
    if (libDoc.isEncrypted) libDoc = null;
  } catch (e) {
    console.info('pdf-lib não abriu o arquivo', e);
  }
  if (!libDoc) toast('Não foi possível descriptografar este PDF: as páginas salvas serão convertidas em imagem.', true);

  const src = sources.push({ name, bytes, doc, libDoc, rasterOnly: !libDoc }) - 1;
  if (src === 0) {
    docName = name;
    document.title = `${name} · PDF Toolbox`;
  }
  if (src > 0) pushHistory();
  for (let i = 0; i < doc.numPages; i++) pages.push({ id: nextId++, src, index: i, rot: 0, selected: false });
  if (src === 0) initialPages = snapshot();
  render();
}

// Documento Word: vira PDF (páginas como imagem) para usar as ferramentas.
async function addWord(buffer, name) {
  if (isLegacyDoc(buffer)) throw new Error(`“${name}” está no formato .doc antigo. Abra no Word e salve como .docx.`);
  const pdf = await docxToPdf(buffer, {
    onProgress: (i, n) => ($('#loadingText').textContent = `Convertendo Word em PDF… página ${i + 1} de ${n}`),
  });
  await addSource(pdf.buffer, name.replace(/\.docx?$/i, '.pdf'));
}

async function addFiles(files) {
  const ok = [...files].filter((f) => f.type === 'application/pdf' || /\.(pdf|docx?)$/i.test(f.name));
  if (!ok.length) return toast('Selecione arquivos PDF ou Word (.docx).', true);
  await run('Carregando…', async () => {
    for (const f of ok) {
      if (isWordName(f.name)) await addWord(await f.arrayBuffer(), f.name);
      else await addSource(await f.arrayBuffer(), f.name);
    }
    if (sources.length > 1) toast(`${ok.length} arquivo(s) adicionado(s) ao final.`);
  });
}

// ---------- Renderização ----------
async function renderPage(p, scale) {
  const page = await sources[p.src].doc.getPage(p.index + 1);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + p.rot) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function pageSize(p) {
  const page = await sources[p.src].doc.getPage(p.index + 1);
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + p.rot) % 360 });
  return { width: vp.width, height: vp.height };
}

// Miniaturas: cache (URL de imagem) por página+rotação, renderizadas sob demanda e em fila.
const thumbCache = new Map();
const thumbQueue = [];
let thumbWorking = false;
const thumbKey = (p) => `${p.src}:${p.index}:${p.rot}`;

function thumbImg(key) {
  const { url, width } = thumbCache.get(key);
  const img = new Image();
  img.src = url;
  img.style.width = `${width}px`;
  img.draggable = false;
  return img;
}

function requestThumb(p, holder) {
  thumbQueue.push({ p: { ...p }, holder, key: thumbKey(p) });
  pumpThumbs();
}

async function pumpThumbs() {
  if (thumbWorking) return;
  thumbWorking = true;
  const dpr = window.devicePixelRatio || 1;
  while (thumbQueue.length) {
    const { p, holder, key } = thumbQueue.shift();
    if (!holder.isConnected) continue;
    try {
      if (!thumbCache.has(key)) {
        const { width, height } = await pageSize(p);
        const canvas = await renderPage(p, Math.min(170 / width, 200 / height) * dpr);
        const blob = await canvasToBlob(canvas, 'image/png');
        thumbCache.set(key, { url: URL.createObjectURL(blob), width: canvas.width / dpr });
        canvas.width = canvas.height = 0;
      }
      if (holder.isConnected && holder.dataset.key === key) holder.replaceChildren(thumbImg(key));
    } catch (e) {
      console.error(e);
    }
  }
  thumbWorking = false;
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      const p = pages.find((x) => x.id === Number(e.target.closest('.card').dataset.id));
      if (p) requestThumb(p, e.target);
    }
  },
  { rootMargin: '400px' }
);

function render() {
  const grid = $('#grid');
  grid.replaceChildren();
  pages.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card' + (p.selected ? ' selected' : '');
    card.dataset.id = p.id;
    card.draggable = true;
    card.innerHTML = `
      <div class="check">✓</div>
      <div class="card-actions">
        <button data-act="edit" title="Editar conteúdo">✏️</button>
        <button data-act="view" title="Ampliar">🔍</button>
        <button data-act="rot" title="Girar">↻</button>
        <button data-act="del" title="Excluir">🗑</button>
      </div>
      <div class="thumb"></div>
      <div class="card-label"><b>${i + 1}</b><span></span></div>`;
    if (sources.length > 1) card.querySelector('.card-label span').textContent = `${sources[p.src].name.slice(0, 18)} · p.${p.index + 1}`;
    if (hasEdits(p)) card.insertAdjacentHTML('beforeend', '<span class="edited-badge">editada</span>');
    const thumb = card.querySelector('.thumb');
    thumb.dataset.key = thumbKey(p);
    if (thumbCache.has(thumb.dataset.key)) thumb.append(thumbImg(thumb.dataset.key));
    else observer.observe(thumb);
    grid.append(card);
  });
  updateUi();
}

function updateUi() {
  const hasDoc = pages.length > 0;
  const sel = selected().length;
  $('#dropzone').hidden = hasDoc || sources.length > 0;
  $('#selectionBar').hidden = !hasDoc;
  $('#selInfo').textContent = `${pages.length} página(s)` + (sel ? ` · ${sel} selecionada(s)` : '');
  $('#docTitle').textContent = sources.length ? sources.map((s) => s.name).join(' + ') : 'Nenhum documento';

  if (busy) return;
  $$('.tools button').forEach((b) => (b.disabled = !hasDoc));
  for (const id of ['saveSel', 'rotLeft', 'rotRight', 'delSel']) $(`#${id}`).disabled = !sel;
  $('#undo').disabled = !history.length;
  $('#saveSel').textContent = sel ? `Salvar ${sel} página(s) selecionada(s)` : 'Salvar páginas selecionadas';
  const n = targets().length;
  $('#toImage').textContent = `Converter ${n} página(s) em imagem`;
  $('#actionScope').textContent = hasDoc
    ? sel
      ? `Converter, dividir, extrair texto e extras usam as ${sel} página(s) selecionada(s).`
      : 'Sem seleção: as ações usam todas as páginas.'
    : '';
  $$('.card').forEach((c) => {
    const p = pages.find((x) => x.id === Number(c.dataset.id));
    c.classList.toggle('selected', !!p?.selected);
  });
}

// ---------- Interação com as páginas ----------
$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const p = pages.find((x) => x.id === Number(card.dataset.id));
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'view') return openViewer(pages.indexOf(p));
  if (act === 'edit') return openAnnotator(pages, pages.indexOf(p));
  if (act === 'rot') {
    pushHistory();
    p.rot = (p.rot + 90) % 360;
    return render();
  }
  if (act === 'del') {
    pushHistory();
    pages = pages.filter((x) => x !== p);
    return render();
  }
  if (e.shiftKey && lastClicked) {
    const a = pages.findIndex((x) => x.id === lastClicked);
    const b = pages.indexOf(p);
    if (a >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      for (let i = from; i <= to; i++) pages[i].selected = true;
    }
  } else {
    p.selected = !p.selected;
  }
  lastClicked = p.id;
  updateUi();
});

$('#grid').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.target.closest('[data-act]')) openViewer(pages.findIndex((x) => x.id === Number(card.dataset.id)));
});

// Arrastar para reordenar
let dragId = null;
$('#grid').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  dragId = Number(card.dataset.id);
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
});
$('#grid').addEventListener('dragend', () => {
  dragId = null;
  $$('.card').forEach((c) => c.classList.remove('dragging', 'drag-over'));
});
$('#grid').addEventListener('dragover', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  $$('.card.drag-over').forEach((c) => c.classList.remove('drag-over'));
  e.target.closest('.card')?.classList.add('drag-over');
});
$('#grid').addEventListener('drop', (e) => {
  if (dragId == null) return;
  e.preventDefault();
  e.stopPropagation();
  const card = e.target.closest('.card');
  if (!card || Number(card.dataset.id) === dragId) return;
  pushHistory();
  const moving = pages.find((x) => x.id === dragId);
  pages = pages.filter((x) => x !== moving);
  const rect = card.getBoundingClientRect();
  let idx = pages.findIndex((x) => x.id === Number(card.dataset.id));
  if (e.clientX > rect.left + rect.width / 2) idx++;
  pages.splice(idx, 0, moving);
  render();
});

// Arrastar arquivos do computador
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
document.addEventListener('dragenter', (e) => hasFiles(e) && (dragDepth++, document.body.classList.add('dragging')));
document.addEventListener('dragleave', (e) => hasFiles(e) && --dragDepth <= 0 && document.body.classList.remove('dragging'));
document.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});
$('#fileInput').addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

// ---------- Seleção ----------
$$('[data-sel]').forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.sel;
    pages.forEach((p) => (p.selected = mode === 'all' ? true : mode === 'none' ? false : !p.selected));
    updateUi();
  })
);

function parseRange(text, total) {
  const out = new Set();
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*-\s*(\d+)?$/);
    if (m) {
      const a = Math.max(1, Number(m[1] || 1));
      const b = Math.min(total, Number(m[2] || total));
      for (let i = a; i <= b; i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= total) out.add(n - 1);
    } else {
      throw new Error(`intervalo inválido: “${part}”`);
    }
  }
  return out;
}

function applyRange() {
  try {
    const set = parseRange($('#rangeInput').value, pages.length);
    pages.forEach((p, i) => (p.selected = set.has(i)));
    updateUi();
    if (!set.size) toast('Nenhuma página nesse intervalo.', true);
  } catch (e) {
    toast(e.message, true);
  }
}
$('#applyRange').addEventListener('click', applyRange);
$('#rangeInput').addEventListener('keydown', (e) => e.key === 'Enter' && applyRange());

// ---------- Organizar ----------
function rotateSelected(delta) {
  pushHistory();
  selected().forEach((p) => (p.rot = (p.rot + delta + 360) % 360));
  render();
}
function deleteSelected() {
  if (!selected().length) return;
  pushHistory();
  pages = pages.filter((p) => !p.selected);
  render();
}
function undo() {
  const prev = history.pop();
  if (!prev) return;
  pages = prev.map((p) => ({ ...p, selected: false }));
  render();
}
$('#rotLeft').addEventListener('click', () => rotateSelected(-90));
$('#rotRight').addEventListener('click', () => rotateSelected(90));
$('#delSel').addEventListener('click', deleteSelected);
$('#reverse').addEventListener('click', () => {
  pushHistory();
  pages.reverse();
  render();
});
$('#undo').addEventListener('click', undo);
$('#reset').addEventListener('click', () => {
  pushHistory();
  pages = initialPages.map((p) => ({ ...p, selected: false }));
  render();
});

// ---------- Geração de PDF ----------
async function buildPdf(list, { skipText = false } = {}) {
  const out = await PDFDocument.create();
  // copia todas as páginas de cada origem de uma vez (evita duplicar fontes/recursos)
  const copied = new Map();
  for (const src of new Set(list.map((p) => p.src))) {
    if (sources[src].rasterOnly) continue;
    const indices = list.filter((p) => p.src === src).map((p) => p.index);
    copied.set(src, await out.copyPages(sources[src].libDoc, indices));
  }
  const cursor = new Map();
  for (const p of list) {
    if (sources[p.src].rasterOnly) {
      // fallback para PDFs que não puderam ser descriptografados: página vira imagem 200 DPI
      const base = { ...p, rot: 0 };
      const { width, height } = await pageSize(base);
      const canvas = await renderPage(base, 200 / 72);
      const jpg = await out.embedJpg(await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
      canvas.width = canvas.height = 0;
      const page = out.addPage([width, height]);
      page.drawImage(jpg, { x: 0, y: 0, width, height });
      await applyEdits(out, page, p, visualFrame(page), { skipText });
      page.setRotation(degrees(p.rot));
      continue;
    }
    const n = cursor.get(p.src) || 0;
    cursor.set(p.src, n + 1);
    const page = copied.get(p.src)[n];
    out.addPage(page);
    // edições ficam na orientação original da página; o giro do usuário vem depois
    await applyEdits(out, page, p, visualFrame(page), { skipText });
    page.setRotation(degrees((page.getRotation().angle + p.rot + 360) % 360));
  }
  return out;
}

const saveDoc = async (doc) => doc.save({ useObjectStreams: true });

$('#saveSel').addEventListener('click', () =>
  run('Gerando PDF…', async () => {
    const list = selected();
    const bytes = await saveDoc(await buildPdf(list));
    const suffix = list.length === 1 ? `pagina-${pages.indexOf(list[0]) + 1}` : `${list.length}-paginas`;
    download(bytes, `${baseName()}-${suffix}.pdf`);
    toast(`PDF com ${list.length} página(s) salvo (${formatSize(bytes.length)}).`);
  })
);

$('#saveAll').addEventListener('click', () =>
  run('Gerando PDF…', async () => {
    const bytes = await saveDoc(await buildPdf(pages));
    download(bytes, `${baseName()}-editado.pdf`);
    toast(`Documento salvo (${formatSize(bytes.length)}).`);
  })
);

$('#split').addEventListener('click', () =>
  run('Dividindo…', async () => {
    const zip = new JSZip();
    const list = targets();
    for (const p of list) {
      const n = pages.indexOf(p) + 1;
      $('#loadingText').textContent = `Dividindo… página ${n}`;
      zip.file(`${baseName()}-pagina-${String(n).padStart(3, '0')}.pdf`, await saveDoc(await buildPdf([p])));
    }
    download(await zip.generateAsync({ type: 'blob' }), `${baseName()}-paginas.zip`);
    toast(`${list.length} arquivo(s) gerado(s).`);
  })
);

// ---------- Imagens e texto ----------
const canvasToBlob = (canvas, type, quality) => new Promise((ok) => canvas.toBlob(ok, type, quality));

// Para exportar como imagem/Word: se houver edições, renderiza a partir do PDF já editado.
async function exportRenderer(list, opts) {
  if (!list.some(hasEdits) && !opts?.skipText) {
    return { render: (i, scale) => renderPage(list[i], scale), size: (i) => pageSize(list[i]), doc: null };
  }
  const bytes = await saveDoc(await buildPdf(list, opts));
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const render = async (i, scale) => {
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas;
  };
  const size = async (i) => {
    const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  };
  return { render, size, doc };
}

$('#toImage').addEventListener('click', () =>
  run('Convertendo…', async () => {
    const fmt = $('#imgFormat').value;
    const scale = Number($('#imgDpi').value) / 72;
    const ext = fmt === 'jpeg' ? 'jpg' : 'png';
    const list = targets();
    const files = [];
    const r = await exportRenderer(list);
    for (const [i, p] of list.entries()) {
      const n = pages.indexOf(p) + 1;
      $('#loadingText').textContent = `Convertendo página ${n}…`;
      const canvas = await r.render(i, scale);
      files.push({ name: `${baseName()}-pagina-${String(n).padStart(3, '0')}.${ext}`, blob: await canvasToBlob(canvas, `image/${fmt}`, 0.92) });
      canvas.width = canvas.height = 0;
    }
    if (files.length === 1) {
      download(files[0].blob, files[0].name);
    } else {
      const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f.blob));
      download(await zip.generateAsync({ type: 'blob' }), `${baseName()}-imagens.zip`);
    }
    toast(`${files.length} imagem(ns) gerada(s).`);
  })
);

$('#extractText').addEventListener('click', () =>
  run('Extraindo texto…', async () => {
    let txt = '';
    for (const p of targets()) {
      const page = await sources[p.src].doc.getPage(p.index + 1);
      const content = await page.getTextContent();
      txt += `===== Página ${pages.indexOf(p) + 1} =====\n`;
      for (const item of content.items) txt += item.str + (item.hasEOL ? '\n' : '');
      txt += '\n\n';
    }
    if (!txt.replace(/=+ Página \d+ =+/g, '').trim()) toast('Nenhum texto encontrado (o PDF pode ser escaneado).', true);
    download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), `${baseName()}.txt`);
  })
);

// ---------- Word ----------
async function convertToWord(list, mode) {
  $('#loadingText').textContent = 'Preparando conversão…';
  // sem edições: lê as páginas originais (funciona até em PDF protegido); com edições, monta o PDF
  // editado (o texto adicionado no editor fica de fora e entra como texto do Word, não no fundo)
  const edited = list.some(hasEdits) ? (await exportRenderer(list, { skipText: true })).doc : null;
  const getPage = async (i) => {
    if (edited) {
      const page = await edited.getPage(i + 1);
      return { page, rotation: page.rotate };
    }
    const p = list[i];
    const page = await sources[p.src].doc.getPage(p.index + 1);
    return { page, rotation: (page.rotate + p.rot) % 360 };
  };
  const extras = [];
  for (const [i, p] of list.entries()) {
    const { page, rotation } = await getPage(i);
    const vp = page.getViewport({ scale: 1, rotation });
    extras.push(wordExtras(p, p.rot, vp.width, vp.height));
  }
  const { blob, hasText } = await pdfToDocx(getPage, list.length, {
    mode,
    extras,
    onProgress: (i, n) => ($('#loadingText').textContent = `Convertendo para Word… página ${i + 1} de ${n}`),
  });
  edited?.destroy();
  const sel = list.length === pages.length ? '' : `-${list.length}-paginas`;
  download(blob, `${baseName()}${sel}.docx`);
  toast(hasText ? `Word gerado (${formatSize(blob.size)}).` : 'Word gerado, mas o PDF não tem texto (parece escaneado): as páginas foram como imagem.', !hasText);
}

$('#toWord').addEventListener('click', () => run('Convertendo para Word…', () => convertToWord(targets(), $('#wordMode').value)));

// ---------- Extras ----------
// Converte coordenadas "visuais" (como a página aparece, já girada) para o espaço da página.
function visualFrame(page) {
  const box = page.getCropBox();
  const a = ((page.getRotation().angle % 360) + 360) % 360;
  const { x: x0, y: y0, width: w, height: h } = box;
  const turned = a === 90 || a === 270;
  const toUser = (vx, vy) => {
    switch (a) {
      case 90: return { x: x0 + w - vy, y: y0 + vx };
      case 180: return { x: x0 + w - vx, y: y0 + h - vy };
      case 270: return { x: x0 + vy, y: y0 + h - vx };
      default: return { x: x0 + vx, y: y0 + vy };
    }
  };
  return { vw: turned ? h : w, vh: turned ? w : h, angle: a, toUser };
}

$('#pageNumbers').addEventListener('click', () =>
  run('Numerando páginas…', async () => {
    const doc = await buildPdf(targets());
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pos = $('#numPos').value;
    const all = doc.getPages();
    all.forEach((page, i) => {
      const { vw, angle, toUser } = visualFrame(page);
      const text = `${i + 1} / ${all.length}`;
      const size = 10;
      const tw = font.widthOfTextAtSize(text, size);
      const margin = 24;
      const vx = pos === 'left' ? margin : pos === 'right' ? vw - margin - tw : (vw - tw) / 2;
      const { x, y } = toUser(vx, 18);
      page.drawText(text, { x, y, size, font, color: rgb(0.25, 0.25, 0.28), rotate: degrees(angle) });
    });
    download(await saveDoc(doc), `${baseName()}-numerado.pdf`);
    toast('Páginas numeradas.');
  })
);

$('#watermark').addEventListener('click', () => {
  const text = $('#wmText').value.trim();
  if (!text) return toast('Digite o texto da marca d’água.', true);
  run('Aplicando marca d’água…', async () => {
    const doc = await buildPdf(targets());
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const page of doc.getPages()) {
      const { vw, vh, angle, toUser } = visualFrame(page);
      const diag = Math.hypot(vw, vh);
      const size = Math.min(110, (diag * 0.6) / font.widthOfTextAtSize(text, 1));
      const tw = font.widthOfTextAtSize(text, size);
      const th = size * 0.7;
      const theta = Math.atan2(vh, vw);
      // ponto inicial para o texto ficar centralizado ao longo da diagonal
      const vx = vw / 2 - (Math.cos(theta) * tw) / 2 + (Math.sin(theta) * th) / 2;
      const vy = vh / 2 - (Math.sin(theta) * tw) / 2 - (Math.cos(theta) * th) / 2;
      const { x, y } = toUser(vx, vy);
      page.drawText(text, {
        x, y, size, font,
        color: rgb(0.85, 0.15, 0.15),
        opacity: 0.18,
        rotate: degrees(angle + (theta * 180) / Math.PI),
      });
    }
    download(await saveDoc(doc), `${baseName()}-marca-dagua.pdf`);
    toast('Marca d’água aplicada.');
  });
});

$('#compress').addEventListener('click', () =>
  run('Comprimindo…', async () => {
    const quality = Number($('#compressLevel').value);
    const scale = quality >= 0.85 ? 2 : quality >= 0.7 ? 1.5 : 1.1;
    const list = targets();
    const out = await PDFDocument.create();
    const r = await exportRenderer(list);
    for (const [i, p] of list.entries()) {
      $('#loadingText').textContent = `Comprimindo página ${pages.indexOf(p) + 1}…`;
      const { width, height } = await r.size(i);
      const canvas = await r.render(i, scale);
      const jpg = await out.embedJpg(await (await canvasToBlob(canvas, 'image/jpeg', quality)).arrayBuffer());
      canvas.width = canvas.height = 0;
      out.addPage([width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
    }
    const bytes = await saveDoc(out);
    const original = list.length === pages.length && sources.length === 1 ? sources[0].bytes.length : null;
    download(bytes, `${baseName()}-comprimido.pdf`);
    toast(original ? `Comprimido: ${formatSize(original)} → ${formatSize(bytes.length)}` : `PDF comprimido (${formatSize(bytes.length)}).`);
  })
);

// ---------- Editor de conteúdo ----------
initAnnotator({
  pageSize,
  renderPage,
  sourcePage: (p) => sources[p.src].doc.getPage(p.index + 1),
  onChange: () => render(),
});
$('#openEditor').addEventListener('click', () => {
  const first = selected()[0];
  openAnnotator(pages, first ? pages.indexOf(first) : 0);
});

// ---------- Visualizador ----------
let viewIndex = 0;
let viewToken = 0;
async function showView() {
  const p = pages[viewIndex];
  if (!p) return;
  const token = ++viewToken;
  $('#viewerLabel').textContent = `Página ${viewIndex + 1} de ${pages.length}`;
  const { width, height } = await pageSize(p);
  const fit = Math.min((window.innerWidth * 0.9) / width, (window.innerHeight * 0.9) / height);
  const dpr = window.devicePixelRatio || 1;
  const canvas = await renderPage(p, fit * dpr);
  if (token !== viewToken) return;
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.id = 'viewerCanvas';
  $('#viewerCanvas').replaceWith(canvas);
}
function openViewer(i) {
  if (i < 0) return;
  viewIndex = i;
  $('#viewer').hidden = false;
  showView();
}
const closeViewer = () => ($('#viewer').hidden = true);
const step = (d) => {
  viewIndex = Math.min(pages.length - 1, Math.max(0, viewIndex + d));
  showView();
};
$('#viewerClose').addEventListener('click', closeViewer);
$('#viewerPrev').addEventListener('click', () => step(-1));
$('#viewerNext').addEventListener('click', () => step(1));
$('#viewer').addEventListener('click', (e) => e.target.id === 'viewer' && closeViewer());

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.target.isContentEditable || !$('#editView').hidden) return;
  const viewing = !$('#viewer').hidden;
  if (viewing) {
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    pages.forEach((p) => (p.selected = true));
    updateUi();
  } else if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  } else if (e.key === 'Escape') {
    pages.forEach((p) => (p.selected = false));
    updateUi();
  }
});

// ---------- Início ----------
const params = new URLSearchParams(location.search);
updateUi();
if (params.get('url')) {
  const word = params.get('kind') === 'word';
  const name = params.get('name') || (word ? 'documento.docx' : 'documento.pdf');
  run(word ? 'Baixando documento Word…' : 'Baixando PDF da página…', async () => {
    const buf = await fetchFromPage(params.get('url'), Number(params.get('tab')), Number(params.get('frame') || 0), word ? (b) => isZip(b) || isLegacyDoc(b) : isPdf);
    if (word) {
      await addWord(buf, name);
      docName = name;
    } else {
      $('#loadingText').textContent = 'Lendo PDF…';
      await addSource(buf, name);
    }
    // "Baixar em Word" no popup: converte assim que abrir
    if (params.get('action') === 'word') await convertToWord(pages, 'layout');
  });
}
