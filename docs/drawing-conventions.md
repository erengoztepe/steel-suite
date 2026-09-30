# Çizim konvansiyonları ve stil profili

Bu doküman çizim üretecinin (`apps/drawgen` + `server/`) uyguladığı **genel çizim
kurallarını** ve bir ofisin kendi ev stilini koda dokunmadan tanımlamasını sağlayan **stil
profili** mekanizmasını anlatır.

> **Bölüm numaraları sabittir.** Kod yorumları bu dokümana `docs 8.x` biçiminde atıf yapar
> (ör. `docs 8.6`, `docs 8.12/D4-D5`). §8 altındaki numaraları değiştirme; yeni konu eklerken
> sona ekle.

---

## 1. Kanıt disiplini (yöntem)

Bir kuralı koda almadan önce kanıtının sınıfı belirlenir:

- **[VERİ]** — bir DXF'ten ezdxf ile ölçülebilen bulgu (entity, koordinat, katman, attribute).
  Birincil kanıt budur.
- **[RASTER]** — yalnız bir görüntüden/PDF'ten okunan çıkarım. DXF ile doğrulanana kadar
  **hipotezdir**. Doğrulanmamış raster çıkarımını "veri" gibi hardcode etmek düz hardcode'dan
  ağır borçtur: hem yanlıştır hem de doğru sanıldığı için düzeltilmez.
- **[ŞABLON] ≠ [DETAY]** — bir örnek DXF çoğu zaman yayınlanmış detayın yanında ofisin
  standart legend/şablon bloklarını da taşır (tanımlı blok, dimstyle, legend örnekleri).
  Şablondan okunan bir kural, yayınlanmış detayın **çizilmiş** hâlinde geçerli olmayabilir
  (ör. dimstyle 45° tik tanımlar ama detayda çizilen tik farklı eğimdedir). Üretim hedefi
  detayın çizilmiş hâlidir; kural okunmadan önce entity'nin hangi bölgede durduğu ölçülür.

Doğrulama sırası: **önce ÖLÇ, sonra bak.** Üretilen DXF geri okunur ve ölçülür
(`tools/verify_drawing.py`); golden imza (`tests/golden/*.json`, yerel) **rol** başına entity
sayısı, ölçü değerleri, yay yarıçapları ve extent taşır. Görüntü yalnız gerçekten görsel olan
için (kompozisyon, çakışma, kullanıcı onayı) kullanılır.

---

## 2. Stil profili

Çizim kodu hiçbir ofisin katman adını, rengini, linetype'ını ya da metin stilini bilmez.
Her şeyi nötr **rollere** çizer; hangi rolün DXF'te hangi katmana, renge ve çizgi tipine
düştüğünü, ayrıca ev stiline ait tüm boyutları bir **stil profili** (JSON) tanımlar.

### 2.1 Roller

| Rol | Ne çizilir |
|---|---|
| `visible` | görünür kenarlar (ana çizgi) |
| `visible_thin` | ikincil / ince görünür kenarlar |
| `cut` | kesit düzleminin kestiği parçanın kenarları |
| `hidden` | gizli kenarlar |
| `axis` | eksen / merkez çizgileri, gauge çizgileri |
| `limit` | eleman sınır/kırma çizgileri |
| `bolt` | cıvata glifleri ve delikler |
| `hatch` | kesilen çeliğin taraması |
| `text` | etiketler, liderler, görünüş başlıkları, kesit işaretleri |
| `dimension` | ölçüler (çizgi, tik, metin) ve kaynak sembolleri |
| `title_block` | antet |
| `note` | pafta notları |
| `frame` | pafta çerçevesi |

Renderer (`server/render.py`) tüm iç geçişlerini (occlusion, çizgi önceliği, tekilleştirme)
rol adları üzerinde yapar; roller gerçek katman adlarına **tek bir yerde**, en son geçişte
(`house_style.rename_role_layers`) çevrilir.

### 2.2 JSON anahtarları

| Anahtar | İçerik |
|---|---|
| `name`, `description` | profilin adı ve açıklaması |
| `layers[]` | rol başına `{role, name, color (ACI), linetype, lineweight, plot}` |
| `linetypes` | ad → `{pattern, description}`; desen **çizim biriminde, olduğu gibi** yazılır |
| `entity_linetype` | rol → linetype adı (ör. `hidden`, `axis`); kesiklik entity'dedir |
| `text_styles[]`, `text_style`, `sheet_text_style` | metin stilleri (ad, font, genişlik faktörü); detay ve pafta metninin stili |
| `text_height` | yükseklik merdiveni: `title`, `sub`, `label` (model-mm) |
| `dimension` | `tick_block` (terminatör blok adı), `tick_run`, `tick_rise`, `text_height`, `ext_beyond` (DIMEXE), `ext_offset` (DIMEXO), `text_gap` (metnin ölçü çizgisine uzaklığı) |
| `leader_arrow` | `label` ve `weld` ok başları, her biri `[uzunluk, taban]` |
| `view_title` | `bubble_r` — görünüş başlığı balonu yarıçapı |
| `section_mark` | `bubble_r`, `arrow_in`, `arrow_out`, `tick_len`, `tick_w` (§8.9) |
| `hatch` | kesilen çelik için `pattern` ve `scale` |

Her profilin uyduğu iki kural (renderer bunlara dayanır):

- **Kesiklik katmanda değil entity'dedir.** Katmanlar `Continuous` kalır; `hidden`/`axis`
  rollerinin deseni `entity_linetype` ile entity'ye yazılır.
- **Linetype desenleri asla yeniden ölçeklenmez** (§8.2).

### 2.3 Çözümleme sırası

İlk bulunan kazanır; TS tarafı (`apps/drawgen/src/model/style.ts`) ve Python tarafı
(`server/house_style.py`) aynı sırayı paylaşır:

1. `$STEEL_STYLE_PROFILE` — bir dosya yolu ya da `server/style_profiles/` içindeki bir profil adı
2. `server/style_profiles/local.json` — kendi ofis stilin; **git-ignored, asla commit edilmez**
3. `server/style_profiles/default.json` — depoyla gelen nötr ISO stili (ISO 128 linetype'ları
   `ISO02W025` / `ISO04W025`, ISO 3098 metin yükseklikleri 1:10'da 2.5 / 3.5 / 5 mm, genel
   katman adları `STEEL-VISIBLE`, `STEEL-HIDDEN`, `ANNO-TEXT`, `SHEET-TITLE` …)

Çözülen profil spec'e `meta.styleProfile` olarak yazılır; `render.py` spec'i render ederken
**aynı** profili kullanır (TS ile Python farklı profil okuyamaz).

### 2.4 Kendi profilini oluşturmak

```bash
cp server/style_profiles/default.json server/style_profiles/local.json
```

Sonra `local.json`'da katman adlarını/renklerini/lineweight'leri, linetype tablosunu, metin
stillerini ve boyutları kendi ofis standardına göre değiştir. Rol adlarını (`role`)
**değiştirme** — kod onlara çizer. Birden fazla profil tutmak için dosyayı başka bir adla
kaydedip `STEEL_STYLE_PROFILE=<ad>` ile seç. Değişiklikten sonra
`bash tools/check_all.sh` ile üretimi ve imzayı denetle; golden imza rol anahtarlı olduğu için
yalnız katman adı/renk değişikliği imzayı bozmaz.

Profilde **olmayanlar** (bunlar geometri gerçeğidir, konvansiyon değil): cope/çentik/delik
geometrisi, cıvata konumları, plaka kalınlıkları, kesit boyutları. Bunlar IFC/IOM'dan gelir;
profil sentetik sembol ekleyemez.

---

## 3. Ölçülendirme dilbilgisi

- **Zincir + toplam.** Cıvata grubu başına her ana eksende kenar/adım/kenar **zinciri**
  (continue), üstünde istiflenmiş bir **toplam** ölçü; eleman/bağlantı merkez eksenine
  simetrik. Baseline/ordinate değil. Zincir aritmetik olarak kapanır.
- **Plaka istifi ve montaj boşlukları ölçülür** (ör. `10|1|10` — 1 mm bilinçli boşluk).
- **Hassasiyet** bir profil/çıktı parametresidir: tam sayı mm varsayılan; geometri gerektirdiğinde
  yarım-mm gösterilebilir (trailing-zero bastırılmış). Ondalık ayıracı nokta.
- **Metin** ölçü çizgisinin üstünde, geometriye hizalı (eğik elemanda zincir eleman açısına
  döner). Birim eki yok.
- **Görünüş rolü:** gauge'lar kesitlerde, konumlandırma/genel ölçüler ana görünüşte;
  izometrik ölçüsüzdür.
- Dairesel cıvata halkası bağlantı **tipine** bağlıdır (taban plakası), cıvata sayısına değil:
  ortak merkeze eşit uzaklıktaki desen algılanırsa radyal + açısal (360/N) ölçü; aksi hâlde
  ortogonal lineer zincir.

Terminatör ve dimstyle mekaniği: §8.8.

## 4. Etiketler

- **Plaka:** `"PL" + boşluk + kalınlık(mm, tam sayı)`. Kalınlık modelin **thickness**
  attribute'undan gelir, plaka adından değil; model bir ad/boyut string'i döndürürse
  echo edilmez (assert-and-repair). Plaka her görünüşte yeniden etiketlenir, çizelgeye
  toplanmaz.
- **Profil:** etiket = **kesit adı** (IOM `CrossSection.Name`); haddelenmiş profilde katalog
  adı (`HEA260`), içi boş profilde şablon (`CHS{OD}x{t}`, `RHS{h}x{b}x{t}`). Ayıraç ve
  ondalık politikası parametredir; OD ondalığı geometri gerçeğidir, yuvarlanmaz.
- **Görünüş başlığı = parça markası** (IOM `BeamData.Name`), kesit adı değil — iki parça aynı
  profili paylaşabilir. Ana görünüşün başlığı bağlantı markasıdır.
- **Cıvata:** `"{N} x M{d} ({grade})"`; grade IOM'dan gelir, sabit gömülmez.

Etiketin çizim dilbilgisi (altçizgi-lider): §8.6.

## 5. Kaynak

- Kaynak sembolü IOM `WeldData`'dan **sentezlenir** (IOM'da hazır kaynak metni yoktur).
- Boyut gösterimi parametredir: IDEA throat `a` saklar; gösterim `a` (throat) ya da `z` (leg,
  `z = a·√2`) olabilir.
- Tek-taraflı fillet varsayılandır; all-around dairesi kapalı döngüde.
- Aynı kaynak **bir kez**, en açık görünüşte gösterilir; aynı tip/boyuttaki konumlar tek
  sembolden çoklu liderle bağlanır.
- Glif geometrisi: §8.7.

## 6. Görünüş seçimi

Görünüş seçimi **hibrittir** (`apps/drawgen/src/drawing/viewplan.ts`):

1. Modelden **bilgi kalemleri** çıkarılır (plaka kalınlığı + dış ölçü, cıvata deseni + grip,
   eleman derinliği, kaynak boyu) — yalnız okunabilirliği görünüşe bağlı olanlar.
2. Her kaleme görünüş normaline bağlı bir **ölçülebilirlik yüklemi** eşlenir (ör. plaka
   kalınlığı → plaka kenardan görünmeli). Tolerans 2°.
3. **Aday çerçeveler yalnız modelin öznitelikleridir**: eleman eksenleri, flanş/plaka
   normalleri, cıvata eksenleri; paralel olanlar birleşir.
4. Arketip **şablonu** tercih edilen çerçeveleri, adları ve sırayı verir (§8.14).
5. **Kapsama guard'ı** eksik kalanı en çok 2 ek görünüşle kapatır; yine kapanmazsa `REVIEW`
   bayrağı — sessiz eksiklik yok.
6. Çıktı bir **ağaçtır** (§8.10). Plan spec'e `viewPlan` olarak yazılır, denetlenebilir.

**Ayna yönü geometri değil konvansiyondur.** Öznitelik yalnız bakış doğrusunu sabitler; ±yön
aynı bilgiyi aynalı verir. Yön arketip şablonuna yazılır. Kozmetik de değildir: cıvata
takımının plaka paketinin önünde mi arkasında mı olduğunu belirler.

Yön vektörünü iki nokta farkından kurma (eksenler tam kesişmediğinde birkaç derece sapar ve
2°'lik paralellik testini düşürür); yönü elemanın kendi ekseninden al, joint'i yalnız işareti
seçmek için kullan.

## 7. Genelleme duruşu

1. **Her şeyi modelden türet** — ölçüler geometriden, etiketler attribute'lardan, kaynak
   sembolü WeldData'dan, kesitler bağlantının arayüzlerinden.
2. **Ev stilini profil ile parametrize et** — ofisler arasındaki her fark (katman/renk
   politikası, metin boyutları, terminatör, balonlar, tarama, ondalık) profil ya da knob'tur.
3. **Konvansiyon-sabiti ≠ geometri-gerçeği** — sembol boyutu, metin yüksekliği, tire deseni
   profildir; cope/çentik/delik IFC'den gelir.
4. **Hardcode = borç**; doğrulanmamış çıkarımı hardcode etmek daha ağır borç.

---

## 8. Çizim mekanizmaları

### 8.1 Kanıtın geri okunması
Üretilen DXF her zaman geri okunup ölçülür: rol başına entity sayısı, benzersiz segment
sayısı, ölçü değerleri, yay yarıçapları, extent. Yazma tarafının niyeti kanıt değildir
(bkz. §8.12/D1: yazılan renk attribute'u sessizce ezilebiliyor).

### 8.2 Linetype'lar ve birim
- Linetype desenleri profilde **çizim biriminde** yazılır ve **asla ölçeklenmez**. Fiziksel
  tire boyunu belgenin birimi belirler, tablo değil. `$PSLTSCALE = 1` ile viewport içinde
  tire kağıt-mm olarak yorumlanır.
- Kesiklik entity'dedir (`entity_linetype`), katmanlar `Continuous`.
- **Spec her zaman kanonik mm'dir.** Birim (`mm` | `cm`) web'den seçilir, `meta.units` ile
  spec'e yazılır; `render.py` tek bir `S` faktörü uygular (mm = 1.0, cm = 0.1) ve
  `DIMLFAC = 1/S` sayesinde ölçü metinleri iki modda da mm okur.
- Geometri motoru mm'de **kalır**, çünkü toleransları mutlak mm'dir; yalnız 2D çıktı emisyonda
  ölçeklenir. Yeni entity tipi eklenirken `_scale_spec`'e dalı eklenmezse exception atar.
- mm ve cm çıktılarının imzası (mm'ye normalize) **birebir aynı** olmalıdır.

### 8.3 Çizgi önceliği
ISO 128: **görünür > gizli > eksen.** Görünür bir kenarla çakışan ya da onun kapsadığı gizli
segment çizilmez. Bazı CAD export'ları aynı kenarı hem görünür hem gizli yazar (bir katının
arka yüzü tam ön yüzünün arkasına düştüğünde); bu bir export artefaktıdır, konvansiyon değil —
taklit edilmez. Öncelik ve katman-içi tekilleştirme geçişleri **birleştirilmiş çizim**
üzerinde çalışır, çünkü hiçbir üretici diğerinin ne yazdığını göremez.

### 8.4 Tarama
- **Kesilen çelik taranır.** Desen ve ölçek profildedir (`hatch.pattern`, `hatch.scale`;
  varsayılan ANSI31 @ 5 → dik aralık 15.875 model-mm, 1:10'da ~1.6 mm).
- Tarama `hatch` rolünde, BYLAYER.
- Bir parçanın kesilip kesilmediği **geometriden** hesaplanır (kesit görünüşünün kesme
  düzlemi, §8.10): kesilmişse `cut` + tarama, değilse `visible`. "`cut` ama taramasız"
  tutarsız bir üçüncü durumdur.

### 8.5 Lider ok başları
- İki ayrı ok başı sınıfı vardır: **etiket lideri** ve **kaynak lideri**; boyutları profilde
  `leader_arrow.label` / `leader_arrow.weld` (`[uzunluk, taban]`). Ok, anotasyon sınıfına göre
  seçilir; "her yerde aynı glif" varsayılmaz.
- Ok başı **yalnız solid dolgudur**, BYLAYER renkli; ayrıca outline çizilmez (§8.12/D2).

### 8.6 Etiketler — altçizgi-lider
- Liderli etiketin landing'i metnin **altını çizer**: altçizgi metin başlangıcının bir dolgu
  (`LABEL_PAD`) solundan başlar, metnin bir dolgu altında durur; uzunluğu
  `dolgu + metin_genişliği + dolgu`.
- **Metin genişliği gerçek font metriğinden** gelir (`ezdxf.fonts`), karakter sayısından
  değil; `0.62·h·len(s)` gibi kestirimler dar fontlarda belirgin sapar. Yerleştirici ile
  denetleyici **aynı** fonksiyonu paylaşır.
- Lider, altçizginin çapaya en yakın ucundan kırılır; çapada ok başı (§8.5).
- Etiket her zaman ertelenir ve diğer etiketlerden kaçınır.

### 8.7 Kaynak sembolü glifi
- Fillet üçgeni **outline**'dır (3 çizgi), solid dolgu değil (ISO 2553).
- Bevel/PJP glifi: referans çizgisinden dikey bir bacak + yarı yükseklikten tepeye 45° eğik.
- Değer metni referans çizgisinin üstünde, glifin solunda ve **`dimension` rolünde** durur
  (§8.12/D10).
- Bir sembol → N lider (aynı kaynak bir kez gösterilir, §5).

### 8.8 Ölçülendirme ve terminatör
- Terminatör profilde tanımlı bir **blok**tur (`dimension.tick_block`), geometrisi
  `tick_run : tick_rise` ile verilir (ölçü çizgisi boyunca `run`, dik yönde `rise`) ve
  istasyonun üzerinde ortalanır. Varsayılan profil 45° eğik tik kullanır; farklı eğimli bir
  ofis tiki yalnız bu iki sayıyla tanımlanır.
- `DIMBLK = tick_block`, `DIMASZ = tick_run`. **`DIMTSZ` 0 olmak zorunda**: sıfır değilse
  AutoCAD/ezdxf kendi 45° tikini çizer ve `DIMBLK`'i yok sayar.
- Metin ölçü çizgisinin `text_gap` kadar üstünde; uzatma çizgisi ölçülen noktadan
  `ext_offset` (DIMEXO) sonra başlar, ölçü çizgisini `ext_beyond` (DIMEXE) kadar aşar;
  metin yüksekliği `dimension.text_height`.
- Zincir sıkıştığında metin kaydırılır (dışarı, alta) — ölçü asla çakışarak bırakılmaz.
- ezdxf: `add_linear_dim(...)` bir `DimStyleOverride` döndürür; `.render()` çağrılmazsa
  AutoCAD göstermez; entity'ye `dim.dimension` üzerinden erişilir.

### 8.9 Görünüş başlıkları ve kesit işaretleri
- **İki başlık politikası** vardır:
  - `bubble` — her ölçekli görünüş numaralanır ve balonlanır: balon (`view_title.bubble_r`)
    içinde numara, sağında başlık ve ölçek;
  - `underline` — balonsuz, altı çizili düz başlık.
  İzometrik her iki politikada da **balonsuz, numarasız, ölçeksiz** altı çizili başlıktır
  (`ViewDef.titleStyle` sayfa politikasını görünüş başına ezer).
- **Kesit işareti** (ebeveyn görünüşe çizilir):
  - görünüşü boydan boya geçen **sürekli** kesit çizgisi, `text` rolünde (eksen değil,
    anotasyondur);
  - bir ucun ötesinde **kesit balonu** (`section_mark.bubble_r` — başlık balonundan ayrı bir
    yarıçap: iki boyut, iki anlam), içinde çocuk görünüşün numarası;
  - balona yapışık solid **şevron ok**, bakış yönünü gösterir. Balon merkezi `c`, bakış yönü
    `s`, dik yön `t` iken altı nokta:
    `c − out·t, c − in·t, c + in·s, c + in·t, c + out·t, c + out·s`
    (`in = arrow_in`, `out = arrow_out`);
  - öbür uçta solid **uç tiki** `tick_len` (bakış yönünde) × `tick_w` (enine);
  - id metni kesit çizgisi yönüne **döndürülür**, pafta düz tutulunca okunacak şekilde.
- Okun yönü çocuğun **baktığı** yöndür: `flipDepth` set edilmiş görünüşte efektif normal
  (çevrilmiş) kullanılır, ham planlayıcı normali değil.

### 8.10 Görünüş ağacı
- Görünüş kümesi bir **ağaçtır**: tek bir ana (MAIN) kök + N kesit; **her kesitin tek bir
  işareti** vardır ve o işaret zaten mevcut bir görünüşün içinde çizilir. Kesit işareti sayısı
  = kesit görünüşü sayısı.
- İzometrik ağacın **dışındadır** (işaret yok, numara yok, tamamı görünür, ölçüsüz).
- Numaralama: ana görünüş `01`, kesitler plan sırasına göre `01.N` — işareti başka bir kesitin
  içinde çizilse bile numara ana görünüşün altındadır (`01.2`, `01.1.1` değil).
- Her kesit, kesme çizgisini düzleminde barındıran bir ebeveyne atanır (`isPerp(n_s, n_p)`).
  **Kesme düzleminin ebeveyndeki izi:** düzlem `{p : (p − o_s)·n_s = 0}`; `n_s`'yi ebeveynin
  bazında `α·u_p + β·v_p + γ·n_p` yazınca, atama kuralı gereği `γ = 0`; iz ebeveynin yerel
  `(a, b)` düzleminde `α·a + β·b + c = 0` doğrusudur, `c = (o_p − o_s)·n_s`. `γ ≠ 0` olsaydı
  kesme düzlemi ebeveyni eğik keserdi ve tek düz işaretle gösterilemezdi.
- Aynı kesme düzlemi hem parça başına kesit sınıflandırmasını (§8.4) hem de işaret
  geometrisini verir — tek özellik.

### 8.11 IFC geometrisi (coped / profil)
- IDEA'nın IFC'si kesilmemiş elemanı **gerçek I-prizması** olarak verir (24 köşe = uç başına
  12), kutu değil. Tek eksik **kök radyuslarıdır**: IFC profili keskin köşelidir. Radyuslar
  kesit tablolarından çizilir — `drawIProfile`'ın var olma sebebi budur; düz flanş/gövde
  kenarlarını silüetle **çift çizmemelidir**.
- Cope, çentik, delik IFC mesh'inde baked-in gelir (IDEA'nın gerçekten uyguladığı geometri);
  sentetik sembol eklenmez. IOM semantik omurgadır (plaka poligonu + kalınlık, BoltGrid,
  WeldData, kesit boyutları).
- Birbirine giren dilimler: IFC gövde dilimi flanşın içine uzayabilir; bu yüzden kendisiyle
  kesişen mesh'te ışın-parite (`_point_in_mesh`) testi güvenilmezdir (simetrik iki kenar zıt
  cevap verebilir). Gövde çizgisi kenardan değil **uçtan görünen yüzden** türetilir
  (`_edge_on_faces_2d`) — simetriktir ve pariteye hiç sormaz.

### 8.12 HLR / occlusion
- **Occlusion `direction`'ı = görünüşün NORMALİ** (`cross(view.u, view.v)`, ± flipDepth);
  asla eleman ya da cıvata ekseni. Soru "göz ile nokta arasında malzeme var mı"dır.
- Tamamen örtülen cıvata glifleri çizilmez.

Bilinen kusur sınıfları ve düzeltmeleri:

| # | Kusur sınıfı | Mekanizma |
|---|---|---|
| **D1** | Solid dolgu BYLAYER değil sabit renk çıkıyor | ezdxf `add_hatch(color=7, dxfattribs=None)` / `set_solid_fill` pozisyonel `color=7` default'u `dxfattribs["color"]`'ı **ezer**. Renk niyeti kolaylık parametresiyle verilir (`add_hatch(color=256, ...)`); aynı attribute iki yere verilmez |
| **D2** | Ok başı hem outline hem solid | yalnız solid dolgu (§8.5) |
| **D3** | **Aynı segment 2–4 kez çiziliyor** | parça başına outline + feature-edge emisyonu tekilleştirilmiyordu. `ifc_geom.view_linework` rol içinde benzersiz segmentlere indirger (toleranslı anahtar); zincirler yeniden birleştirilir |
| **D4** | **Bir kenarın iki sahibi** (aynı gövde yüzü hem sürekli hem kesikli) | her kenarın **tek sahibi** olmalı; "elle telafi" çizimi (ör. ayrı `webLines`) eklemeden önce aynı kenarı başka bir geçişin çizip çizmediği kontrol edilir |
| **D5** | Tek `hlr` bayrağı iki işi kontrol ediyor | `inter_part_hlr` (parçalar arası) ve `self_hlr` (parçanın kendi içinde) ayrıdır; parçalar arası HLR'ı kapatmak kendi-içi HLR'ı kapatmamalı. Yakın-yüzey bandı bir **düzlemsellik** toleransıdır (`1e-3 × derinlik aralığı`), derinlik aralığının yüzdesi değil — aksi hâlde ince flanşın arkasındaki kenar "yakın yüzeyde" sayılır |
| **D5b** | Occlusion sonrası eşdoğrusal köşeler | kırpılmış polyline'lar eşdoğrusal köşeleri birleştirerek sadeleştirilir |
| **D6** | Kesilen parça `cut` ama taranmıyor | §8.4 |
| **D7** | Kesitte yalnız bir parça etiketli | kesit görünüşü içinde görünen her parça etiketlenir |
| **D8** | Kesitte kaynak sembolü yok | kaynak sembolleri kaynağın en açık göründüğü görünüşe (kesit dahil) gider |
| **D9** | Montaj boşluğu / eksen istasyonu kesitte ölçülmüyor | plan ve kesit aynı istasyon-zinciri yardımcısını paylaşır |
| **D10** | Kaynak değer metni yanlış rolde | `dimension` rolü (§8.7) |

### 8.13 Dönme-değişmezlik
Çerçeveler global eksene çivili değil **öznitelik-türevlidir** (eleman eksenleri, flanş/plaka
normalleri, cıvata eksenleri). Döndürülmüş model aynı imzayı (ölçü değerleri, yay
yarıçapları, rol başına entity sayısı) vermelidir: `python tools/check_invariance.py`.
Global eksene dönmek testi anında kırar; elle yazılmış görünüş-içi ofsetler de döndürülmüş
modelde yerinden oynar — anotasyon konumları öznitelik-türevli çapalardan (`P.label`,
istasyon zincirleri, gerçek kaynak orta noktası) alınır.

### 8.14 Arketip şablonları
- **Fin plate:** ana görünüş (`FRONT VIEW`) **cıvata ekseni** boyunca bakar — kare bir
  bağlantıda bu eksen plakaya dik ve taşıyıcının eksenine paraleldir, dolayısıyla tek çerçeve
  hem plakayı cepheden hem taşıyıcıyı gerçek kesit olarak verir. `SECTION A-A` **flanş
  yüzüne** bakar: plaka kenardan görünür (kalınlık ölçülebilir), gövdeler flanşın altında
  kesikli kalır.
- **End plate:** kök görünüş = bearing elemanın flanş yüzü (plan); kesit = bearing ekseni;
  `<eleman> END PLATE` = o elemanın kendi ekseni, dışarıdan bileşkeye doğru.
- İkisinde de izometrik ölçüsüzdür. Ayna yönü (§6) arketip başına şablona yazılır.
