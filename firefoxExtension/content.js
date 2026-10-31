// Content script: procura PDFs e documentos Word no DOM (anexos do Gmail, links, embeds) e
// busca os bytes no contexto da página quando a extensão não consegue sozinha.
(() => {
  if (window.__pdfToolboxInjected) return;
  window.__pdfToolboxInjected = true;

  const MAX = 200;
  const found = new Map();
  let changes = 0;
  let sent = 0;

  const nameFromUrl = (url) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {
      return '';
    }
  };

  const pathMatches = (url, re) => {
    try {
      return re.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  };
  const isPdfPath = (url) => pathMatches(url, /\.pdf$/i);
  const isWordPath = (url) => pathMatches(url, /\.docx?$/i);
  const WORD_MIME = /msword|wordprocessingml/i;

  function add(rawUrl, name, source, kind = 'pdf') {
    if (found.size >= MAX || !rawUrl) return;
    let url;
    try {
      url = new URL(rawUrl, location.href).href;
    } catch {
      return;
    }
    // arquivo em blob: cujo nome só chegou depois: atualiza o nome
    if (!/^(https?:|blob:)/.test(url) || (found.has(url) && !(name && found.get(url).rename))) return;
    let finalName = (name || '').trim() || (url.startsWith('blob:') ? '' : nameFromUrl(url)) || 'documento';
    if (kind === 'pdf' && !/\.pdf$/i.test(finalName)) finalName += '.pdf';
    if (kind === 'word' && !/\.docx?$/i.test(finalName)) finalName += '.docx';
    if (found.get(url)?.name === finalName) return;
    found.set(url, { url, name: finalName, source, kind, rename: !name && url.startsWith('blob:') });
    changes++;
  }

  // blobs de PDF/Word criados pela página (WhatsApp Web etc.), avisados pelo page-hook.js
  const HOOK = 'pdf-toolbox-hook';
  const waiting = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.[HOOK]) return;
    const d = e.data;
    if (d[HOOK] === 'found' && typeof d.url === 'string' && d.url.startsWith('blob:')) {
      add(d.url, typeof d.name === 'string' ? d.name : '', 'página', d.kind === 'word' ? 'word' : 'pdf');
      schedule();
    } else if (d[HOOK] === 'blob' && waiting.has(d.id)) {
      waiting.get(d.id)(d.blob instanceof Blob ? d.blob : null);
      waiting.delete(d.id);
    }
  });

  function blobFromPage(url) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      waiting.set(id, resolve);
      window.postMessage({ [HOOK]: 'get', id, url }, '*');
      setTimeout(() => waiting.delete(id) && resolve(null), 3000);
    });
  }

  function scan() {
    // Gmail: chips de anexo têm download_url="mime:nome:url"
    document.querySelectorAll('[download_url]').forEach((el) => {
      const m = (el.getAttribute('download_url') || '').match(/^([^:]+):([^:]+):(.+)$/);
      if (!m) return;
      if (/pdf/i.test(m[1]) || /\.pdf$/i.test(m[2])) add(m[3], m[2], 'gmail');
      else if (WORD_MIME.test(m[1]) || /\.docx?$/i.test(m[2])) add(m[3], m[2], 'gmail', 'word');
    });

    document.querySelectorAll('a[href]').forEach((a) => {
      if (isPdfPath(a.href)) add(a.href, a.getAttribute('download'), 'link');
      else if (isWordPath(a.href)) add(a.href, a.getAttribute('download'), 'link', 'word');
    });

    document.querySelectorAll('embed, object, iframe').forEach((el) => {
      const src = el.src || el.data;
      if (src && (/pdf/i.test(el.type || '') || isPdfPath(src))) add(src, null, 'embed');
    });

    if (document.contentType === 'application/pdf') add(location.href, null, 'página');

    if (changes !== sent) {
      sent = changes;
      try {
        chrome.runtime.sendMessage({ type: 'pdfs-found', items: [...found.values()] }).catch(() => {});
      } catch {
        // extensão recarregada: contexto invalidado
      }
    }
  }

  let pending = null;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      scan();
    }, 800);
  };

  scan();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href', 'src', 'download_url'],
  });

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'fetch-pdf') return;
    fetch(msg.url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .catch(async (e) => {
        // link blob: já revogado pela página: usa a cópia guardada pelo page-hook.js
        const blob = msg.url.startsWith('blob:') && (await blobFromPage(msg.url));
        if (!blob) throw e;
        return blob.arrayBuffer();
      })
      .then((buf) => sendResponse({ data: toBase64(buf) }))
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  });
})();
