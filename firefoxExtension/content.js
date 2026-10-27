// Content script: procura PDFs no DOM (anexos do Gmail, links, embeds) e
// busca os bytes no contexto da página quando a extensão não consegue sozinha.
(() => {
  if (window.__pdfToolboxInjected) return;
  window.__pdfToolboxInjected = true;

  const MAX = 200;
  const found = new Map();

  const nameFromUrl = (url) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'documento.pdf';
    } catch {
      return 'documento.pdf';
    }
  };

  const isPdfPath = (url) => {
    try {
      return /\.pdf$/i.test(new URL(url, location.href).pathname);
    } catch {
      return false;
    }
  };

  function add(rawUrl, name, source) {
    if (found.size >= MAX || !rawUrl) return;
    let url;
    try {
      url = new URL(rawUrl, location.href).href;
    } catch {
      return;
    }
    if (!/^(https?:|blob:)/.test(url) || found.has(url)) return;
    let finalName = (name || '').trim() || nameFromUrl(url);
    if (!/\.pdf$/i.test(finalName)) finalName += '.pdf';
    found.set(url, { url, name: finalName, source });
  }

  function scan() {
    const before = found.size;

    // Gmail: chips de anexo têm download_url="mime:nome:url"
    document.querySelectorAll('[download_url]').forEach((el) => {
      const m = (el.getAttribute('download_url') || '').match(/^([^:]+):([^:]+):(.+)$/);
      if (m && (/pdf/i.test(m[1]) || /\.pdf$/i.test(m[2]))) add(m[3], m[2], 'gmail');
    });

    document.querySelectorAll('a[href]').forEach((a) => {
      if (isPdfPath(a.href)) add(a.href, a.getAttribute('download'), 'link');
    });

    document.querySelectorAll('embed, object, iframe').forEach((el) => {
      const src = el.src || el.data;
      if (src && (/pdf/i.test(el.type || '') || isPdfPath(src))) add(src, null, 'embed');
    });

    if (document.contentType === 'application/pdf') add(location.href, null, 'página');

    if (found.size !== before) {
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
      .then((buf) => sendResponse({ data: toBase64(buf) }))
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  });
})();
