# Chrome Web Store: textos para o painel

Pacote: `dist/pdf_toolbox-<versão>.zip` (gerado por `scripts/build-chrome.sh`)
Imagens: `store/screenshot-*.png` (1280×800) e `store/promo-440x280.png`
Ícone da loja: `icons/icon128.png`

---

## Aba "Detalhes do item" (Store listing)

**Idioma:** Português (Brasil)
**Categoria:** Ferramentas (Tools)

**Nome:** PDF Toolbox
*(vem do manifest)*

**Resumo:** vem do `description` do manifest:
> Detecta PDFs e Word nas páginas (Gmail, sites): edite o PDF, converta em Word ou imagem, extraia, divida e junte páginas.

**Descrição:**

```
PDF Toolbox encontra os PDFs e documentos Word de qualquer página (anexos do Gmail, portais, sites de empresas) e deixa você trabalhar com eles direto no navegador, sem enviar nada para servidores.

📄 DETECÇÃO AUTOMÁTICA
• Mostra no ícone quantos PDFs e documentos Word a página tem
• Funciona com links, anexos do Gmail, PDFs abertos em abas e iframes, e PDFs do WhatsApp Web
• Baixe ou abra qualquer um com um clique

✏️ EDITOR DE PDF
• Edite textos existentes, adicione texto, destaque, desenhe, apague áreas e assine
• Reorganize páginas arrastando, gire, exclua e desfaça
• Salve só as páginas selecionadas ou divida em um PDF por página (.zip)
• Junte vários PDFs em um só
• Numere páginas, adicione marca d'água e comprima

🔄 CONVERSÕES
• PDF → Word (.docx), mantendo o visual ou como texto editável
• Word → PDF
• PDF → imagem (PNG ou JPG, com escolha de DPI)
• Extrair texto (.txt)

✂️ CAPTURA DE PÁGINA
• Selecione uma área da página e salve em PNG, JPG ou PDF, ou copie direto (Ctrl+Shift+S / Cmd+Shift+S)
• Copie o texto da área selecionada, inclusive de imagens e prints: o texto é lido por OCR no seu computador (português e inglês)
• Página inteira em PDF ou PNG, rolando até o fim
• Só a área visível

🔒 PRIVACIDADE
• Todo o processamento acontece no seu navegador
• Nenhum arquivo é enviado para servidores
• Sem anúncios, sem rastreamento, sem coleta de dados
• Código aberto: https://github.com/guianayans/pdfToolbox
```

**Site oficial (opcional):** https://github.com/guianayans/pdfToolbox
**URL de suporte:** https://github.com/guianayans/pdfToolbox/issues

---

## Aba "Práticas de privacidade" (Privacy)

**Finalidade única (Single purpose):**

```
Find PDF and Word documents on web pages and let the user view, edit, convert, split and merge them, or save part of the page as an image, PDF or text, entirely inside the browser.
```

**Justificativas das permissões:**

`webRequest`
```
Used only to read the Content-Type and Content-Disposition response headers so the extension can recognize when a page, iframe or download is a PDF or Word document (including attachments served without a .pdf link, e.g. Gmail). Requests are never blocked, modified or recorded; only the document URL and file name are kept in session storage to list them in the popup.
```

`webNavigation`
```
Used to clear the per-tab list of detected documents when the user navigates to a new page, so the popup and badge only show documents from the current page.
```

`storage`
```
chrome.storage.session keeps the per-tab list of detected documents (cleared when the browser closes). chrome.storage.local keeps one user preference (copy format: PNG, PDF or text).
```

`downloads`
```
Saves files the user explicitly creates or asks to download: edited PDFs, converted Word/image files, split pages and page captures.
```

`scripting`
```
Injects the area-selection overlay into the current tab when the user clicks "Select area" or presses the keyboard shortcut, and runs a helper during full-page capture to scroll the page and measure its height.
```

`offscreen`
```
Runs optical character recognition (Tesseract.js, bundled with the extension) in a hidden extension document when the user clicks "Text" on a selected area that contains an image. Service workers cannot start the Web Worker the OCR engine needs. The image is processed locally and never leaves the computer.
```

**Permissão de host (`<all_urls>`):**
```
The core feature is detecting PDF and Word documents on any website the user visits (email, government portals, company sites), which cannot be limited to a fixed list of domains. Host access is also needed to download a detected document with the user's existing session when they choose to open it (e.g. Gmail attachments), and for tabs.captureVisibleTab in the page-capture feature. No page content is sent anywhere; everything is processed locally.
```

**Código remoto:** Não, não uso código remoto.
```
All JavaScript and WebAssembly, including libraries (pdf.js, pdf-lib, JSZip, html2canvas, docx-preview, Tesseract.js with its OCR language data), is bundled in the package. No code is fetched or evaluated at runtime. The 'wasm-unsafe-eval' CSP entry is only used to run the bundled Tesseract OCR WebAssembly; its default CDN URLs were replaced with local extension paths.
```

**Uso de dados:** não marcar nenhum tipo de dado coletado. Marcar as 3 declarações:
- [x] Não vendo nem transfiro dados de usuários a terceiros, fora dos casos de uso aprovados
- [x] Não uso nem transfiro dados de usuários para fins não relacionados à finalidade única do item
- [x] Não uso nem transfiro dados de usuários para determinar a capacidade de crédito ou para empréstimos

**URL da política de privacidade:**
```
https://guianayans.github.io/pdfToolbox/privacidade.html
```

---

## Aba "Distribuição"

- **Visibilidade:** Pública
- **Regiões:** Todas
- **Preço:** Gratuito

## Dica para a revisão sair mais rápido

No envio, há um campo opcional de **instruções de teste**. Cole:
```
No login needed. Open any page with a PDF link (e.g. https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf or a page linking to it). The toolbar badge shows the count; click the icon → "Ferramentas" opens the editor. "Selecionar área" (Ctrl+Shift+S) starts the area capture; after selecting, "Texto" copies the text in the area (OCR runs locally if the area is an image).
```
