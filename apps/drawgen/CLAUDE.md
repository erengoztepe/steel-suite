# apps/drawgen — IOM+IFC → DXF detay çizimi

IDEA StatiCa export'undan ev-stiline uygun AutoCAD detayı (DXF R2018) üretir. Girdi
**hibrit** ve bu bilinçli: **IOM** semantik omurgadır (plaka poligon+kalınlık, BoltGrid,
WeldData, CrossSection dims, cut/op), **IFC** ise coped katı geometri kaynağıdır (cope,
çentik, delik mesh'e baked-in — IDEA'nın gerçekten uyguladığı geometri). `.ideacon`
propriyeter; export şart. IOM birimi metre → mm.

Bu klasör yalnız TS tarafı: IOM ingest (`src/ingest/`), DrawingSpec + görünüş planlama
(`src/drawing/`), web arayüzü + HTTP rotaları (`src/web/`). DXF'i **`server/render.py`**
yazar, coped silüeti **`server/ifc_geom.py`** üretir; ikisi kökte.

```bash
npx tsx src/drawing/build.ts <iom.xml> <spec.json> [--units=mm|cm] [--rotate]
python server/render.py <spec.json> <out.dxf> [out.png]
npx tsx src/drawing/planreport.ts <iom.xml>     # görünüş planını denetle
```

## Mimari kararlar

**Görünüş seçimi hibrittir** (`src/drawing/viewplan.ts`): arketip ŞABLONU tercih edilen
çerçeveleri/adları/sırayı verir, **bilgi-kapsama guard'ı** eksik kalanı kapatır (en çok 2
ek görünüş, sonra `REVIEW` bayrağı — sessiz eksiklik yok). Elle `views.push([...])` listesi
YOKTUR, geri getirme. Çıktı düz liste değil **AĞAÇ**: her SECTION'ın tam bir kesit işareti
vardır ve o işaret mevcut bir görünüşün içindedir; hiyerarşik numaralama (01 → 01.1) bu ağaçtan gelir; izometrik
ağacın dışındadır (numara/balon yok). Plan spec'e `viewPlan` olarak yazılır.

**Çerçeveler öznitelik-türevlidir, global eksene çivili değil** — eleman eksenleri, flanş/
plaka normalleri, cıvata eksenleri. Bu, dönme-değişmezlik testinin geçmesinin sebebidir;
global eksene dönmek testi anında kırar. Yön vektörünü **iki nokta farkından kurma**
(`farEnd − joint` 7° sapma verip 2°'lik paralellik testini düşürdü); yönü elemanın kendi
ekseninden al, joint'i yalnız işaret için kullan.

**Ayna yönü ev konvansiyonudur, geometri değil.** Öznitelik yalnız bakış doğrusunu sabitler;
±yön aynı bilgiyi aynalı verir ve arketip başına farklı seçilebilir (taşınan eleman sağda ya
da solda). Şablona yazılır. Kozmetik değil: yön, cıvata takımının plaka paketinin
önünde mi arkasında mı olduğunu belirler — yanlışsa occlusion glifleri haklı olarak siler.

**Birim:** `views.ts` her zaman **kanonik mm** üretir; `meta.units` → `render.py` tek bir `S`
faktörü uygular (mm=1.0, cm=0.1), `DIMLFAC=1/S` sayesinde ölçü metinleri iki modda da mm
okur. Linetype tablosu **asla ölçeklenmez** (fiziksel tire boyunu belgenin birimi belirler).
Geometri motoru mm'de KALIR çünkü toleransları mutlak mm (`buffer(-0.5)`, `min_area=2.0`,
`eps=0.5`) — bu yüzden `_scale_spec` `views`/`occluders`/`poly3d.points`'i ölçeklemez.
Yeni entity tipi eklerken `_scale_spec`'e branch eklemezsen artık exception atar.

## Tuzaklar (hepsi bir kez düşüldü)

- **`ezdxf`: `add_hatch(dxfattribs={"color": 256})` SESSİZCE çalışmaz** — pozisyonel
  `color=7` default'u `dxfattribs`'i ezer. Renk niyeti varsa kolaylık parametresini kullan:
  `add_hatch(color=256, dxfattribs={...})`. Aynı DXF attribute'unu ikisine birden verme.
- **`add_linear_dim(...)` ham entity değil `DimStyleOverride` döndürür**; `.dxf.geometry`
  için `dim.dimension` üzerinden git. `.render()` çağırmayı da unutma (yoksa AutoCAD
  göstermez).
- **Occlusion `direction`'ı = görünüşün NORMAL'i** (`cross(view.u, view.v)`, ± flipDepth),
  asla eleman/cıvata ekseni. Occlusion "göz ile nokta arasında malzeme var mı" sorusudur;
  başka eksen farklı bir soruya cevap verir.
- **Kesilen çelik TARANIR:** rol `cut` + profilin `hatch` deseni/ölçeği. "`cut` ama
  taramasız" tutarsız bir üçüncü durumdur. Kesilmiyorsa tarama yok, rol `visible`.
- **Etiket = kesit adı** (`HEA260`, IOM `CrossSection.Name`), **görünüş başlığı = parça
  markası** (IOM `BeamData.Name`) — iki parça aynı profili paylaşabilir, tersi görünüşleri
  ayırt edilemez yapar. Ana görünüşün başlığı bağlantı markasının kendisidir.
- **Çizgi önceliği (görünür > gizli) bizde uygulanmalı.** Bazı CAD export'ları çakışan gizli
  kenarı bastırmaz; bu bir export artefaktıdır, konvansiyon değil (ISO 128).
- **Katman adı yazma, role çiz.** Kod `visible`/`hidden`/`text`/`dimension`… rollerine çizer;
  gerçek katman/renk/linetype ve ev-stili boyutları stil profilinden gelir
  (`src/model/style.ts` ↔ `server/house_style.py`, aynı çözümleme sırası; spec
  `meta.styleProfile`'ı taşır). Ofise özgü değer koda ya da `default.json`'a girmez.
- **Her kenarın tek sahibi olmalı.** `webLines` gibi "elle telafi" çizimler eklemeden önce
  aynı kenarı başka bir geçişin çizip çizmediğini kontrol et. IFC kesilmemiş elemanı gerçek
  I-prizması verir (24 köşe = uç başına 12), kutu DEĞİL — `drawIProfile`'ın var olma sebebi
  **kök radyusları**, "IFC kutu veriyor" değil.
- **Painter'ın tüm çizim metodları KAĞIT uzayı bekler.** Yerel-frame layout yapılan yerde
  `L(u,v) => [u+ox, v+oy]` closure'ı şart; unutulunca sayfayı kat eden hayalet ölçü çizgisi
  çıkıyor.

Çizim kuralları, stil profili ve kusur sınıfları: `docs/drawing-conventions.md` (§2 stil
profili, §8 çizim mekanizmaları — kod yorumlarındaki `docs 8.x` atıfları buraya).
