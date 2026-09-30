# apps/viewer — Member Vectors (IFC → birleşim geometrisi)

Bir IFC'den çelik birleşim geometrisini çıkarır (doğrultu vektörleri, CPA node, üye başına
`ex/ey/ez` offset, kesit rotasyonu, profil) ve IDEA StatiCa'ya verir (CSV/TSV veya IOM
`.xml`). Çıkarım tamamen tarayıcıda: web-ifc WASM + fragments worker `public/` altında
vendor'lanmış. Ayrıntılı harita: `DEV_README.md`.

`dev-server.mts` bu klasörde ama **iki uygulamaya birden** hizmet eder; bkz.
`docs/combined-dev-server.md`.

## Yeniden türetilmemesi gereken kararlar

**`joint-solver.ts` / `anchorNodeToBearing` — "sadeleştirme".** Node bearing üyenin
ekseninde durur (tüm üyelerin serbest CPA'sında değil); eksen-boyu konum attached üyelere
dik uzaklık karelerini minimize eder (kapalı form `t = uᵀ(B−A·b0)/uᵀAu`); bearing'in kendi
offseti tanım gereği `[0,0,0]` (IDEA konvansiyonu); `ex` bilinçli olarak çıktıdan atılır
(gerçek geometriyi etkilemez). Dejenere durumda (attached ≈ bearing'e paralel) tie-break
yalnız **Ended** attached üyelerin close-end centroid'iyle yapılır. Her seçim IDEA'nın
gerçek geometri konvansiyonuna karşı doğrulandı.

**Continuous/Ended = yalnız "düğüm üyenin içinde mi".** `classifyThroughMembers`: düğüm
(CPA) üyenin ekseninde ve yakın ucundan **>250 mm** içerideyse Continuous (IDEA'nın tanımı:
FEA importunda düğümde iki elemana bölünen üye). Kesir penceresi (`0.15<t<0.85`) değil
mutlak pay — ucuna yakın geçen uzun kolonu kaçırıyordu. **"Karşı ortak" kuralı (aynı hatta
ters yönde üye var → Continuous) geri getirilmeyecek:** kayıtlı kütüphanede 48 kullanıcı
düzeltmesinin ~40'ı ondan çıkıyordu, iki yarının ikisi de Continuous olunca IOM export'u üst
üste binen iki tam boy üye yazıyordu, bearing önerisinde de 36 yüksek güvenli seçimin 12'sini
yanlış yapıyordu. Ölçüm: geomType 48→18/181, bearing yüksek güven 24/36→25/25. Kalan 18'in
15'i hiç dokunulmamış eski etiketler; bölünmüş hat için doğru
yol IDEA Checkbot'taki gibi elle "Merge" (henüz yok).

**Rotation_deg önceliği.** IFC "Cross-Section Rotation" pset'i varsa **geometrik tahmine
tercih edilir** (bu dosyada IDEA'ya karşı her seferinde pset tuttu). Pset okuması TYPE
(taban) + INSTANCE (üstüne yazan) seviyelerini **birleştirir** — Revit değeri type'ta
taşıyabiliyor. Geometrik yedek, uzunluk eksenini local X/Y/Z içinden gerçek doğrultuya en
hizalı olana bakarak **seçmek** zorunda (her zaman local-X varsayımı yanlış).

**Yön işareti.** IDEA'ya giren doğrultu her zaman joint'ten **DIŞA** (close→far) olmalı;
ham IFC start→end yönü örnek bir joint'te 9 üyenin 6'sında içeri bakıyordu.

**Eğri üyeler iki ayrı düzeltme ister.** (a) Eğri üyenin IFC `Axis`'i centroid'de değil,
~yarım kesit derinliği kaymış bir kardinal noktada — teğet-güdümlü dilimlemeyle düzeltilir
(`centerline/cardinal-correction.ts`); düzeltilmezse joint eksantrisitesi ~155 mm şişer.
(b) Bağlantı açısı, tüm boy kirişi değil **joint'e yakın teğettir**; `MIN_TANGENT_ASPECT=3`
ve `CURVE_THRESHOLD_DEG=1.5` kapıları şart — yoksa plakalar ve kısa saplamalar uydurma
40-45° teğet üretir. **Denenip başarısız olanlar (tekrar denemeyin):** yalnız bütün-mesh
PCA (= ortalama eğim) ve teğet için yüzde-açıklık penceresi.

**Centerline çıkarımı strateji+planlayıcı boru hattı** (`centerline/`): ucuz stratejiler
önce, Body mesh **en çok bir kez** okunur, primary seçilir (axis-circle > axis-poly/line >
body-extrusion > mesh-pca), sonra en iyi alternatifle çapraz kontrol edilir. Her satır
`centerlineSource` + `centerlineAgreementMm` taşır (tabloda "Src" kolonu) — ileride
Tekla/Autodesk toggle'ını kaldırmanın dayanağı bu.

**IOM (.xml) export'unda alan SIRASI önemli.** IDEA'nın importer'ı sıralı bir .NET
XmlSerializer; kök `OpenModelContainer/OpenModel`, `Version 3.2.0`, ve tip başına IDEA'nın
kendi sırası. Sırası bozuk dosya parse anında reddedilir (dosya "hiç açılmıyor" belirtisi).
Hâlâ açık: kesitler yalnız İSİMLE yazılıyor (parametrik dim yok), segmentlerde
`LocalCoordinateSystem` yok, `ey/ez` export'a yazılmıyor, biz UTF-8 IDEA UTF-16.

**Ham IFC byte'ları MODEL BAŞINA tutulur, tek buffer değil.** Viewer birden fazla IFC
taşıyabilir (`+ Import IFC` — aynı yapının parçalarını birleştirmek için); her çıkarıcı
fragments geometrisini değil orijinal IFC'yi kendi web-ifc modelinde yeniden açtığı için
**her çıkarım üyesinin geldiği buffer'a yönlendirilmek zorunda**. Yanlış buffer gürültüyle
patlamaz — o üye için hiçbir şey döndürür ve üye sonuçtan sessizce düşer. Registry
`ifc-sources.ts`, yönlendirme `member-vectors/extract-across-models.ts` (dosya başına grupla,
**kullanıcının seçtiği sıraya** geri diz — sıra joint çözücünün üye dizisidir). Çakışma sayacı
yalnız **geometrisi olan** elemanları sayar; `getGuids()` mekânsal konteynerleri de sayıp
temiz bir bölünmede 22 sahte çakışma bildiriyordu. Dosyaların dünya çerçevesi farklıysa
dosya-arası geometri geçersizdir ama viewer'da hizalı görünür (`autoCoordinate`) — bu yüzden
byte'lardan ölçülüp **uyarılır, düzeltilmez**. Gerekçe + doğrulama:
`docs/viewer/multi-ifc-import.md`.

**Unmount'ta asıl iş bayat durumu temizlemek.** Import edilmiş dosya × ile çıkarılabilir
(taban çıkarılamaz). Modeli sahneden almak kolay kısım; ölü model referansı bu kod tabanında
**gürültüyle patlamaz**. En sinsi yol: `memberRefs` sonuç ekranının üye→dosya eşlemesini
tutan TEK yerdir (`MemberVectorRow`'da `modelId` yok) ve Tekla/Autodesk yeniden çıkarımı
hedeflerini oradan alır — budanmazsa joint **kalanlar üzerinden** yeniden çözülür (node ve
tüm `ey/ez` değişir) ve uyarı sebebi "Axis/mesh yok" diye yanlış gösterir. Bu yüzden panel
`loadedModelIds` prop'una karşı **bildirimsel** uzlaşır (olay değil: kaçan olay = sessiz
yanlış cevap), sonuçlar kaldırılan dosyaya dayanıyorsa **yıkılır**. Ayrıca: **modelId'ler
geri dönüştürülmez** (`usedModelIdsRef`) — `modelId:localId` ile anahtarlanan cache'ler
modelden uzun yaşadığı için serbest kalan bir ad iki farklı dosyayı çakıştırıyordu; ve
kayıtlı birleşim geri yüklemesi kayıtlı modelId yerine **GlobalId** ile tüm yüklü modellerde
çözer (yoksa yeniden import edilen dosyada birleşim sessizce eksik geliyordu). Unmount
kamerayı oynatmaz, ama `renderer.needsUpdate` şart (on-demand boyama).

**IFC import üç katmanla sertleştirildi; sırayı bozma.** (a) `boolean-budget.ts` —
dönüştürmeden **önce**, bütçeyi (40) aşan boolean zincirine sahip gövdeyi reddeder ve
bildirir. `IfcImporter` yalnız kategori dışlayabildiği ve tek bir web-ifc geometri çağrısı
senkron olduğu (yield etmez → dışarıdan kesilemez) için takılmayı **önleyebilecek** tek yer
burası. En az düzenleme yapar: suçlu shape representation sahibinin listesinden çıkar,
kardeşler yaşar (`Axis`'i centerline çözücü okuyor), eleman ağaçta kalır. Çalışan dosyada
**no-op** — girdi buffer'ının kendisi döner. (b) Dönüşüm **worker'da**
(`ifc-import.worker.ts`); ana thread'de yalnız `fragmentsManager.core.load()`. Dönüşüm
başına bir worker: WASM içindeki senkron geometri çağrısını durdurmanın tek yolu thread'i
öldürmek. **Yıkım artık dönüşümden sonra** — iptal edilen yükleme viewer'ı boşaltmamalı; ve
`loadingRef` eşzamanlı yüklemeyi engeller (arayüz canlı olduğu için düğmeler gerçekten
tıklanabilir; ikinci replace `Fragments: Model not found` üretiyordu). (c) `progressCallback`
heartbeat'i sessizleşirse **watchdog** (120 s) worker'ı öldürür — bütçenin tanımadığı
patoloji için emniyet ağı. **Kritik:** viewer ayıklanmış byte'lardan çizer, registry ve
`saveIfcSession` **orijinali** tutar (çıkarıcılar orijinali okur). Ölçümler + gerekçe:
`docs/viewer/ifc-import-hardening.md`.

**Connection Library diskte durur, localStorage'da değil.** Kayıtlar
`<repo>/.data/connection-library/<ifc>.json`; sunucu ucu `connection-library-server.mts`
(Vite eklentisi, `apply: "serve"` — böylece hem `npm run dev` hem `dev:viewer` kapsanır),
localStorage yalnız ayna/yedek + tek seferlik göç kaynağı. Kütüphane anahtarı olan IFC adı
**host'tan** gelir (`ifcName` prop'u — artık **taban** dosyanın adı; import onu değiştirmez,
böylece import öncesi/sonrası kayıtlar tek kütüphanede kalır); panelin kendi içinde son
yüklenen IFC kaydından türetmek
mount anında donduğu için kayıtları önceki dosyanın kütüphanesine yazıyordu — "liste
sıfırlanıyor" şikâyetinin asıl sebebi buydu.
Gerekçe + doğrulama: `docs/viewer/connection-library-persistence.md`.

## Tuzaklar

- **Viewer container'ının boyutu:** `components-front`'un 2D renderer'ı container'a inline
  `position: relative` yazar; `relative` altında `inset-0` germeyi bırakır, yükseklik
  canvas'a düşer, canvas'ın boyutunu da renderer container'dan okur → 0×0'da kilitlenir.
  Bu yüzden container'da `absolute inset-0` **ve** `h-full w-full` birlikte durur.
- **`npx tsc --noEmit` hataları editör gürültüsüdür** — build `vite build` (esbuild), tsc
  koşmaz. Kalan ~14 hatanın hepsi `@thatopen/*` tip-tanımı sürtünmesi; cast/wrapper ister,
  mantık düzeltmesi istemez. "Hata var" diye kod değiştirme.
- Sekme değişiminde panolar `visibility` ile saklanır, `display:none` ile değil (0×0
  container + WASM/IFC'nin baştan yüklenmesi).

## Açık iş

**Alfa/rotasyon tespiti** kullanıcının aktif odağı. Bilinen tek çözülmemiş vaka: geometrik
rotasyonu (0°) pset rotasyonuyla (90°) çelişen tek bir eleman; kullanıcının Revit teyidi
bekleniyor. 7/7 başka elemanda yöntem doğrulanmış durumda. Rotasyon konusu açıldığında
buradan devam et, sıfırdan debug etme.
