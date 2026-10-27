#!/bin/sh
# Gera firefoxExtension/ a partir do código da raiz (o mesmo da versão Chrome/Comet).
# Só o manifest muda: sem a API debugger (não existe no Firefox) e com background como
# página de eventos. Rode de novo sempre que alterar a extensão.
set -e
cd "$(dirname "$0")/.."
OUT=firefoxExtension

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R background.js capture.js content.js editor.css editor.html editor.js \
  popup.css popup.html popup.js icons lib LICENSE "$OUT/"

node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
m.background = { scripts: ["lib/pdf-lib.min.js", "background.js"] };
m.permissions = m.permissions.filter((p) => p !== "debugger");
m.browser_specific_settings = {
  gecko: {
    id: "pdftoolbox@guianayans",
    strict_min_version: "140.0",
    data_collection_permissions: { required: ["none"] },
  },
  gecko_android: { strict_min_version: "142.0" },
};
fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n");
' "$OUT/manifest.json"

echo "Pronto: $OUT/ (Firefox → about:debugging → Carregar extensão temporária → $OUT/manifest.json)"
