# IFC import sertleştirme: boolean bütçesi, worker, watchdog

**Sorun neydi.** Büyük bir Revit modeli (Revit 2025 export, 57,9 MB, 840.838 entity) viewer'da
açılmıyordu. Belirti hata değil **donma**ydı: sekme kilitleniyor, ~55 dakika sonra `navigate`
bile kabul etmiyordu.

## Teşhis

Ölç-sonra-bak sırasıyla, Node + `web-ifc/web-ifc-api-node.js` üzerinde:

| | varsayılan model (açılıyor) | büyük Revit modeli (açılmıyor) |
|---|---|---|
| Boyut / entity | 23,7 MB / 299.125 | 57,9 MB / 840.838 |
| `OpenModel` (STEP ayrıştırma) | 0,2 s | **0,5 s** |
| Tüm elemanların geometrisi | 0,2 s | **hiç bitmiyor (30 dk+)** |
| Aynısı, suçlu eleman hariç | — | **1,4 s** |

Yani **ayrıştırma değil geometri üretimi** tıkanıyor, ve suçlu **tek eleman**:

```
#<id> = IFCSLAB (kompozit döşeme tipi)
  Body representation tipi 'CSG'
  119 iç içe IFCBOOLEANRESULT + 120 IFCEXTRUDEDAREASOLID
```

web-ifc iç içe boolean ağacını **sırayla** değerlendirir, her adım bir öncekinin ürettiği
mesh üzerinde çalışır. Maliyet mesh ile büyüdüğü için uzun zincir yavaşlamaz, **bitmez**.

Dağılım, bunun kategori ya da boyut sorunu olmadığını gösteriyor: aynı dosyada ikinci en
kötü eleman **12** boolean taşıyor, 10'u aşan **2** eleman var, 5'i aşan 15. Varsayılan modelin
tamamında 55 boolean var. **n=1 patoloji.**

### Teşhis yöntemi (tekrar gerekirse)

`StreamAllMeshes` tek opak blok — nerede takıldığını göstermez. Eleman eleman `GetFlatMesh`
ile süre ölç; sonra STEP metnini indeksleyip ürünün representation alt-ağacındaki
`IFCBOOLEANRESULT`/`IFCBOOLEANCLIPPINGRESULT` sayısını sırala.

## Neden donma, neden hata değil

`IfcLoader.load()` içindeki `FRAGS.IfcImporter.process()` **çağrıldığı thread'de** koşuyordu
ve viewer onu UI thread'inde çağırıyordu. 36 saniyelik bir dönüşüm orada "yavaş" diye
okunmaz, **çökme** diye okunur: boyama yok, ilerleme yok, iptal yok — ve hiçbir şey throw
etmediği için `loadIfcBuffer`'daki `try/catch` hiç tetiklenmez.

## Çözüm: üç katman

### 1. Boolean bütçesi — `boolean-budget.ts`

Dönüştürmeden **önce** byte seviyesinde ön-geçiş: bütçeyi aşan representation'ı reddet,
neyi neden attığını bildir.

**Neden ön-geçiş, neden loader ayarı değil.** `IfcImporter` yalnız **kategori** dışlayabilir
(`classes.elements` bir IFC tip numarası kümesi), eleman başına kanca yok. Ayrıca tek bir
web-ifc geometri çağrısı senkron — yield etmez, yani başladıktan sonra dışarıdan
zaman-aşımına uğratılamaz. Takılmayı **önleyebilecek** (yalnız raporlamakla kalmayan) tek
şey, gövdeyi dönüşüm başlamadan reddetmek.

**Ne düzenlenir — mümkün olan en azı**, transform denetlenebilir kalsın diye: suçlu
`IfcShapeRepresentation`, sahibinin representation listesinden çıkarılır; yalnız liste
boşalıyorsa ürünün `Representation` alanı `$` yapılır ve boşalan entity silinir. **Kardeş
representation'lar yaşar** — bu önemli, `Axis`'i centerline çözücü okuyor. Eleman
GlobalId'sini, adını ve pset'lerini korur, model ağacında kalır; sadece çizilmez. Yetim
kalan geometri entity'lerine dokunulmaz: onlara kimse referans vermez ve web-ifc yalnız
üründen erişilebilen geometriyi değerlendirir.

Doğrulama (büyük Revit modeli, bütçe 40): tam olarak 1 eleman düşüyor, çıktıda **0 dangling
referans**, entity sayısı tam 1 azalıyor, çelik üçgen sayıları **birebir aynı**
(4272/1148/32 → 182.632/66.876/1.408), toplam 402.234 üçgen, tüm geometri 1,4 s.
Varsayılan modelde **no-op** — girdi ArrayBuffer'ının kendisi geri döner, yani çalışan bir
dosyanın sessizce yeniden yazılmadığı nesne kimliğiyle garanti.

**Eşik neden 40, ve neden sabit değil knob.** Kanıt bilerek zayıf: gözlenen tek patoloji
(119) ile aynı dosyadaki en kötü meşru vaka (12) arasında. 40, şimdiye dek görülen her
meşru değerin bir kat üstünde ve bilinen tek hatanın üçte biri altında. Her düşen eleman
**raporlandığı için** gerçek dosyalarla yeniden kalibre edilebilir — tekrar tahmin
edilmesi gerekmez.

### 2. Worker — `ifc-import.worker.ts` + `ifc-import-client.ts`

Dönüşüm ana thread'den çıktı. `IfcLoader.load`'un yaptığı işin aynısı, aynı bölünmeyle:
worker yalnız **dönüştürür**, çıkan fragments byte'ları ana thread'de
`fragmentsManager.core.load()`'a verilir (sahne orada).

Dönüşüm başına **bir worker**, bitince terminate. Havuz değil: web-ifc geometri çağrısı
WASM içinde senkron olduğu için ortasında durdurmanın **tek** yolu thread'i öldürmek —
havuzlu bir worker ilk iptalde zaten atılmak zorunda kalırdı.

Bunun getirdikleri: canlı yüzde + aşama göstergesi, çalışan bir **İptal** düğmesi, ve
`worker.onerror`/`onmessageerror` sayesinde sessizce ölen bir worker'ın da hata vermesi.

**Yan etki olarak düzelen iki şey:**

- **Yıkım artık dönüşümden sonra.** Eskiden "replace" yüklemesi mevcut modelleri en başta
  siliyordu. Dönüşüm iptal edilebilir hâle gelince bu kabul edilemez oldu: iptal edilen
  yükleme viewer'ı boşaltıyordu. Artık fragments üretilmeden hiçbir şey yıkılmaz — iptal ya
  da hata viewer'ı olduğu gibi bırakır.
- **Eşzamanlı yükleme kilidi (`loadingRef`).** Arayüz artık yükleme sırasında canlı olduğu
  için düğmeler gerçekten tıklanabilir; ikinci bir "replace" yükleme, birincinin içine
  yüklediği modelleri siliyor ve `Fragments: Model not found` olarak yüzeye çıkıyordu.

### 3. Watchdog — `DEFAULT_STALL_TIMEOUT_MS`

Bütçenin **tanımadığı** patoloji için emniyet ağı. `ProcessData.progressCallback` her tick'te
heartbeat sayılır; `stallTimeoutMs` boyunca sessizlik olursa worker öldürülür ve
`ImportStalledError` atılır (son görülen aşamayı taşır — thread gittikten sonra hangi
elemanın suçlu olduğuna dair tek ipucu odur).

120 s bilinçli olarak cömert: **yanlış** bir takıldı kararı, kullanıcının beklediği işi yok
eder; **geç** bir kesme ise yalnız zaten kaybedilmekte olan zamana mal olur. Tick'ler aşama
ve entity sınıfı başına geldiği için 58 MB'lık büyük modelde saniyede birkaç kez düşüyor.

Doğrulama: bütçe geçici olarak devre dışı bırakılıp eşik 20 s'ye çekildi. Dönüşüm `%19 /
geometri`de (patolojik elemanın yeri) çakıldı, watchdog ateşledi, önceki model korundu, ve
kullanıcı donma yerine sebebi söyleyen bir mesaj aldı.

## Gözden kaçması kolay yer

`ifc-sources.ts` ham IFC byte'larını **model başına** saklar; her çıkarıcı fragments
üçgenlerini değil **orijinal IFC'yi** kendi web-ifc modelinde yeniden açar. Bu yüzden:

> **Viewer ayıklanmış byte'lardan çizer; registry ve `saveIfcSession` orijinali tutar.**

Karıştırılırsa çıkarım sessizce eleman kaybeder — ve `apps/viewer/CLAUDE.md`'de yazdığı
gibi bu **gürültüyle patlamaz**, üye sonuçtan sessizce düşer.

## Bilinen sınır

Kapı kontrolü şu an ana thread'de koşuyor (58 MB'da ~0,8–2,4 s). Saf ve senkron bir
fonksiyon olduğu için worker'a taşınabilir; taşınmadı çünkü dönüşümün kendisinin yanında
küçük kalıyor. 500 MB sınıfı dosyalarda tekrar ölçülmeli.
