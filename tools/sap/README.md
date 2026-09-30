# tools/sap — SAP2000 yardımcıları

## fill_panels.py — frame aralarını area ile doldur

Açık SAP2000 modeline (OAPI, `pip install comtypes`) bağlanır, frame'lerin
çevrelediği **dış cephedeki** her **üçgen** ve **dörtgen** gözü bulur ve area ekler:
üçgen göz → tek area, dörtgen göz → kısa köşegenden bölünmüş iki üçgen area.

```bash
python tools/sap/fill_panels.py --dry-run     # yalnız rapor
python tools/sap/fill_panels.py --selected    # yalnız seçili frame'ler
python tools/sap/fill_panels.py --prop ASEC1 --group NULL_FACADE --unlock
```

- Yeni area'lar varsayılan olarak SAP2000'in yerleşik null kesiti `None` ile
  (yalnız yük aktarımı) eklenir ve `NULL_FACADE` grubuna girer (toplu seç/sil). Zaten var olan göz
  atlanır → frame modeli değişince yeniden koşulabilir.
- Kilitli (analiz sonucu olan) modelde `--unlock` gerekir; sonuçları siler.
- Varsayılan yalnız dış kabuk: gözden, yapı merkezinin ters tarafına atılan ışın
  başka bir göze çarpıyorsa göz içeridedir (kafes kiriş içi, kesit çerçeveleri) ve
  atlanır. Tüm gözler için `--all-gaps`.
- 5+ kenarlı boşluklar (oculus, kapı) doldurulmaz.

Sahte çevrim filtreleri (`panel_finder.py`, saf geometri, `tests/test_sap_panel_finder.py`):
tek köşegenli dörtgen = zaten iki üçgen; çapraz (X) köşegenli ve kesişim düğümsüz
dörtgen = tek göz; iki yarısı `--max-fold` (30°) üstü kırılan dörtgen reddedilir
(kutu kafes içinden geçen çevrimler); içinden frame geçen veya içine düğüm düşen
göz reddedilir (`--occupied-height`, göz boyutunun katı). Normaller komşu gözlerle
tutarlı ve parça bazında dışa (düzlemselse +Z) yönlenir. İkiden fazla göze komşu
frame'ler uyarı olarak listelenir (yüzeylerin buluştuğu yer, ör. kafes kiriş).

## ifc_to_structure.py — fiziksel IFC → SAP2000'e girecek yapı IFC'si

Bir ya da birden çok fiziksel IFC'deki IfcBeam / IfcColumn / IfcMember'lardan tek bir
`IfcStructuralAnalysisModel` yazar (SAP2000: File > Import > IFC). "Null Facade" sekmesinin
1. adımı bunu viewer'da yüklü tüm modellerle çağırır.

```bash
python tools/sap/ifc_to_structure.py out.ifc a.ifc [b.ifc ...] [--connect-tol 300]
       [--supports pinned|fixed|none] [--support-at lowest|column-bases] [--split-crossings]
```

- Eksen = gövde ekstrüzyonunun ekseni (kesit **ağırlık merkezi**), Axis temsili değil (o kardinal
  noktada olabilir); ekstrüzyon yoksa mesh'e eksen oturtulur (eğri üye düzleşir, uyarılır).
- Kesit = elemanın kendi IfcProfileDef'i (IFC2X3 → IFC4 ad eşlemeli kopya); adı profil adı,
  yoksa tip adının son ":" parçası (Revit `Aile:Tip:Id` → `UC305x305x97`). Malzeme = seçilen sınıf.
- Bağlantı: `--merge-tol` içindeki uçlar tek düğüm; `--connect-tol` içindeki serbest uç en yakın
  elemana taşınır ve o eleman orada bölünür (sorgular orijinal geometriye karşı → sıra bağımsız).
  Revit/IDEA modelinde uçlar yüzde/üst başlıkta biter: ölçülen örnekte serbest uç 50 mm'de
  7518, 300 mm'de 2324, 500 mm'de 758.
- Dosyaların dünya çerçeveleri uzaksa (georeferanslı + yerel) **uyarılır, düzeltilmez**.
- Doğrulama: `sample_gridshell.ifc` → SAP'ın içe aldığı `sample_gridshell_sap.ifc` analiz modeliyle
  680 düğüm / 1842 eleman / 52 mesnet / kesit adı / Axis birebir aynı.
