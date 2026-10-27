const radios = [...document.querySelectorAll('input[name=copyFormat]')];
const saved = document.getElementById('saved');
if (!navigator.platform.startsWith('Mac')) document.getElementById('key').textContent = 'Ctrl+C';

function show(value) {
  for (const r of radios) r.checked = r.value === (value || 'ask');
}

chrome.storage.local.get('copyFormat').then((r) => show(r.copyFormat));
// atualiza se a escolha for lembrada na página enquanto esta aba estiver aberta
chrome.storage.onChanged.addListener((changes) => changes.copyFormat && show(changes.copyFormat.newValue));

for (const r of radios) {
  r.addEventListener('change', async () => {
    await chrome.storage.local.set({ copyFormat: r.value });
    saved.hidden = false;
    clearTimeout(show.t);
    show.t = setTimeout(() => (saved.hidden = true), 1500);
  });
}
