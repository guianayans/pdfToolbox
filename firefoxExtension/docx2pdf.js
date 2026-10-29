// Word (.docx) → visualização HTML (docx-preview) e → PDF.
// O PDF é montado com cada página desenhada como imagem em alta resolução, para poder ser aberto
// nas Ferramentas; para um PDF com texto selecionável use "Salvar como PDF" no visualizador.

const RASTER_SCALE = 2;

export const isZip = (buf) => {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return b[0] === 0x50 && b[1] === 0x4b;
};

// .doc antigo (formato binário do Word 97–2003): não dá para ler no navegador
export const isLegacyDoc = (buf) => {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
};

/** Renderiza o .docx dentro de `container`; devolve as páginas (elementos section.docx). */
export async function renderDocx(buffer, container) {
  if (isLegacyDoc(buffer)) throw new Error('arquivo .doc antigo: abra no Word e salve como .docx para converter.');
  if (!isZip(buffer)) throw new Error('o arquivo não é um documento Word (.docx) válido.');
  const styles = document.createElement('div');
  const body = document.createElement('div');
  container.replaceChildren(styles, body);
  await window.docx.renderAsync(buffer, body, styles, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    useBase64URL: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    experimental: true,
  });
  await document.fonts.ready;
  const sections = [...body.querySelectorAll('section.docx')];
  // documentos sem tamanho de página (alguns gerados fora do Word): A4 com margens de 2,5 cm
  for (const sec of sections) {
    if (!sec.style.width) Object.assign(sec.style, { width: '210mm', minHeight: '297mm', padding: '25mm', boxSizing: 'border-box' });
  }
  return sections;
}

// Desenha a página no canvas com html2canvas (um SVG com foreignObject "contamina" o canvas no
// Chrome e impede exportar a imagem).
async function elementToCanvas(section) {
  const rect = section.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  const canvas = await window.html2canvas(section, {
    scale: RASTER_SCALE,
    backgroundColor: '#ffffff',
    logging: false,
    useCORS: true,
    width,
    height,
  });
  return { canvas, width, height };
}

/** .docx → bytes de PDF (páginas como imagem). */
export async function docxToPdf(buffer, { onProgress } = {}) {
  const host = document.createElement('div');
  // fora da tela, mas renderizado (precisa de layout para medir as páginas)
  host.style.cssText = 'position:absolute;left:-100000px;top:0;width:auto;pointer-events:none;';
  document.body.append(host);
  try {
    const sections = await renderDocx(buffer, host);
    if (!sections.length) throw new Error('documento vazio.');
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    for (let i = 0; i < sections.length; i++) {
      onProgress?.(i, sections.length);
      const { canvas, width, height } = await elementToCanvas(sections[i]);
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.92));
      canvas.width = canvas.height = 0;
      const jpg = await out.embedJpg(await blob.arrayBuffer());
      // 1 px CSS = 0,75 pt
      out.addPage([width * 0.75, height * 0.75]).drawImage(jpg, { x: 0, y: 0, width: width * 0.75, height: height * 0.75 });
    }
    return out.save();
  } finally {
    host.remove();
  }
}
