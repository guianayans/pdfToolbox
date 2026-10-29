import { renderDocx, isZip, isLegacyDoc } from './docx2pdf.js';
import { fetchFromPage } from './fetch-file.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const name = params.get('name') || 'documento.docx';

$('#docTitle').textContent = name;
document.title = `${name} · PDF Toolbox`;

// a página de impressão usa o tamanho de papel do próprio documento
function pageSizeRule(section) {
  const w = section.style.width || section.style.minWidth;
  const h = section.style.minHeight || section.style.height;
  if (!w || !h) return;
  const style = document.createElement('style');
  style.textContent = `@media print { @page { size: ${w} ${h}; margin: 0; } }`;
  document.head.append(style);
}

async function load() {
  const url = params.get('url');
  if (!url) throw new Error('nenhum documento informado.');
  $('#download').hidden = false;
  $('#download').onclick = () => chrome.downloads.download({ url, filename: name.replace(/[\\/:*?"<>|]/g, '_') });
  const buf = await fetchFromPage(url, Number(params.get('tab')), Number(params.get('frame') || 0), (b) => isZip(b) || isLegacyDoc(b));
  const sections = await renderDocx(buf, $('#doc'));
  if (sections[0]) pageSizeRule(sections[0]);
  // na impressão o PDF recebe o nome do documento
  document.title = name.replace(/\.docx?$/i, '');
  $('#print').disabled = false;
  $('#edit').disabled = false;
}

$('#print').onclick = () => window.print();
$('#edit').onclick = () => {
  const qs = new URLSearchParams({ ...Object.fromEntries(params), kind: 'word' });
  location.href = chrome.runtime.getURL(`editor.html?${qs}`);
};

load().catch((e) => {
  const box = document.createElement('div');
  box.className = 'error';
  box.textContent = `Não foi possível abrir o documento: ${e.message || e}`;
  $('#doc').replaceChildren(box);
});
