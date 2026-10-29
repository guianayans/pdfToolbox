// Conversão PDF → Word (.docx) feita no navegador, sem servidor.
//
// Modo "layout": cada linha de texto vira um parágrafo editável posicionado no mesmo lugar da
// página (quadro com posição absoluta), com fonte, tamanho, negrito/itálico e cor detectados.
// Tudo que não é texto (fundos, tabelas, linhas, logotipos) vai como imagem atrás do texto,
// então o visual fica igual ao do PDF.
// Modo "fluxo": só o texto, reagrupado em parágrafos normais, mais fácil de reescrever.

import * as pdfjsLib from './lib/pdf.min.mjs';

const BG_SCALE = 2; // resolução da imagem de fundo (2 = 144 DPI)
const TWIP = 20; // 1 pt = 20 twips
const EMU = 12700; // 1 pt = 12700 EMU

const esc = (s) =>
  String(s)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Nome interno da fonte no PDF ("ABCDEF+Arial-BoldMT") → família que o Word conhece.
const FAMILY_ALIASES = {
  helvetica: 'Arial',
  arialmt: 'Arial',
  arial: 'Arial',
  timesnewroman: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  times: 'Times New Roman',
  timesroman: 'Times New Roman',
  courier: 'Courier New',
  couriernew: 'Courier New',
  couriernewps: 'Courier New',
  symbolmt: 'Symbol',
};
export function mapFont(rawName, generic) {
  const name = String(rawName || '').replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(name);
  const italic = /italic|oblique|-it$|,it$/i.test(name);
  let family = name.split(/[-,]/)[0].replace(/(PS)?MT$|PS$/, '');
  if (!family || /^(g_|f\d|font|t\d|tt\d)/i.test(family) || family.length < 2) {
    family = /serif/.test(generic) && !/sans/.test(generic) ? 'Times New Roman' : /mono/.test(generic) ? 'Courier New' : 'Arial';
  } else {
    family = FAMILY_ALIASES[family.toLowerCase()] || family.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return { family, bold, italic };
}

// ---------- Leitura da página ----------

function renderTo(page, viewport, withText) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!withText) {
    // o pdf.js desenha o texto com fillText/strokeText: sem eles sobra só o "fundo" da página
    ctx.fillText = () => {};
    ctx.strokeText = () => {};
  }
  return page.render({ canvasContext: ctx, viewport }).promise.then(() => canvas);
}

const hex = (r, g, b) => [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Cor do texto: pixels que mudam entre a página com e sem texto, dentro da caixa da linha.
function sampleColor(full, bare, box) {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.min(full.width - x, Math.ceil(box.w));
  const h = Math.min(full.height - y, Math.ceil(box.h));
  if (w <= 0 || h <= 0) return '000000';
  const a = full.getContext('2d').getImageData(x, y, w, h).data;
  const b = bare.getContext('2d').getImageData(x, y, w, h).data;
  const diff = new Float32Array(a.length / 4);
  let max = 0;
  for (let i = 0; i < a.length; i += 4) {
    diff[i / 4] = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    max = Math.max(max, diff[i / 4]);
  }
  let r = 0, g = 0, bl = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (diff[i / 4] < Math.max(40, max * 0.85)) continue; // só o miolo das letras, sem a borda suavizada
    r += a[i]; g += a[i + 1]; bl += a[i + 2]; n++;
  }
  if (!n) return '000000';
  const c = [r / n, g / n, bl / n];
  // tons quase pretos viram preto puro (texto comum fica limpo no Word)
  return c.every((v) => v < 60) ? '000000' : hex(...c);
}

function isBlank(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let dirty = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) dirty++;
  return dirty < (data.length / 16) * 0.001;
}

const inside = (cx, cy, r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;

/**
 * Linhas de texto da página, em pontos e com origem no canto superior esquerdo da página exibida.
 * covers: retângulos normalizados (0–1) que escondem texto (ex.: texto apagado no editor).
 */
export async function extractLines(page, viewport, covers = []) {
  const content = await page.getTextContent();
  const base = page.getViewport({ scale: 1, rotation: viewport.rotation });
  const W = base.width;
  const H = base.height;
  const items = [];
  for (const it of content.items) {
    // espaços soltos (o pdf.js os cria para preencher vãos, inclusive entre colunas) são recriados pela distância
    if (!it.str?.trim() || !it.transform) continue;
    const t = pdfjsLib.Util.transform(base.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    if (size < 1) continue;
    const x = t[4];
    const y = t[5]; // linha de base
    const width = it.width;
    if (covers.some((r) => inside((x + width / 2) / W, (y - size * 0.35) / H, r))) continue;
    let font;
    try {
      font = page.commonObjs.get(it.fontName);
    } catch {
      font = null;
    }
    const style = mapFont(font?.name, content.styles[it.fontName]?.fontFamily || '');
    items.push({ str: it.str, x, y, size, width, ...style });
  }

  // agrupa pedaços na mesma linha de base e próximos entre si (colunas de tabela ficam separadas)
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < Math.max(r.size, it.size) * 0.35);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, size: it.size, items: [it] });
  }
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let line = null;
    for (const it of row.items) {
      const end = line ? line.x + line.width : 0;
      const gap = it.x - end;
      if (!line || gap > Math.max(line.size, it.size) * 1.2 || Math.abs(it.size - line.size) > line.size * 0.3) {
        line = { x: it.x, y: it.y, size: it.size, width: 0, runs: [] };
        lines.push(line);
      } else if (gap > it.size * 0.12 && !/\s$/.test(line.runs.at(-1).text) && !/^\s/.test(it.str)) {
        line.runs.at(-1).text += ' ';
      }
      const last = line.runs.at(-1);
      if (last && last.family === it.family && last.bold === it.bold && last.italic === it.italic) last.text += it.str;
      else line.runs.push({ text: it.str, family: it.family, bold: it.bold, italic: it.italic });
      line.width = it.x + it.width - line.x;
      line.size = Math.max(line.size, it.size);
    }
  }
  return lines.filter((l) => l.runs.some((r) => r.text.trim()));
}

// ---------- Montagem do .docx ----------

function runXml(run, size) {
  const props = [
    `<w:rFonts w:ascii="${esc(run.family)}" w:hAnsi="${esc(run.family)}" w:cs="${esc(run.family)}" w:eastAsia="${esc(run.family)}"/>`,
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    run.color && run.color !== '000000' ? `<w:color w:val="${run.color}"/>` : '',
    `<w:sz w:val="${Math.max(2, Math.round(size * 2))}"/><w:szCs w:val="${Math.max(2, Math.round(size * 2))}"/>`,
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(run.text)}</w:t></w:r>`;
}

// Parágrafo em quadro com posição absoluta na página (o "layout fiel").
function framedLineXml(line) {
  const size = line.size;
  const lineH = size * 1.15;
  const top = line.y - size * 0.92; // a linha de base fica ~0,92 do tamanho abaixo do topo da linha
  return (
    `<w:p><w:pPr><w:framePr w:wrap="around" w:hAnchor="page" w:vAnchor="page" ` +
    `w:x="${Math.round(line.x * TWIP)}" w:y="${Math.round(Math.max(0, top) * TWIP)}"/>` +
    `<w:spacing w:before="0" w:after="0" w:line="${Math.round(lineH * TWIP)}" w:lineRule="exact"/>` +
    `<w:ind w:left="0" w:right="0"/></w:pPr>` +
    line.runs.map((r) => runXml(r, size)).join('') +
    `</w:p>`
  );
}

function backgroundXml(rId, id, W, H) {
  const cx = Math.round(W * EMU);
  const cy = Math.round(H * EMU);
  return (
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:drawing>` +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="1" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
    `<wp:docPr id="${id}" name="Fundo da página ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="fundo${id}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`
  );
}

function sectionXml(W, H, margin, last) {
  const sect =
    `<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="${Math.round(W * TWIP)}" w:h="${Math.round(H * TWIP)}"${W > H ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  return last ? sect : `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${sect}</w:pPr></w:p>`;
}

// Modo fluxo: linhas próximas e alinhadas viram um único parágrafo.
function flowParagraphsXml(lines) {
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const paras = [];
  let cur = null;
  for (const l of sorted) {
    const prev = cur?.lines.at(-1);
    const joins =
      prev &&
      l.y - prev.y > 0 &&
      l.y - prev.y < Math.max(prev.size, l.size) * 1.7 &&
      Math.abs(l.size - prev.size) < prev.size * 0.2 &&
      Math.abs(l.x - cur.x) < prev.size * 3;
    if (joins) cur.lines.push(l);
    else paras.push((cur = { x: l.x, lines: [l] }));
  }
  return paras
    .map((p) => {
      const runs = [];
      p.lines.forEach((l, i) => {
        l.runs.forEach((r, j) => {
          const text = i > 0 && j === 0 && !/[\s-]$/.test(runs.at(-1)?.text || '') ? ` ${r.text}` : r.text;
          runs.push({ ...r, text, size: l.size });
        });
      });
      return `<w:p><w:pPr><w:spacing w:before="0" w:after="${Math.round(p.lines[0].size * 0.6 * TWIP)}"/></w:pPr>${runs.map((r) => runXml(r, r.size)).join('')}</w:p>`;
    })
    .join('');
}

const NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="708"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

/**
 * Converte páginas pdf.js em .docx.
 * getPage(i) → { page, rotation } (rotation: giro final da página, em graus)
 * options.mode: 'layout' | 'flow'
 * options.extras[i]: { covers: [{x,y,w,h}] normalizados, lines: [...] } para a página i
 * options.onProgress(i, total)
 */
export async function pdfToDocx(getPage, total, { mode = 'layout', extras = [], onProgress } = {}) {
  const zip = new JSZip();
  const rels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
  ];
  let body = '';
  let hasText = false;

  for (let i = 0; i < total; i++) {
    onProgress?.(i, total);
    const { page, rotation } = await getPage(i);
    const vp1 = page.getViewport({ scale: 1, rotation });
    const W = vp1.width;
    const H = vp1.height;
    const extra = extras[i] || {};
    const vp = page.getViewport({ scale: BG_SCALE, rotation });

    // renderizar antes de ler o texto carrega as fontes (nomes reais em commonObjs)
    const bare = await renderTo(page, vp, false);
    const full = mode === 'layout' ? await renderTo(page, vp, true) : null;
    const lines = (await extractLines(page, vp1, extra.covers)).concat(extra.lines || []);
    if (lines.length) hasText = true;

    if (mode === 'layout') {
      for (const l of lines) {
        if (l.color) continue; // linhas vindas do editor já trazem a cor
        const box = { x: l.x * BG_SCALE, y: (l.y - l.size * 0.8) * BG_SCALE, w: l.width * BG_SCALE, h: l.size * BG_SCALE };
        const color = sampleColor(full, bare, box);
        l.runs.forEach((r) => (r.color = color));
      }
      if (!isBlank(bare)) {
        const blob = await new Promise((ok) => bare.toBlob(ok, 'image/jpeg', 0.88));
        const n = i + 1;
        zip.file(`word/media/fundo${n}.jpeg`, blob);
        rels.push(`<Relationship Id="rIdBg${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fundo${n}.jpeg"/>`);
        body += backgroundXml(`rIdBg${n}`, n, W, H);
      } else {
        body += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>';
      }
      body += lines.map(framedLineXml).join('');
    } else {
      body += flowParagraphsXml(lines) || '<w:p/>';
    }
    full && (full.width = full.height = 0);
    bare.width = bare.height = 0;

    const margin = mode === 'layout' ? 0 : 1134; // fluxo: margens de 2 cm
    body += sectionXml(W, H, margin, i === total - 1);
  }

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
  );
  zip.file('word/styles.xml', STYLES);
  zip.file('word/settings.xml', SETTINGS);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}</w:body></w:document>`);

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
  return { blob, hasText };
}
