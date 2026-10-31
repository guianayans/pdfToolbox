// Roda no contexto da própria página (world MAIN): sites como o WhatsApp Web decifram o arquivo
// no navegador e o entregam como blob:, sem passar pela rede como PDF nem deixar link .pdf no DOM.
// Registra esses blobs (guardando o arquivo, porque o site costuma revogar o link logo depois)
// e avisa o content.js, que pede o arquivo de volta quando o usuário abre o documento.
// Também olha os dados de mensagens recebidas (postMessage): o WhatsApp Web abre o PDF num
// visualizador em iframe (webtp.whatsapp.net) e manda os bytes para ele por mensagem.
(() => {
  if (window.__pdfToolboxHook) return;
  window.__pdfToolboxHook = true;

  const TAG = 'pdf-toolbox-hook';
  const MAX_KEEP = 12;
  const MAX_BYTES = 150 * 1024 * 1024;
  const kept = new Map(); // url -> { blob, kind, name?, own? }
  const names = new Map(); // url -> nome do download
  const WORD_MIME = /msword|wordprocessingml/i;

  const createObjectURL = URL.createObjectURL;
  const anchorClick = HTMLAnchorElement.prototype.click;

  async function kindOf(blob) {
    if (/pdf/i.test(blob.type)) return 'pdf';
    if (WORD_MIME.test(blob.type) || /\.docx?$/i.test(blob.name || '')) return 'word';
    // tipo vazio/genérico: confere a assinatura %PDF-
    if (blob.type && !/octet-stream|binary/i.test(blob.type)) return null;
    if (blob.size < 5 || blob.size > MAX_BYTES) return null;
    const head = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head) === '%PDF-' ? 'pdf' : null;
  }

  async function track(url, blob, extra = {}) {
    try {
      const kind = extra.kind || (await kindOf(blob));
      if (!kind) return;
      kept.set(url, { blob, kind, ...extra });
      let bytes = [...kept.values()].reduce((n, k) => n + k.blob.size, 0);
      for (const [u, k] of kept) {
        if (kept.size <= MAX_KEEP && bytes <= MAX_BYTES) break;
        kept.delete(u);
        if (k.own) URL.revokeObjectURL(u);
        bytes -= k.blob.size;
      }
      // o nome costuma vir logo depois, no <a download> que o site clica
      setTimeout(() => announce(url), 50);
    } catch {}
  }

  function announce(url) {
    const k = kept.get(url);
    if (k) window.postMessage({ [TAG]: 'found', url, kind: k.kind, name: k.blob.name || names.get(url) || k.name || '' }, '*');
  }

  // ---- arquivos recebidos por mensagem (window.postMessage ou MessagePort) ----
  const seenEvents = new WeakSet();
  const seenData = new WeakSet();
  const announced = new Set(); // tamanho + nome, para não repetir o mesmo arquivo
  const FILE_NAME = /\.(pdf|docx?)$/i;

  const signature = (bytes) => {
    if (bytes.length < 5) return null;
    if (String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
    return bytes[0] === 0x50 && bytes[1] === 0x4b ? 'zip' : null; // .docx é um zip
  };

  function fromMessage(data) {
    const files = [];
    let name = '';
    (function walk(v, depth) {
      if (v == null || depth > 4 || typeof v !== 'object' && typeof v !== 'string') return;
      if (typeof v === 'string') {
        if (!name && v.length < 300 && FILE_NAME.test(v)) name = v.split(/[\\/]/).pop();
        return;
      }
      if (seenData.has(v)) return;
      seenData.add(v);
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
        const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
        if (bytes.length > 1000 && bytes.length <= MAX_BYTES) files.push(bytes);
        return;
      }
      if (v instanceof Blob) {
        if (v.size > 1000 && v.size <= MAX_BYTES) files.push(v);
        if (!name && FILE_NAME.test(v.name || '')) name = v.name;
        return;
      }
      const keys = Array.isArray(v) ? v.keys() : Object.keys(v);
      let n = 0;
      for (const k of keys) {
        if (++n > 50) break;
        try {
          walk(v[k], depth + 1);
        } catch {}
      }
    })(data, 0);
    for (const f of files) found(f, name);
  }

  async function found(file, name) {
    try {
      const head = file instanceof Blob ? new Uint8Array(await file.slice(0, 5).arrayBuffer()) : file.subarray(0, 5);
      let kind = signature(head);
      if (kind === 'zip') kind = /\.docx?$/i.test(name) ? 'word' : null;
      if (!kind) return;
      const size = file instanceof Blob ? file.size : file.length;
      if (announced.has(`${size}:${name}`)) return;
      announced.add(`${size}:${name}`);
      // cópia dos bytes: o site pode transferir ou reaproveitar o buffer depois
      const blob = file instanceof Blob ? file : new Blob([file.slice()], { type: kind === 'pdf' ? 'application/pdf' : '' });
      const url = createObjectURL.call(URL, blob);
      track(url, blob, { kind, name, own: true });
    } catch {}
  }

  // passar pelo getter de MessageEvent.data cobre window.postMessage e MessagePort
  const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
  Object.defineProperty(MessageEvent.prototype, 'data', {
    configurable: true,
    enumerable: true,
    get() {
      const data = dataGetter.call(this);
      if (data && typeof data === 'object' && !seenEvents.has(this)) {
        seenEvents.add(this);
        if (!data[TAG]) {
          try {
            fromMessage(data);
          } catch {}
        }
      }
      return data;
    },
  });

  function rememberName(a) {
    if (!a.download || !a.href.startsWith('blob:') || names.get(a.href) === a.download) return;
    names.set(a.href, a.download);
    announce(a.href);
  }

  URL.createObjectURL = function (obj) {
    const url = createObjectURL.apply(this, arguments);
    if (obj instanceof Blob) track(url, obj);
    return url;
  };

  HTMLAnchorElement.prototype.click = function () {
    rememberName(this);
    return anchorClick.apply(this, arguments);
  };
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target.closest?.('a[download][href^="blob:"]');
      if (a) rememberName(a);
    },
    true
  );

  // content.js pede o arquivo guardado (o link blob: pode já ter sido revogado)
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.[TAG] !== 'get') return;
    window.postMessage({ [TAG]: 'blob', id: e.data.id, blob: kept.get(e.data.url)?.blob || null }, '*');
  });
})();
