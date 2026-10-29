// Busca um arquivo detectado na página: direto pela extensão ou, se não der, pelo content script.

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function fetchFromPage(url, tabId, frameId, accept) {
  // 1) a extensão tenta direto (tem permissão de host e envia cookies)
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (r.ok) {
      const buf = await r.arrayBuffer();
      if (accept(buf)) return buf;
    }
  } catch {
    // segue para o fallback
  }
  // 2) pede para o content script buscar no contexto da página (blob:, sessões restritas)
  if (tabId != null) {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'fetch-pdf', url }, { frameId }).catch(() => null);
    if (res?.data) {
      const buf = base64ToBuffer(res.data);
      if (accept(buf)) return buf;
    }
  }
  throw new Error('não foi possível obter o arquivo da página. Baixe-o e arraste-o para cá.');
}
