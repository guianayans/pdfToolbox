// OCR local (Tesseract) do texto de uma imagem. Nada sai do computador: o motor e os
// idiomas (português + inglês) vêm empacotados em lib/ocr/.
// No Chrome/Comet roda num documento offscreen (o service worker não cria Workers);
// no Firefox é carregado direto na página de fundo.
(() => {
  const url = (p) => chrome.runtime.getURL(p);
  let worker = null;
  let idle = 0;

  function getWorker() {
    worker ??= Tesseract.createWorker(['por', 'eng'], 1, {
      workerPath: url('lib/ocr/worker.min.js'),
      corePath: url('lib/ocr/tesseract-core-simd-lstm.wasm.js'),
      langPath: url('lib/ocr'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
    }).catch((e) => {
      worker = null;
      throw e;
    });
    return worker;
  }

  // libera a memória (~100 MB) depois de um tempo sem uso
  function scheduleRelease() {
    clearTimeout(idle);
    idle = setTimeout(async () => {
      const w = worker;
      worker = null;
      (await w?.catch(() => null))?.terminate();
      if (chrome.offscreen && location.pathname.endsWith('/ocr.html')) close();
    }, 120000);
  }

  async function ocr(dataUrl) {
    clearTimeout(idle);
    try {
      const w = await getWorker();
      const { data } = await w.recognize(dataUrl);
      return data.text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } finally {
      scheduleRelease();
    }
  }

  self.pdfToolboxOcr = ocr;

  if (location.pathname.endsWith('/ocr.html')) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.target !== 'ocr') return;
      ocr(msg.dataUrl).then(
        (text) => sendResponse({ text }),
        (e) => sendResponse({ error: String(e?.message || e) })
      );
      return true;
    });
  }
})();
