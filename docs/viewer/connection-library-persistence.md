# Connection Library kalıcılığı (disk tabanlı)

Kaydedilmiş birleşimler (Connection Library) **diskte** durur; tarayıcı depolaması yalnızca
aynadır. Bu belge neden ve nasıl olduğunu anlatır.

## Neden localStorage yetmedi

Belirti: "kayıt listesi dev sunucu kapanıp açılınca sıfırlanıyor."

İki ayrı sebep vardı:

1. **Yanlış anahtar (asıl sebep).** Panel, kütüphane anahtarı olan IFC adını **mount anında**
   `loadLastIfc()` ile okuyordu — yani *bir önceki* oturumun dosya adını. Oturum içinde yeni
   bir IFC yüklenince bu ad güncellenmiyordu; dolayısıyla kayıtlar **eski dosyanın**
   `member-vectors-lib-<eski ad>` anahtarına yazılıyordu. Sonraki açılışta panel doğru adı
   (yeni dosyayı) okuyup o anahtara bakıyor, orası boş olduğu için liste boş görünüyordu.
   Veri kaybolmuş değildi, **görünmez** olmuştu.
2. **Depolamanın kendisi kırılgan.** localStorage tarayıcı profili + origin'e bağlıdır:
   "clear site data", başka tarayıcı, başka port hepsi kütüphaneyi düşürür. Üstelik her kayıt
   kendi `rawRows`'unu taşıdığı için ~5MB kotası gerçekten ulaşılabilir bir sınır (bir kayıt
   ~8KB; 5 kayıtlı bir dosya 40KB).

## Mimari

```
Panel  ──▶  connection-library-store.ts  ──▶  PUT/GET /api/connection-library?ifc=<ad>
(ifcName prop'u)      │                              │
                      └──▶ localStorage (ayna)       └──▶ .data/connection-library/<ad>.json
```

- **Sunucu tarafı:** `apps/viewer/connection-library-server.mts` — bir **Vite eklentisi**
  (`apply: "serve"`). `dev-server.mts` içine express route olarak konmadı; böylece tek
  gerçekleştirim **iki dev modunda da** var: `npm run dev` (birleşik express içinde middleware
  modunda Vite) ve `npm run dev:viewer` (düz Vite). Birleşik sunucu da `vite.config.mts`'i
  yüklediği için eklentiler kendiliğinden birleşir.
- **Depolama birimi:** IFC başına bir JSON dosyası, `{ ifcName, connections }`. Dosya adı
  sanitize edilmiş IFC adı; `ifcName` alanı dosyanın *içinde* de tutulur, böylece iki farklı
  IFC adının aynı dosya adına düşmesi (sanitize çakışması) yanlış kütüphane servis etmek
  yerine "boş" olarak görülür.
- **Yazma bütünlüğü:** yaz-sonra-yeniden-adlandır (`.tmp` → `rename`). Saatlerce üye seçimiyle
  kurulmuş bir kütüphane yarım yazımda kesilmemeli.
- **Her mutasyon TÜM listeyi yazar.** İstemci zaten tek IFC'nin tam kütüphanesini elinde
  tutuyor; sunucuda birleştirilecek kısmi güncelleme yok, dolayısıyla lost-update penceresi
  de yok.
- **Anahtar host'un elinde.** `MemberVectorsPanel` artık `ifcName` prop'u alıyor
  (`StandaloneApp`'in `fileName` state'i). Yeni dosyanın eskisinin yerini aldığını **yalnız
  host bilir**; paneli kendi başına türetmeye bırakmak yukarıdaki 1. hatanın ta kendisiydi.

## localStorage'ın kalan rolü

1. **Yedek depo:** backend yoksa (statik production bundle — `apply: "serve"` orada eklenti
   yok) kütüphane yine çalışır, sadece tarayıcıya bağlı kalır.
2. **Okuma önbelleği:** istek başarısız olursa ayna gösterilir ve konsola hata yazılır
   (`disk backend stopped answering`) — sessizce düşmek, başarılı görünüp kaybolan kayıt
   demek olurdu.
3. **Tek seferlik göç:** ilk okumadan önce `member-vectors-lib-*` altındaki **tüm**
   kütüphaneler diske itilir (dolu bir disk kütüphanesi ezilmez). Disk-öncesi sürümde
   kaydedilmiş — yanlış anahtara yazılmış olanlar dahil — birleşimler böyle kurtarıldı.
   Bayrak: `member-vectors-lib-migrated-to-disk`.

## Doğrulama (2026-07-29)

- `GET`(boş) → `PUT` → `GET`(dolu) → dosya diskte: iki dev modunda da geçti. Birleşik sunucuda
  gövde `express.json()` tarafından önceden ayrıştırılıyor, düz Vite'ta akıştan okunuyor;
  `readBody` iki yolu da kapsıyor ve ikisi de ölçüldü.
- **Sadece diskte** var olan bir kayıt (`ZZ-DISK-ONLY`, dosyaya elle yazıldı) sunucu
  yeniden başlatıldıktan sonra arayüzde göründü → doğruluk kaynağı disk, ayna değil.
- `saveConnection` / `renameConnection` / `removeConnection` sayfa içinden gerçek store
  modülü üzerinden çağrıldı; disk dosyası, localStorage aynası ve dönen liste üçü de aynı.
- Sunucu durdurulup `loadConnections` çağrıldı → ayna döndü + beklenen konsol hatası.
- Kullanıcının mevcut verisi göç etti: iki IFC'nin kütüphanesi (5 kayıt ve 1 kayıt).

`.data/` `.gitignore`'da — yerel çalışma verisi, kaynak değil.
