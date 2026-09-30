# steel-suite

IDEA StatiCa / IFC modellerinden **ev-stiline uygun çelik bağlantı detay çizimi (DXF)**
üreten araç takımı. İki uygulama tek web arayüzünde iki sekme olarak koşar; ikisi de aynı
IFC/IOM girdisini farklı uçlardan tüketir.

## Yerleşim

| Yol | Ne | Dil |
|---|---|---|
| `apps/viewer/` | IFC viewer (Member Vectors): birleşim geometrisi çıkarımı → IDEA'ya girdi. **Birleşik dev sunucusu da burada** (`dev-server.mts`) | TS/React |
| `apps/drawgen/` | IOM+IFC → DrawingSpec + sürükle-bırak web arayüzü | TS |
| `server/` | `render.py`: DrawingSpec → DXF (ezdxf); `ifc_geom.py`: coped silüet/HLR; `house_style.py`: stil profili yükleyici (rol → katman/linetype); `style_profiles/`: `default.json` (nötr ISO) + yerel `local.json` | Python |
| `src/steeldraw/` | parametrik üreteç kütüphanesi (AISC/EC3 değer katmanı) — tamamlayıcı iş kolu | Python |
| `tools/`, `tests/` | doğrulama betikleri; pytest + golden fixture | Python |
| `docs/` | çizim konvansiyonları + stil profili ([drawing-conventions.md](docs/drawing-conventions.md)), birleşik sunucu, viewer notları | — |

Kökteki `src/` **Python** paketidir (`pyproject.toml` bu düzeni bekler); `apps/*/src` ise
TypeScript. İkisini karıştırma.

## Çalıştırma

```bash
npm install && pip install -e .
npm run dev            # iki sekme, :5177   (dev:viewer -> :5173, dev:drawgen -> :5177)
```

**Aynı anda tek dev sunucu koşar** — `dev` ve `dev:drawgen` ikisi de 5177'yi ve
livereload'un 35729'unu ister. Mimari: [docs/combined-dev-server.md](docs/combined-dev-server.md).

## Doğrulama disiplini (bu projede en çok hata buradan çıktı)

**Önce ÖLÇ, sonra bak.** Görüntü üretmek varsayılan yöntem değildir; PNG'ye bakmak
"makul ama yanlış" moduna kördür (kaçırılan gerçek hata örneği: HEA550A kök radyusunun
hiç çizilmemesi).

```bash
bash tools/check_all.sh              # yerel fixture bağlantılarını yeniden üret + denetle (eksik fixture atlanır)
python tools/verify_drawing.py <dxf> <spec.json> --golden tests/golden/<ad>.json
python tools/check_invariance.py     # dönme-değişmezlik (çerçeveler global eksene çivili mi)
```

- Sayısal sorgu (ezdxf ile entity/koordinat/katman ölçümü) = birincil kanıt.
- Makine-denetimli imza/golden = güvenlik ağı. Yeni entity tipi eklerken imzayı güncelle.
- Görüntü yalnız **gerçekten görsel** olan için: kompozisyon, çakışma, kullanıcı onayı.
- Yazma tarafına bakmak yetmez: **üretilen DXF'i geri okuyup** attribute'u ölç.

## Değişiklik disiplini

1. **Hangi doğruluk kaynağı?** Hata çıkınca sınıflandır: geometri (IFC) / konvansiyon
   (stil profili / ev stili) / standart (AISC-EC3). Yanlış kaynağı düzeltmeye çalışma.
2. **Nokta-fix değil genel mekanizma.** Her düzeltme bir *sınıf* problemi çözen parametrik
   knob'a dönmeli. Tek bağlantıya hardcode = genelleme borcu.
3. **Konvansiyon-sabiti ≠ geometri-gerçeği.** Sembol boyutu, metin yüksekliği, dash deseni
   ev-stili parametresidir; cope/çentik/delik **gerçek IFC geometrisinden** gelir —
   sentetik sembol eklenmez.
4. **Birim birinci sınıf tehlike.** Dış bir örnekten alınan hiçbir sayı birim-kontrolsüz
   kullanılmaz. Spec her zaman **kanonik mm**; ölçek tek noktada (`render.py`'nin `S`).
5. **Kanıtı katmanla:** DXF ekstraktında ölçülebilen `[VERİ]`, yalnız görselden okunan
   `[RASTER]` = hipotez. Doğrulanmamış raster çıkarımını "veri" gibi hardcode etmek düz
   hardcode'dan ağır borçtur. Ayrıca örnek bir DXF ofisin **şablonunu** (legend/blok) da
   taşıyabilir — şablondan okunan kural yayınlanmış detayda geçerli olmayabilir
   ([ŞABLON] ≠ [DETAY], `docs/drawing-conventions.md` §1).
6. **Ev stili koda değil profile yazılır.** Kod rollere çizer (`visible`, `hidden`, `text`,
   `dimension` …); katman adı/renk/linetype ve tüm ev-stili boyutları stil profilindedir
   (`server/style_profiles/`). Ofise özgü değer (katman adı, ölçülmüş sembol boyutu, proje/
   bağlantı adı) depoya girmez — yalnız git-ignored `local.json`'a.

## Diğer

- Kod yorumları ve **arayüz metinleri İngilizce**; `docs/` ve README Türkçe.
- **Push etmeden önce sor.** Repoya proje/ofis/müşteri verisi girmez: örnek modeller ve
  fixture'lar `fixtures/` ve `apps/viewer/public/models/` altında yerel kalır (git-ignored).
