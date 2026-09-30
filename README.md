# steel-suite

IDEA StatiCa / IFC modellerinden **çelik bağlantı detay çizimi** üreten araç takımı.
İki uygulama tek web arayüzünde, iki sekme olarak çalışır.

## Kurulum ve çalıştırma

```bash
npm install        # workspaces: iki uygulamayı birden kurar
pip install -e .   # steeldraw + ezdxf (DXF render'ı için gerekli)
npm run dev        # iki sekme, tek port -> http://localhost:5177
```

| Komut | Ne yapar |
|---|---|
| `npm run dev` | Birleşik: IFC viewer + çizim aracı, `:5177` ([nasıl çalıştığı](docs/combined-dev-server.md)) |
| `npm run dev:viewer` | Yalnız viewer (Vite, `:5173`) |
| `npm run dev:drawgen` | Yalnız çizim aracı (`:5177`) |
| `npm run build:viewer` | Viewer'ın statik paketi → `apps/viewer/dist/` |
| `npm run test:py` / `verify` | pytest / IOM çıkarım doğrulaması |

İkisi aynı anda koşamaz: `dev` ve `dev:drawgen` aynı portu ve livereload'un 35729'unu ister.

## Yerleşim

```
apps/viewer/        IFC viewer (React + web-ifc/@thatopen) — birleşim geometrisi çıkarımı,
                    IDEA'ya girilecek vektör/node/offset/rotasyon; birleşik dev sunucusu
                    da burada (dev-server.mts)
apps/drawgen/       IOM(.xml)+IFC(.ifc) -> DrawingSpec (TS) + sürükle-bırak web arayüzü
server/             render.py: DrawingSpec -> DXF (ezdxf) + stil profili + kesit/cıvata verisi
src/steeldraw/      parametrik üreteç kütüphanesi (aşağısı bunu anlatır)
tools/  tests/      DXF adli analiz/doğrulama betikleri; pytest + golden fixture'lar
samples/ iom+ifc/   örnek IOM/IFC girdileri
docs/               çizim konvansiyonları + stil profili, birleşik sunucu notu
published/viewer/   viewer'ın commit'li (eski) statik build'i
```

Not: kökteki `src/` **Python** paketidir (`pyproject.toml` bu düzeni bekler);
`apps/*/src` ise TypeScript kaynaklarıdır.

## Ev stili = stil profili

Çizim kodu nötr **rollere** çizer (`visible`, `hidden`, `axis`, `bolt`, `text`, `dimension`,
`hatch` …); rollerin gerçek katman/renk/linetype karşılığı ve tüm ev-stili boyutları (metin
yükseklikleri, ölçü tiki, ok başları, balonlar, tarama) bir JSON **stil profilinden** gelir.
Depoyla nötr bir ISO profili gelir (`server/style_profiles/default.json`); kendi ofis stilin
için onu `server/style_profiles/local.json`'a kopyalayıp düzenle (git-ignored). Seçim sırası:
`$STEEL_STYLE_PROFILE` > `local.json` > `default.json`. Ayrıntı:
[docs/drawing-conventions.md](docs/drawing-conventions.md).

Bağlantı fixture'ları (`fixtures/`), golden imzalar (`tests/golden/`) ve viewer'ın varsayılan
modeli (`apps/viewer/public/models/default.ifc`) yereldir; kendi dosyalarını koy.

## steeldraw kütüphanesi

Çelik yapı bağlantı/birleşim detaylarının teknik çizimini programatik olarak
**DXF** formatında üretir. İki standardı da parametrik destekler:
**AISC** (emperyal, AWS A2.4 kaynak) ve **Eurocode 3 / TS EN 1993-1-8** (metrik, ISO 2553 kaynak).

```bash
python examples/demo_finplate.py   # output/ altında iki DXF üretir
```

```
src/steeldraw/
  standards/          # standart-parametrik değer katmanı (mm cinsinden çıktı)
    base.py           # ortak arayüz: BoltGeometry, HoleType, WeldConvention, kayıt
    aisc.py           # AISC 360 J3.3/J3.4/J3.5 tabloları (inç -> mm)
    eurocode.py       # EN 1993-1-8 Tablo 3.3 + EN 1090-2 Tablo 11
  dxf/
    layers.py         # NCS 'S-' katman seti (renk/linetype/kalınlık)
    document.py       # DXF fabrikası: linetype, text/dim stili, EN ISO 129-1
    symbols.py        # tekrar eden semboller (cıvata deliği, part-mark) = BLOCK
  connections/
    base.py           # Connection tabanı + add_linear_dim_rendered()
    finplate.py       # fin plate (kesme bağlantısı) üreteci — ilk dikey dilim
```

Yeni bağlantı tipi eklemek: `Connection`'dan türet, `draw(msp, doc)` yaz,
geometriyi `self.standard.bolt(...)` üzerinden al (standarttan bağımsız kalır).

## Standart haritası (hangi standart neyi tanımlar)

| Alan | Standart |
|---|---|
| Bağlantı geometrisi (US) | AISC 360 (J3.3 delik, J3.4 kenar, J3.5 max) + AISC 303 (çizim türü) |
| Bağlantı geometrisi (EU) | EN 1993-1-8 Tablo 3.3 + EN 1090-2 Tablo 11 (delik) + SCI P358 |
| Kaynak sembolü | AWS A2.4 (US) / ISO 2553 (ISO) |
| Ölçülendirme | EN ISO 129-1 (metin ölçü çizgisinin üstünde, her ölçü bir kez) |
| Çizgi tipi/kalınlık | ISO 128-2 |
| Katman düzeni | US National CAD Standard (NCS) / AIA — yapısal disiplin kodu 'S' |

## Doğrulanmış geometri değerleri (birincil kaynaktan)

**AISC 360-16/-22** (inç):
- Standart delik = çap + 1/16 (≤7/8″), üstü + 1/8. Ör. 3/4″ → 13/16″ (20.64 mm).
- Min kenar mesafesi: **tek sütun** (kesilmiş/haddelenmiş ayrımı 2010'da kaldırıldı). 3/4″ → 1″.
- Min aralık = **2⅔·d** (kod min), tercih **3·d**. Max kenar = min(12t, 6″); max aralık = min(24t, 12″).

**Eurocode** (mm, d0 = delik çapı):
- EN 1090-2 normal delik: M12/M14 → +1, M16–M24 → +2, M27–M36 → +3. **M20 → 22 mm**.
- EN 1993-1-8 Tablo 3.3 min: e1=e2=**1.2·d0**, p1=**2.2·d0**, p2=**2.4·d0**. Max: p1=min(14t, 200).
- İyi uygulama (tam ezilme, Tablo 3.4): e1=3.0d0, e2=1.5d0, p1=3.75d0, p2=3.0d0.

## ⚠ Hardcode edilmeyen / dikkat edilen noktalar

Araştırmada **çürütülen** yaygın (ama yanlış) değerler — testlerle korunuyor:
1. Delik ≠ çap+2/+3 mm sabiti → EN 1090-2 Tablo 11'den cıvata boyutuna göre.
2. Min aralık ≠ 3d, min kenar ≠ 1.5–2D → AISC 2⅔d / EC3 2.2·d0.
3. 3rd-party hesap sitelerinin OVS/oval değerleri hatalı → standart tablodan.
4. **AWS ↔ ISO 2553 kaynak sembolü ok-tarafı yerleşimi farklıdır** → `WeldConvention`
   parametresinden gelir, asla sabitlenmez.

## ezdxf pratikleri (uygulanan)

- Stil **katman düzeyinde** merkezi; entity'ler BYLAYER ile miras alır.
- Tekrar eden semboller **BLOCK** (`doc.blocks.new` + `add_blockref`).
- `add_linear_dim(...)` sonrası **`dim.render()` zorunlu** (yoksa AutoCAD göstermez) —
  `connections/base.py::add_linear_dim_rendered` bunu sarmalar.
- Paperspace için DXF **R2000+** (varsayılan R2010).

## Test

```bash
pytest -q
```
