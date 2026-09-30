# Çoklu IFC import (aynı yapının parçalarını birleştirme)

Bir yapı birden fazla IFC olarak teslim edildiğinde (bölge/faz/imalatçı başına bir dosya),
en değerli birleşimler tam olarak **dosyaların dikişinde** olur: kiriş bir dosyada, oturduğu
kolon başka dosyada. `+ Import IFC`, yüklü modeli kapatmadan bir IFC daha ekler; böylece o
dikiş birleşimi tek viewer'da çıkarılabilir.

- **Load IFC** = değiştirir (yüklü her şeyi kapatır). Viewer'a dosya bırakmak (drop) da
  budur — dalgın bir drop modeli sessizce ikiye katlamasın diye ekleme yalnız açık
  düğmeyle yapılır.
- **+ Import IFC** = ekler. İlk yüklenen dosya **taban** dosyadır.
- Her import edilmiş dosya adının yanındaki **×** onu tekrar çıkarır (unmount). Taban
  dosyada × yoktur: her import onun çerçevesine hizalandı (`autoCoordinate`) ve Connection
  Library onun adına kayıtlı — kaldırılması kalan modelleri var olmayan bir çerçeveye
  yaslar ve kütüphaneyi sessizce başka dosyaya taşır.

## Neden iş "bir düğme eklemek" değildi

`ifcLoader.load()` **zaten toplamalıydı**; eski kod önceki modeli *bilerek* siliyordu
(`frameToFit`'in sınır kutusunu bozuyordu). Viewer tarafının çoğu da hazırdı — seçim,
highlight, tag etiketleri, storey isolation, bbox, navigasyon hepsi `fragmentsManager.list`
üzerinde döner. Hizalama da hazırdı: `load(bytes, coordinate=true, name)` →
`autoCoordinate`, ilk model taban olur, sonrakiler onun koordinat sistemine dönüştürülür.

Asıl darboğaz tek bir yerdeydi: **`bufferRef.current` tek bir `ArrayBuffer`**.

Buradaki her çıkarıcı (üye vektörleri, plaka silüeti, Tag index, profil ipuçları) fragments
geometrisini değil **orijinal IFC'yi** kendi web-ifc modelinde yeniden açar — fragments
üçgen tutar, çıkarıcıların istediği IFC entity grafiğini (Axis eğrileri, property set'ler,
swept-solid profilleri) tutmaz. Tek buffer, viewer tek model tuttuğu sürece yeterliydi.

İki dosya yüklendiği anda yetmez: B dosyasındaki bir GlobalId, A dosyasının byte'larında
**yoktur**. Yanlış buffer'a yönlendirilmiş çıkarım gürültülü biçimde başarısız olmaz —
o üye için **hiçbir şey** döndürür ve üye sonuçtan sessizce düşer. Bu yüzden her çıkarım,
üyesinin gerçekten geldiği buffer'a yönlendirilir.

```
StandaloneApp
  sourcesRef: IfcSource[]            ifc-sources.ts
    { modelId, fileName, buffer, isBase }
        │
        ├─▶ MemberVectorsPanel  ─▶ extract-across-models.ts
        │      getIfcSources()        (modelId'ye göre grupla → dosya başına
        │                              bir web-ifc modeli → istenen sırada birleştir)
        └─▶ PlateDxfButton      ─▶ plate.modelId'nin buffer'ı
```

`modelId` = dosyanın yüklendiği ad (`IfcLoader.load` `name`'i doğrudan modelId yapar). Aynı
adlı ikinci dosya fragments'ın model haritasında çakışacağı için `uniqueModelId` sonek verir
— aynı taban adın iki klasörde olması sıradan bir durum, reddetmek yerine ayrıştırılır.

## Kararlar

**Birleştirme anahtarı GlobalId.** GlobalId eleman başına tekil olduğundan, birinin iki
dosyada görünmesinin tek yolu ikisinin de **aynı fiziksel elemanı** taşımasıdır. Bunları tek
satıra indirmek doğru cevaptır (bir üyedir); geometriyi ilk çözen dosya verir.

**Sıra korunur.** Çıkarım sırası joint çözücünün okuduğu üye dizisidir (ilk üye bearing
adayı). Dosya başına çıkarım yapılıp sonuç **kullanıcının seçtiği sıraya** geri dizilir,
dosya sırasına değil.

**Connection Library anahtarı TABAN dosyadır.** Import onu değiştirmez, böylece import
öncesi ve sonrası kaydedilen birleşimler tek kütüphanede kalır. (Kayıtlar üye başına
`modelId` taşır; import edilmemiş bir dosyanın üyesine bakan kayıt sessizce çözülemez —
açık kalan nokta, aşağıya bkz.)

**Çakışan eleman yüklenir, sayısı bildirilir** (kullanıcı kararı). Kutu import sonrası
görünür.

**Çakışma sayısı yalnız GEOMETRİSİ OLAN elemanları sayar.** `model.getGuids()` değil:
tek yapıdan kesilmiş iki dosya, mekânsal ve örgütsel entity'lerini (IfcProject, IfcSite,
IfcBuilding, IfcElementAssembly ve bunlara bağlı her ilişki/property set) **tanım gereği**
paylaşır. Onları saymak, kirişleri ve plakaları tamamen ayrık olan temiz bir bölünmede
**22 çakışma** bildiriyordu — her meşru import'ta patlayacak gürültü. "Eleman iki dosyada
da var" ile "iki dosya aynı binayı anlatıyor" arasını ayıran şey geometri taşımaktır:
konteynerler taşımaz, üyeler ve bulonlar taşır.

## Unmount: asıl iş bayat durumu temizlemek

Modeli sahneden çıkarmak kolay kısım. Riskli kısım, ona referans veren durumun kalması:
bu kod tabanında ölü bir model referansı **gürültüyle patlamaz**. En sinsi yol şu:

`memberRefs` — çıkarım anında donan `Map<globalId, {modelId, localId}>` — sonuç ekranının
her üyenin hangi dosyadan geldiğini bildiği **tek** yerdir (`MemberVectorRow` yalnız
`globalId` taşır). Tekla/Autodesk anahtarının yeniden çıkarımı hedeflerini oradan alır.
Bir dosya kaldırıldıktan sonra bu harita temizlenmezse yeniden çıkarım, artık var olmayan
bir buffer'a yönlenir; `extractMemberVectorsAcrossModels` o üyeleri atlar ve
`solveJoint`/`anchorNodeToBearing` joint'i **kalanlar üzerinden** yeniden çözer — node yer
değiştirir, her `ey/ez/Ecc` değişir — üstelik ekrandaki uyarı sebebi "Axis/mesh geometrisi
yok" diye yanlış gösterir. Yani kullanıcının seçtiğinden farklı bir joint, makul görünen
sayılarla.

Bu yüzden panel, yüklü dosya kümesine karşı **bildirimsel** olarak uzlaşır
(`loadedModelIds` prop'u — "hangi modeller VAR", "hangisi kaldırıldı" olayı değil; kaçan
bir olay sessiz yanlış cevap, kaçan bir render yalnızca gecikmiş cevaptır):

- kaldırılan modelin üyeleri `members`'tan düşer, Highlighter'ın kendi seçim haritası
  kalanlardan yeniden kurulur (model dispose edilince onu temizleyen hiçbir şey yok),
- `memberRefs` budanır,
- sonuçlar o dosyaya dayanıyorsa **sonuç ekranı yıkılır** ve sebebi yazılır — sessizce
  daha küçük bir joint yeniden çözülmez,
- `handleExtract` ayrıca ikinci savunma olarak yüklü olmayan modelli hedefi reddeder.

Ek olarak: `PostproductionRenderer` istek üzerine boyar, geometri silmek kamerayı
oynatmaz — `renderer.needsUpdate` set edilmezse kaldırılan model kullanıcı pan/zoom
yapana kadar ekranda kalır (aynı sebep `clearStoreyIsolation`'da da var). Unmount
kamerayı **oynatmaz** (`frameToFit` yok): dosya çıkarmak kamera talebi değildir ve
Extract & Isolate açıkken izole görünümle kavga eder.

### modelId'ler geri dönüştürülmez

`modelId` dosya adıdır ve viewer çevresinde birden fazla cache `modelId:localId` ile
anahtarlanıp modelden uzun yaşar: `use-member-selection`'daki `resolvedCacheRef`
("permanent" diye belgeli), tag-label identity/box cache'leri, Tag index'in cache anahtarı,
ve kayıtlı Connection Library kayıtlarının içindeki modelId'ler. Serbest kalan bir adı geri
vermek bu anahtarları **iki farklı dosya arasında** çakıştırır: `part2.ifc`'i kaldır,
yeniden export et, yeni `part2.ifc`'i import et → cache yeni dosyanın localId'sine ESKİ
dosyanın globalId'sini döndürür, çıkarım onu çözemez ve üye sessizce düşer.

Bu yüzden `uniqueModelId` artık **oturumda verilmiş her id'yi** tutan, yalnız büyüyen bir
kümeye karşı çalışır (`usedModelIdsRef`). Sonek içseldir: arayüz, kütüphane anahtarı ve
kalıcı oturum hep `fileName` kullanır.

### Kayıtlı birleşim geri yüklemesi GlobalId'ye geçti

`handleSelectConnection` artık kayıtlı `modelId`'ye güvenmiyor, her `globalId`'yi **yüklü
tüm modellerde** çözüyor (`resolveMemberByGlobalIdAnyModel`). Kayıt, kaydedildiği modelden
uzun yaşar: dosya kaldırılıp yeniden import edilebilir (yeni modelId alır) veya başka sırada
yüklenebilir. Kayıtlı modelId'ye bağlı geri yükleme bu durumlarda hiçbir şey çözemiyor ve
birleşim **sessizce eksik** geri geliyordu — tablo ve tüm export'lar normal görünürken üyesi
eksik bir joint. GlobalId tanım gereği dosyalar arası kararlı, doğru anahtar o. Bulunamayan
üye artık sayılıp söyleniyor.

## Dünya çerçevesi: düzeltilmez, UYARILIR

Çıkarıcılar her dosyayı ayrı açar ve koordinatları **o dosyanın kendi dünya çerçevesinde**
verir (yerleşim zinciri mekânsal köke kadar bileşik). Tek projeden çıkmış parçalar bu
çerçeveyi paylaşır → koordinatlar doğrudan kıyaslanabilir, dikiş birleşimi doğru çözülür.
Farklı orijinlerle çıkmış parçalar paylaşmaz: georeferanslı bir model yüzlerce/binlerce km
ofsette olabilir (mutlak/georeferans koordinat), yapıya yerel örnekler ise orijindedir. Biri georeferanslı diğeri yapıya yerel iki dosya, aynı fiziksel
joint'i kilometrelerce ayrı koyar ve joint çözücü bunun için makul görünen çöp döndürür.

**Viewer bunu haber vermez:** `autoCoordinate` her modeli ilkinin çerçevesine hizaladığı
için uyuşmayan dosyalar ekranda kusursuz oturmuş görünebilirken arkadaki sayılar
uyuşmuyordur. Bu yüzden kontrol **byte'lar üzerinde** yapılır (`ifc-world-frame.ts`) ve
uyuşmazlık **bildirilir, sessizce düzeltilmez** — düzeltme dönüşümü "hangi dosya
yetkili" konusunda doğrulanmamış bir tahmin olurdu ve bu depo o tür çıkarımı düz bir
eksikten ağır borç sayar (kök `CLAUDE.md` §5).

## Doğrulama (ÖLÇ, sonra bak)

Asıl iddia — *dosya-arası çıkarım, bölünmemiş dosyayla aynı sonucu verir* — sayısal olarak
sınandı. Tek birleşimli bir örnek IFC (3 kiriş + 2 plaka) iki parçaya bölündü:
`260`+`160` A parçasına, `STUB1`+plakaları B parçasına — joint tam dikişin üstünde.

| Sınama | Sonuç |
|---|---|
| A+B'den 3 üye (`extractMemberVectorsAcrossModels`) vs orijinalden 3 üye (`extractMemberVectorsFromBytes`) | `JSON.stringify` **birebir eşit**, 3 satır, HEA260/HEA160, rot 90°/0° |
| Aynı sınama, import edilen dosyanın üyesi **ilk** sırada | birebir eşit; sıra korundu (STUB1, 260, 160) |
| Çerçeve: A vs B | `matches: true`, delta 0 mm |
| Çerçeve: A vs 50 m kaydırılmış B | `matches: false`, delta **50 000 mm**, uyarı göründü |
| Çakışma: A+B (ayrık kiriş/plaka, ortak bulon) | **6** — ifcopenshell'den bağımsız beklenti 6 (5 IfcFastener + 1 IfcMechanicalFastener) |
| Çakışma: A+C (C, `160` kirişini de taşır) | **7** — bağımsız beklenti 7 |
| Oturum kalıcılığı | iki dosya da geri yüklendi (taban önce), restore'da bildirim bastırıldı |
| Eski tek-kayıt göçü | taban model ilk açılışta geri geldi |

Unmount ayrıca uçtan uca gerçek arayüzde sürüldü (dosya girdilerine `DataTransfer` ile
dosya verilip `change` olayı gönderildi; panel görsel olarak katlı olsa da DOM'u render
edildiği için düğmeleri programatik tıklandı):

| Sınama | Sonuç |
|---|---|
| Taban dosyada × var mı | yok; × yalnız import edilende (`aria-label` sayımıyla doğrulandı) |
| Dosya-arası seçim (tıklama/arama yoluyla) | 3 üye, profiller iki dosyadan da çözüldü (HEA260 + 2×HEA160) |
| Dosya-arası çıkarım gerçek arayüzde | sonuç ekranı geldi, node 0,0,0 |
| **Sonuçlar ekrandayken import edilen dosyayı kaldır** | sonuç ekranı **yıkıldı**, seçim 3→**2** üyeye düştü, sebebi ekranda: "Kaldırılan dosyanın üyeleri sonuçların içindeydi…" — sessiz yeniden çözüm YOK |
| Kaldırma sonrası oturum | reload'da yalnız `split-partA.ifc` geri geldi |
| `uniqueModelId` geri dönüştürmüyor | `b.ifc`→`b.ifc`, kullanılmışsa `b.ifc (2)`, `(2)` de kullanılmışsa `b.ifc (3)` |
| Konsol | üç senaryonun hiçbirinde hata yok |

Sürülemeyen tek şey `handleExtract`'ın yüklü-olmayan-model reddi: uzlaşma o üyeleri zaten
anında budadığı için arayüzden **erişilemez** durumda. Kasten öyle — ikinci savunma katmanı.

Boş sonuç tuzağı: ilk deneme her iki yolda da **0 satır** döndürdü ve "birebir eşit"
görünüyordu — boş=boş hiçbir şey kanıtlamaz. IDEA dosyaları mesh fallback ister
(`allowBrepFallback: true`); gerçek karşılaştırma onunla yapıldı.

Fixture üreten betikler oturum scratchpad'indeydi, depoya alınmadı; `split_ifc.py`
(ada göre eleman silme, `ifcopenshell.api.root.remove_product`) ve `shift_site.py`
(IfcSite orijinini kaydırma) yeniden üretmek için yeterlidir.

## Açık kalanlar

- **Çerçeve uyuşmazlığı düzeltilmiyor**, yalnız uyarılıyor. Gerçek bir uyuşmaz dosya çifti
  eline geçtiğinde düzeltmeyi *o kanıtla* yaz — `FragmentsModel.getCoordinationMatrix()`
  kütüphanenin kendi delta'sını verir, başlangıç noktası orası.
- **Taban dosya kaldırılamaz.** Onu değiştirmenin yolu `Load IFC` ile baştan yüklemek.
- **`handleShowAllConnections` yüklü olmayan modelli kayıtları atlıyor** — o kayıt görsel
  özette hiç yanmıyor, uyarı da vermiyor. Görsel bir özet olduğu için kabul edildi;
  doğruluk-kritik geri yükleme `handleSelectConnection`'dan geçiyor ve o GlobalId'ye göre
  çözüyor.
- **Tag-label cache'leri (`use-tag-labels`) unmount'ta budanmıyor.** modelId'ler artık geri
  dönüştürülmediği için yanlış dosyaya cevap verme riski kalktı; kalan tek şey ölü
  girdilerin bellekte durması (sınırlı, kozmetik). Denetimde doğrulama kotası dışında
  kaldı — kanıt için `docs/` yerine denetim çıktısına bakılabilir.
- **Plate DXF, kaldırılmış modelden seçili bir plakayla "Önce bir IFC yüklenmeli" diyor** —
  doğru davranış (üretmiyor) ama mesaj sebebi yanlış anlatıyor.
