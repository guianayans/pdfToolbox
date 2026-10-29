// Editor visual de páginas: adicionar/editar texto, apagar áreas, destacar, desenhar e inserir imagens.
// As edições ficam guardadas por página (coordenadas 0–1 na orientação original da página) e são
// aplicadas no PDF salvo (applyEdits) e na conversão para Word (wordExtras).

import { extractLines } from './pdf2docx.js';

const { StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;
const $ = (s) => document.querySelector(s);

/** id da página → lista de edições */
export const edits = new Map();
export const hasEdits = (p) => (edits.get(p.id) || []).length > 0;

const FONTS = {
  Helvetica: { css: 'Helvetica, Arial, sans-serif', word: 'Arial' },
  Times: { css: '"Times New Roman", Times, serif', word: 'Times New Roman' },
  Courier: { css: '"Courier New", Courier, monospace', word: 'Courier New' },
};
const BASELINE = 0.93; // linha de base a 0,93 do tamanho abaixo do topo da caixa de texto
const LINE_HEIGHT = 1.2;

const STANDARD = {
  Helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  Times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  Courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
};

const hexToRgb = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

// Gira um ponto normalizado (origem no topo esquerdo) junto com a página, no sentido horário.
function rotN([x, y], rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default: return [x, y];
  }
}
function rotRectN(r, rot) {
  const [ax, ay] = rotN([r.x, r.y], rot);
  const [bx, by] = rotN([r.x + r.w, r.y + r.h], rot);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

// ---------- Aplicação no PDF ----------

/**
 * Desenha as edições da página `p` em `page` (pdf-lib), antes de girá-la.
 * frame: visualFrame da página na orientação original. skipText: deixa o texto de fora (Word).
 */
export async function applyEdits(doc, page, p, frame, { skipText = false } = {}) {
  const list = edits.get(p.id);
  if (!list?.length) return;
  const { vw: W, vh: H, angle, toUser } = frame;
  const rotate = degrees(angle);
  doc.__fonts ||= new Map();
  const font = async (family, bold, italic) => {
    const name = STANDARD[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    if (!doc.__fonts.has(name)) doc.__fonts.set(name, await doc.embedFont(StandardFonts[name]));
    return doc.__fonts.get(name);
  };
  const box = (r) => ({ ...toUser(r.x * W, H - (r.y + r.h) * H), width: r.w * W, height: r.h * H, rotate });

  for (const e of list) {
    if (e.type === 'text') {
      if (e.cover) page.drawRectangle({ ...box(e.cover), color: hexToRgb(e.cover.color) });
      if (skipText || !e.text.trim()) continue;
      const f = await font(e.font, e.bold, e.italic);
      const supported = new Set(f.getCharacterSet());
      e.text.split('\n').forEach((line, i) => {
        // as fontes padrão do PDF só têm caracteres latinos (WinAnsi)
        const safe = [...line].map((c) => (supported.has(c.codePointAt(0)) ? c : '?')).join('');
        if (!safe) return;
        const vy = H - (e.y * H + e.size * BASELINE + i * e.size * LINE_HEIGHT);
        page.drawText(safe, { ...toUser(e.x * W, vy), size: e.size, font: f, color: hexToRgb(e.color), rotate });
      });
    } else if (e.type === 'rect') {
      page.drawRectangle({ ...box(e), color: hexToRgb(e.color), opacity: e.kind === 'highlight' ? 0.38 : 1 });
    } else if (e.type === 'ink') {
      for (let i = 1; i < e.points.length; i++) {
        const [ax, ay] = e.points[i - 1];
        const [bx, by] = e.points[i];
        page.drawLine({
          start: toUser(ax * W, H - ay * H),
          end: toUser(bx * W, H - by * H),
          thickness: e.width,
          color: hexToRgb(e.color),
          lineCap: LineCapStyle.Round,
        });
      }
    } else if (e.type === 'image') {
      const bytes = await (await fetch(e.src)).arrayBuffer();
      const img = e.src.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      page.drawImage(img, box(e));
    }
  }
}

/**
 * Dados extras para a conversão em Word da página `p` (já com a rotação `rot` do usuário):
 * áreas que escondem texto antigo e as linhas de texto adicionadas no editor.
 * W, H: tamanho da página exibida (pt).
 */
export function wordExtras(p, rot, W, H) {
  const list = edits.get(p.id) || [];
  const covers = [];
  const lines = [];
  for (const e of list) {
    if (e.type === 'rect' && e.kind === 'cover') covers.push(rotRectN(e, rot));
    if (e.type !== 'text') continue;
    if (e.cover) covers.push(rotRectN(e.cover, rot));
    const [x, y] = rotN([e.x, e.y], rot);
    e.text.split('\n').forEach((text, i) => {
      if (!text.trim()) return;
      lines.push({
        x: x * W,
        y: y * H + e.size * (BASELINE + i * LINE_HEIGHT),
        size: e.size,
        width: 0,
        color: true,
        runs: [{ text, family: FONTS[e.font].word, bold: e.bold, italic: e.italic, color: e.color.replace('#', '').toUpperCase() }],
      });
    });
  }
  return { covers, lines };
}

// ---------- Interface ----------

let deps = null; // { pages(), sourceDoc(p), renderBase(p, scale), onChange() }
let list = []; // páginas navegáveis
let index = 0;
let tool = 'select';
let selectedId = null;
let scalePx = 1; // px CSS por pt
let pageW = 0;
let pageH = 0;
let canvas = null;
let textLines = [];
const undoStack = [];
let nextEditId = 1;

const current = () => list[index];
const pageEdits = () => {
  const p = current();
  if (!edits.has(p.id)) edits.set(p.id, []);
  return edits.get(p.id);
};
const style = () => ({
  font: $('#edFont').value,
  size: Number($('#edSize').value) || 12,
  bold: $('#edBold').classList.contains('on'),
  italic: $('#edItalic').classList.contains('on'),
  color: $('#edColor').value,
});

function pushUndo() {
  undoStack.push({ id: current().id, data: JSON.stringify(pageEdits()) });
  if (undoStack.length > 100) undoStack.shift();
  $('#edUndo').disabled = false;
}

function changed() {
  deps.onChange();
  $('#edLabel').textContent = `Página ${index + 1} de ${list.length}` + (pageEdits().length ? ` · ${pageEdits().length} edição(ões)` : '');
}

export function initAnnotator(d) {
  deps = d;
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#edClose').addEventListener('click', closeAnnotator);
  $('#edPrev').addEventListener('click', () => go(index - 1));
  $('#edNext').addEventListener('click', () => go(index + 1));
  $('#edUndo').addEventListener('click', undo);
  $('#edDelete').addEventListener('click', deleteSelected);
  $('#edBold').addEventListener('click', () => toggleStyle('#edBold', 'bold'));
  $('#edItalic').addEventListener('click', () => toggleStyle('#edItalic', 'italic'));
  for (const id of ['#edFont', '#edSize', '#edColor']) {
    $(id).addEventListener('input', () => applyStyle());
  }
  $('#edImage').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) addImage(file);
  });
  const layer = $('#edLayer');
  layer.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', (e) => {
    if ($('#editView').hidden) return;
    if (e.target.isContentEditable || e.target.matches('input, select, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    e.stopImmediatePropagation();
    if (e.key === 'Escape') selectedId ? select(null) : closeAnnotator();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if (e.key === 'ArrowLeft') go(index - 1);
    else if (e.key === 'ArrowRight') go(index + 1);
  }, true);
  window.addEventListener('resize', () => !$('#editView').hidden && showPage());
}

export function openAnnotator(pages, start = 0) {
  list = pages;
  index = Math.max(0, Math.min(start, pages.length - 1));
  $('#editView').hidden = false;
  setTool('select');
  showPage();
}

function closeAnnotator() {
  document.activeElement?.blur?.();
  $('#editView').hidden = true;
  select(null);
  deps.onChange();
}

function go(i) {
  if (i < 0 || i >= list.length || i === index) return;
  document.activeElement?.blur?.();
  index = i;
  select(null);
  showPage();
}

let renderToken = 0;
async function showPage() {
  const p = current();
  const token = ++renderToken;
  const base = { ...p, rot: 0 };
  const size = await deps.pageSize(base);
  pageW = size.width;
  pageH = size.height;
  const wrap = $('#edScroll');
  const fit = Math.min((wrap.clientWidth - 48) / pageW, 2.2);
  const dpr = window.devicePixelRatio || 1;
  const c = await deps.renderPage(base, fit * dpr);
  if (token !== renderToken) return;
  scalePx = fit;
  canvas = c;
  c.style.width = `${pageW * fit}px`;
  c.style.height = `${pageH * fit}px`;
  const stage = $('#edStage');
  stage.style.width = `${pageW * fit}px`;
  stage.style.height = `${pageH * fit}px`;
  stage.style.setProperty('--pt', `${fit}px`);
  stage.querySelector('canvas')?.remove();
  stage.prepend(c);
  $('#edPrev').disabled = index === 0;
  $('#edNext').disabled = index === list.length - 1;
  $('#edUndo').disabled = !undoStack.some((u) => u.id === p.id);
  textLines = [];
  drawLayer();
  changed();
  // linhas de texto existentes (para "Editar texto")
  const page = await deps.sourcePage(p);
  const lines = await extractLines(page, page.getViewport({ scale: 1 }));
  if (token !== renderToken) return;
  textLines = lines;
  drawLayer();
}

function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('#edStage').dataset.tool = t;
  $('#edHint').textContent = {
    select: 'Clique em um item para selecioná-lo e arraste para mover. Duplo clique em um texto para editar.',
    edittext: 'Clique em um trecho do documento para reescrevê-lo.',
    text: 'Clique onde o texto deve começar.',
    cover: 'Arraste sobre o que deseja apagar (a área é coberta com a cor do fundo; selecione-a e mude a cor se quiser).',
    highlight: 'Arraste sobre o trecho que deseja destacar.',
    ink: 'Desenhe ou assine com o mouse.',
  }[t];
  if (t !== 'select') select(null);
  drawLayer();
}

function toggleStyle(sel, prop) {
  $(sel).classList.toggle('on');
  applyStyle(prop);
}

function applyStyle() {
  const e = pageEdits().find((x) => x.id === selectedId);
  if (!e) return;
  pushUndo();
  const s = style();
  if (e.type === 'text') Object.assign(e, s);
  else if (e.type === 'rect' && e.kind === 'cover' && document.activeElement === $('#edColor')) e.color = s.color;
  else if (e.type === 'ink') e.color = s.color;
  drawLayer();
  changed();
}

function select(id) {
  selectedId = id;
  const e = id && pageEdits().find((x) => x.id === id);
  if (e?.type === 'text') {
    $('#edFont').value = e.font;
    $('#edSize').value = Math.round(e.size * 10) / 10;
    $('#edBold').classList.toggle('on', e.bold);
    $('#edItalic').classList.toggle('on', e.italic);
    $('#edColor').value = e.color;
  } else if (e && e.kind !== 'highlight' && e.color) {
    $('#edColor').value = e.color;
  }
  $('#edDelete').disabled = !id;
  document.querySelectorAll('#edLayer [data-id]').forEach((el) => el.classList.toggle('selected', Number(el.dataset.id) === id));
}

function deleteSelected() {
  if (!selectedId) return;
  pushUndo();
  const arr = pageEdits();
  arr.splice(arr.findIndex((x) => x.id === selectedId), 1);
  select(null);
  drawLayer();
  changed();
}

function undo() {
  const p = current();
  for (let i = undoStack.length - 1; i >= 0; i--) {
    if (undoStack[i].id !== p.id) continue;
    const [u] = undoStack.splice(i, 1);
    edits.set(p.id, JSON.parse(u.data));
    select(null);
    drawLayer();
    changed();
    break;
  }
  $('#edUndo').disabled = !undoStack.some((u) => u.id === p.id);
}

// ---------- Desenho da camada ----------

const pct = (v) => `${v * 100}%`;

function drawLayer() {
  const layer = $('#edLayer');
  layer.replaceChildren();
  if (tool === 'edittext') {
    const used = new Set(pageEdits().filter((e) => e.fromLine != null).map((e) => e.fromLine));
    textLines.forEach((l, i) => {
      if (used.has(i)) return;
      const el = document.createElement('div');
      el.className = 'ed-line';
      el.dataset.line = i;
      Object.assign(el.style, {
        left: pct(l.x / pageW),
        top: pct((l.y - l.size * 0.92) / pageH),
        width: pct(Math.max(l.width, l.size) / pageW),
        height: pct((l.size * 1.15) / pageH),
      });
      layer.append(el);
    });
  }
  for (const e of pageEdits()) layer.append(renderEdit(e));
  select(selectedId);
}

function renderEdit(e) {
  let el;
  if (e.type === 'text') {
    if (e.cover) {
      const cov = document.createElement('div');
      cov.className = 'ed-cover-under';
      Object.assign(cov.style, { left: pct(e.cover.x), top: pct(e.cover.y), width: pct(e.cover.w), height: pct(e.cover.h), background: e.cover.color });
      const frag = document.createElement('div');
      frag.style.display = 'contents';
      frag.append(cov);
      el = document.createElement('div');
      el.className = 'ed-item ed-text';
      el.textContent = e.text;
      frag.append(el);
      styleText(el, e);
      el.dataset.id = e.id;
      return frag;
    }
    el = document.createElement('div');
    el.className = 'ed-item ed-text';
    el.textContent = e.text;
    styleText(el, e);
  } else if (e.type === 'rect') {
    el = document.createElement('div');
    el.className = `ed-item ed-rect ${e.kind}`;
    Object.assign(el.style, { left: pct(e.x), top: pct(e.y), width: pct(e.w), height: pct(e.h), background: e.color });
    el.append(handle());
  } else if (e.type === 'image') {
    el = document.createElement('div');
    el.className = 'ed-item ed-image';
    Object.assign(el.style, { left: pct(e.x), top: pct(e.y), width: pct(e.w), height: pct(e.h) });
    const img = new Image();
    img.src = e.src;
    img.draggable = false;
    el.append(img, handle());
  } else if (e.type === 'ink') {
    el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('class', 'ed-item ed-ink');
    el.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
    el.setAttribute('preserveAspectRatio', 'none');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', e.points.map(([x, y]) => `${x * pageW},${y * pageH}`).join(' '));
    line.setAttribute('stroke', e.color);
    line.setAttribute('stroke-width', e.width);
    el.append(line);
  }
  el.dataset.id = e.id;
  return el;
}

function styleText(el, e) {
  Object.assign(el.style, {
    left: pct(e.x),
    top: pct(e.y),
    fontFamily: FONTS[e.font].css,
    fontSize: `calc(var(--pt) * ${e.size})`,
    fontWeight: e.bold ? '700' : '400',
    fontStyle: e.italic ? 'italic' : 'normal',
    color: e.color,
    lineHeight: String(LINE_HEIGHT),
  });
}

function handle() {
  const h = document.createElement('span');
  h.className = 'ed-handle';
  return h;
}

// ---------- Ponteiro ----------

function point(ev) {
  const r = $('#edStage').getBoundingClientRect();
  return [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
}

function track(onMove, onUp) {
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    onUp?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const target = ev.target;
  if (target.isContentEditable) return;
  const [x, y] = point(ev);

  if (tool === 'select') {
    const itemEl = target.closest('[data-id]');
    if (!itemEl) return select(null);
    const e = pageEdits().find((it) => it.id === Number(itemEl.dataset.id));
    select(e.id);
    ev.preventDefault();
    const resizing = target.classList.contains('ed-handle');
    const start = JSON.stringify(e);
    let moved = false;
    track(
      (m) => {
        const [mx, my] = point(m);
        const dx = mx - x;
        const dy = my - y;
        if (!moved && Math.hypot(dx * pageW, dy * pageH) < 2) return;
        if (!moved) {
          undoStack.push({ id: current().id, data: JSON.stringify(pageEdits().map((it) => (it.id === e.id ? JSON.parse(start) : it))) });
          moved = true;
        }
        const s = JSON.parse(start);
        if (resizing) {
          e.w = Math.max(0.01, s.w + dx);
          e.h = e.type === 'image' ? e.w * (s.h / s.w) * (pageW / pageW) : Math.max(0.005, s.h + dy);
        } else if (e.type === 'ink') {
          e.points = s.points.map(([px, py]) => [px + dx, py + dy]);
        } else {
          e.x = s.x + dx;
          e.y = s.y + dy;
          if (e.cover) e.cover = { ...s.cover };
        }
        drawLayer();
      },
      () => moved && changed()
    );
    return;
  }

  if (tool === 'text') {
    ev.preventDefault();
    const s = style();
    const e = { id: nextEditId++, type: 'text', x, y: y - (s.size * 0.6) / pageH, text: '', ...s };
    pushUndo();
    pageEdits().push(e);
    drawLayer();
    editText(e);
    return;
  }

  if (tool === 'edittext') {
    const lineEl = target.closest('.ed-line');
    if (!lineEl) return;
    ev.preventDefault();
    editExistingLine(Number(lineEl.dataset.line));
    return;
  }

  if (tool === 'cover' || tool === 'highlight') {
    ev.preventDefault();
    const e = {
      id: nextEditId++,
      type: 'rect',
      kind: tool,
      x, y, w: 0, h: 0,
      // apagar usa a cor do fundo da página no ponto clicado (branco na maioria dos documentos)
      color: tool === 'highlight' ? '#ffe600' : backgroundAt(x * pageW, y * pageH),
    };
    pushUndo();
    pageEdits().push(e);
    track(
      (m) => {
        const [mx, my] = point(m);
        Object.assign(e, { x: Math.min(x, mx), y: Math.min(y, my), w: Math.abs(mx - x), h: Math.abs(my - y) });
        drawLayer();
      },
      () => {
        if (e.w * pageW < 3 || e.h * pageH < 3) {
          pageEdits().splice(pageEdits().indexOf(e), 1);
          undoStack.pop();
        }
        drawLayer();
        changed();
      }
    );
    return;
  }

  if (tool === 'ink') {
    ev.preventDefault();
    const e = { id: nextEditId++, type: 'ink', points: [[x, y]], color: $('#edColor').value, width: Math.max(1, (Number($('#edSize').value) || 12) / 6) };
    pushUndo();
    pageEdits().push(e);
    track(
      (m) => {
        e.points.push(point(m));
        drawLayer();
      },
      () => {
        if (e.points.length < 2) e.points.push([x + 0.001, y]);
        changed();
      }
    );
  }
}

// Duplo clique num texto (ferramenta Mover) também edita
document.addEventListener('dblclick', (ev) => {
  const el = ev.target.closest?.('#edLayer .ed-text');
  if (!el || tool !== 'select') return;
  const e = pageEdits().find((x) => x.id === Number(el.dataset.id));
  if (e) editText(e);
});

function editText(e) {
  const el = $(`#edLayer .ed-text[data-id="${e.id}"]`);
  if (!el) return;
  select(e.id);
  el.contentEditable = 'plaintext-only';
  el.classList.add('editing');
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const before = e.text;
  el.addEventListener(
    'blur',
    () => {
      el.contentEditable = 'false';
      const text = el.innerText.replace(/\n$/, '');
      if (!text.trim() && !e.cover) {
        // texto novo vazio: descarta
        const arr = pageEdits();
        const i = arr.indexOf(e);
        if (i >= 0) arr.splice(i, 1);
        if (!before) undoStack.pop();
      } else if (text !== before) {
        if (before) pushUndo();
        e.text = text;
      }
      drawLayer();
      changed();
    },
    { once: true }
  );
}

// ---------- Editar texto existente ----------

function sampleArea(x, y, w, h) {
  const ratio = canvas.width / pageW;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const px = (v) => Math.max(0, Math.round(v * ratio));
  const data = ctx.getImageData(px(x), px(y), Math.max(1, px(w)), Math.max(1, px(h))).data;
  return data;
}

// Cor de fundo: a mais comum na borda da caixa; cor do texto: a mais distante do fundo.
function sampleColors(l) {
  const top = l.y - l.size * 0.92;
  const h = l.size * 1.15;
  const counts = new Map();
  const edge = [...sampleArea(l.x - 2, top - 1, l.width + 4, 1), ...sampleArea(l.x - 2, top + h, l.width + 4, 1)];
  // agrupa tons parecidos e usa a média do grupo mais frequente
  for (let i = 0; i < edge.length; i += 4) {
    const k = ((edge[i] >> 3) << 10) | ((edge[i + 1] >> 3) << 5) | (edge[i + 2] >> 3);
    const c = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += edge[i]; c.g += edge[i + 1]; c.b += edge[i + 2];
    counts.set(k, c);
  }
  let group = { n: 0, r: 255, g: 255, b: 255 };
  for (const c of counts.values()) if (c.n > group.n) group = c;
  const best = group.n;
  const bg = best ? [group.r / best, group.g / best, group.b / best].map(Math.round) : [255, 255, 255];
  const inner = sampleArea(l.x, top, l.width, h);
  let far = [0, 0, 0];
  let farD = -1;
  for (let i = 0; i < inner.length; i += 4) {
    const d = Math.abs(inner[i] - bg[0]) + Math.abs(inner[i + 1] - bg[1]) + Math.abs(inner[i + 2] - bg[2]);
    if (d > farD) (farD = d), (far = [inner[i], inner[i + 1], inner[i + 2]]);
  }
  const hex = (c) => `#${c.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')}`;
  const textColor = far.every((v) => v < 70) ? '#000000' : hex(far);
  return { bg: best > 0 ? hex(bg) : '#ffffff', text: textColor };
}

function backgroundAt(x, y) {
  const d = sampleArea(x - 1, y - 1, 3, 3);
  const hex = (v) => v.toString(16).padStart(2, '0');
  return `#${hex(d[0])}${hex(d[1])}${hex(d[2])}`;
}

function editExistingLine(i) {
  const l = textLines[i];
  const run = l.runs[0];
  const family = /Times|Georgia|Garamond|Cambria|Book|Serif/i.test(run.family) ? 'Times' : /Courier|Mono|Consol/i.test(run.family) ? 'Courier' : 'Helvetica';
  const colors = sampleColors(l);
  const pad = Math.max(1, l.size * 0.08);
  const e = {
    id: nextEditId++,
    type: 'text',
    fromLine: i,
    x: l.x / pageW,
    y: (l.y - l.size * BASELINE) / pageH,
    text: l.runs.map((r) => r.text).join(''),
    font: family,
    size: Math.round(l.size * 10) / 10,
    bold: run.bold,
    italic: run.italic,
    color: colors.text,
    cover: {
      x: (l.x - pad) / pageW,
      y: (l.y - l.size * 0.92 - pad / 2) / pageH,
      w: (l.width + pad * 2) / pageW,
      h: (l.size * 1.15 + pad) / pageH,
      color: colors.bg,
    },
  };
  pushUndo();
  pageEdits().push(e);
  setTool('select');
  editText(e);
}

// ---------- Imagem ----------

function addImage(file) {
  if (!/^image\/(png|jpeg)$/.test(file.type)) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const w = Math.min(0.4, (img.naturalWidth * 0.75) / pageW);
      const h = w * (img.naturalHeight / img.naturalWidth) * (pageW / pageH);
      const e = { id: nextEditId++, type: 'image', x: (1 - w) / 2, y: Math.max(0, (1 - h) / 2), w, h, src: reader.result };
      pushUndo();
      pageEdits().push(e);
      setTool('select');
      select(e.id);
      drawLayer();
      changed();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
