const $ = (s) => document.querySelector(s);

function openEditor(params) {
  const qs = new URLSearchParams(params).toString();
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html${qs ? `?${qs}` : ''}`) });
  window.close();
}

function host(url) {
  if (url.startsWith('blob:')) return 'arquivo gerado pela página';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.runtime.sendMessage({ type: 'stop-blink', tabId: tab.id });

  const k = `tab_${tab.id}`;
  const items = ((await chrome.storage.session.get(k))[k] || []).slice().reverse();

  $('#count').textContent = items.length || '';
  $('#empty').hidden = items.length > 0;

  const list = $('#list');
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="file-icon">PDF</div>
      <div class="info">
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <div class="actions">
        <button class="icon" data-act="download" title="Baixar original">⬇</button>
        <button class="primary" data-act="edit" title="Abrir ferramentas">Ferramentas</button>
      </div>`;
    li.querySelector('.name').textContent = item.name;
    li.querySelector('.name').title = item.name;
    li.querySelector('.meta').textContent = `${item.source} · ${host(item.url)}`;
    li.querySelector('[data-act=edit]').onclick = () =>
      openEditor({ url: item.url, name: item.name, tab: tab.id, frame: item.frameId ?? 0 });
    li.querySelector('[data-act=download]').onclick = () =>
      chrome.downloads.download({ url: item.url, filename: item.name.replace(/[\\/:*?"<>|]/g, '_') });
    list.append(li);
  }

  $('#captureTitle').textContent = items.length ? 'Ou capturar esta página' : 'Capturar esta página';
  setupCapture(tab);

  $('#clear').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear-tab', tabId: tab.id });
    init();
  };
}

function setupCapture(tab) {
  const status = $('#capStatus');
  const show = (msg, isError = false) => {
    status.textContent = msg;
    status.classList.toggle('error', isError);
    status.hidden = false;
  };
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.onclick = async () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach((b) => (b.disabled = true));
      show(mode === 'select' ? 'Abrindo seleção…' : 'Gerando arquivo…');
      const res = await chrome.runtime
        .sendMessage(mode === 'select' ? { type: 'start-selection', tabId: tab.id } : { type: 'capture-page', mode, tabId: tab.id })
        .catch((e) => ({ error: String(e.message || e) }));
      if (res?.error) {
        show(res.error, true);
        document.querySelectorAll('[data-mode]').forEach((b) => (b.disabled = false));
      } else if (res?.note) {
        show(res.note);
        setTimeout(() => window.close(), 6000);
      } else {
        window.close();
      }
    };
  });
}

$('#openLocal').onclick = () => openEditor({});
init();
