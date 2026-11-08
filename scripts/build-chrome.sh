#!/bin/sh
# Gera dist/pdf_toolbox-<versão>.zip para enviar à Chrome Web Store.
# Só entram os arquivos da extensão (nada de docs/, store/, firefoxExtension/ etc.).
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./manifest.json").version')
OUT="dist/pdf_toolbox-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
zip -qr -X "$OUT" manifest.json LICENSE background.js capture.js content.js editor.css editor.html editor.js \
  annotate.js docx2pdf.js fetch-file.js page-hook.js pdf2docx.js word.css word.html word.js \
  options.css options.html options.js popup.css popup.html popup.js icons lib -x '*.DS_Store'
echo "Pronto: $OUT"
