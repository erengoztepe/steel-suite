# Birleşik dev sunucusu (tek localhost, üç sekme)

IFC viewer (`apps/viewer` — Member Vectors, birleşim geometrisi çıkarımı) ile çizim aracı
(`apps/drawgen` — IOM+IFC → DXF) tek bir web uygulamasında, iki sekme olarak çalışır. Tek
süreç, tek port: **http://localhost:5177**.

```bash
npm install     # workspaces: iki uygulamayı birden kurar
pip install -e .
npm run dev
```

## Mimari

Sunucu `apps/viewer/dev-server.mts`: Express üzerine kurulur ve **Vite'ı middleware
mode**'da içine gömer. Bu yüzden tek origin vardır — proxy ya da CORS katmanı yok:

- `/config`, `/browse`, `/generate`, `/download` → `apps/drawgen/src/web/api.ts`'ten
  gelen Express router. Vite'ın SPA fallback'inden **önce** monte edilir, çünkü çizim
  sayfası bu yolları absolute çağırır.
- `/api/sap/*` + `/sap/` → "Null Facade" sekmesi. 1) viewer'da yüklü tüm IFC'lerden SAP2000'e
  girecek yapı IFC'si (`tools/sap/ifc_to_structure.py`; viewer modelleri aynı origin'deki iframe'e
  `window.__steelSuiteIfcSources` ile açar). 2) `.sdb` yükle, dış cepheyi `None` kesitli area ile kapla
  (`tools/sap/fill_sdb.py`), yeni `.sdb`'yi indir. Sayfa `apps/viewer/src/server/sap-public/`
  (çizim sayfasıyla aynı görünüm, iframe), rotalar `sap-api.ts`. SAP2000 lisansı tek örnek
  izin verdiği için iş **açık SAP2000 penceresinde** yapılır (yoksa başlatılır); işler sıraya
  alınır. Ara dosyalar `apps/viewer/tmp/sap/` (git-ignored).
- `/drawing/` → `apps/drawgen/src/web/public/`, olduğu yerden statik servis. Çizim sekmesi
  bunu **iframe** ile gösterir: sayfa kendi (açık temalı) stiliyle, React'e taşınmadan
  kalır.
- geri kalan her şey → Vite (viewer, `public/wasm`, `worker.mjs`, `models/`).

İki uygulama arasındaki tek dikiş `api.ts` importudur. Sunucu `tsx` altında koştuğu için
kardeş workspace'ten `.ts` dosyasını doğrudan import etmek yeterli; derleme adımı yok.

## Hangi değişiklik nasıl yansır

| Değiştirdiğin yer | Yansıma |
|---|---|
| `apps/viewer/**` (React) | Vite HMR — aynı port üzerinden ws, sayfa yenilenmez |
| `apps/drawgen/src/web/public/**` | livereload → **yalnız** iframe yenilenir (viewer'daki yüklü IFC korunur) |
| `apps/drawgen/src/web/api.ts` | `tsx watch` sunucuyu yeniden başlatır |
| `apps/drawgen/src/drawing/**`, `server/render.py` | her istekte yeni süreç — yeniden başlatma gerekmez |

## Bilinmesi gerekenler

- **İki sunucu aynı anda çalışmaz.** `npm run dev` ile `npm run dev:drawgen` ikisi de
  5177'yi ve livereload'un 35729'unu ister. İkinci bir çalışma kopyası için
  `PORT=5178 LIVERELOAD_PORT=35730 npm run dev` (launch.json: "dev (side port 5178)").
- Viewer tek başına çalışmaya devam eder: `npm run dev:viewer` (port 5173, Vite'ın kendi
  sunucusu). Sekme çubuğu orada **görünmez** — birleşik sunucu HTML'e
  `window.__COMBINED_SHELL__` enjekte eder, `AppShell` bunu senkron okur. Fetch ile
  sorulsaydı sekme çubuğu mount'tan sonra eklenir; 3D canvas boyutlandıktan sonraki bu
  layout kayması canvas'ı taşırıp kaydırma çubuğu doğurur, o da yüksekliği tekrar kırpar.
- Sekme değişiminde iki pano da **mount kalır** (`visibility` ile saklanır, `display:none`
  ile değil): viewer'ın WASM+IFC'yi baştan yüklemesi ve `display:none` container'ın
  renderer'a 0×0 bildirmesi engellenir; çizim sekmesi de seçili dosyaları korur.
- `tsx watch`, Vite'ın root'a yazıp sildiği `vite.config.mts.timestamp-*` dosyasını görüp
  sonsuz restart döngüsüne girer; `apps/viewer` içindeki `dev:combined` betiğindeki
  `--exclude` bunu keser.
- Statik viewer paketi: `npm run build:viewer` → `apps/viewer/dist/`. `published/viewer/`
  bu build'in daha eski, commit'lenmiş bir kopyasıdır (viewer deposunun kökünde
  duruyordu).
