# tools/idea — IOM → tasarıma-hazır `.ideaCon`

steel-suite viewer'ın ürettiği **geometry-only IOM XML**'i (üyeler + profiller +
bearing üye + ended/continuous; plaka/cıvata/kaynak YOK) IDEA StatiCa'da **açınca
tasarıma başlamaya hazır** bir `.ideaCon` dosyasına çevirir. Dönüşümü IDEA'nın kendi
Connection REST API'si yapar; biz yalnız IOM'u `import_iom` ile projeye çevirip
`download_project` ile diske yazarız — `import_iom` hiçbir manufacturing operation
yaratmadığı için sonuç boş, tasarıma-hazır bir bağlantıdır.

## Ön koşullar

1. **REST servisini başlat** (penceresini açık bırak):

   ```
   "C:\Program Files\IDEA StatiCa\StatiCa 26.0\IdeaStatiCa.ConnectionRestApi.exe"
   ```

   `Now listening on: http://localhost:5000` yazmalı.

2. **Doğru Python**: `ideastatica_connection_api` paketinin kurulu olduğu Python ile çağır:

   ```
   python tools\idea\iom_to_ideacon.py ...
   ```

   Paket başka bir yorumlayıcıda kuruluysa `IDEA_PYTHON` ortam değişkeni o `python`
   yürütülebilirinin yolunu verir (varsayılan: `PATH`'teki `python`).

## Kullanım

```
# tek dosya (çıktı girdinin yanına <ad>.ideaCon)
python iom_to_ideacon.py connection.xml

# çıktı yolu belirt
python iom_to_ideacon.py connection.xml -o "out\connection-A (GEOMETRY).ideaCon"

# bir klasördeki tüm .xml/.iom → klasör dolusu .ideaCon (batch)
python iom_to_ideacon.py iom+ifc\ -o out\

# IOM'daki belirli bağlantı indeksleri
python iom_to_ideacon.py connection.xml --connections 1
```

## Girdi: **"Export IDEA (.xml)"**, "IOM for GH" DEĞİL

Viewer'daki **"Export IDEA (.xml)"** düğmesi `<OpenModelContainer>` sarmallı XML
üretir — `import_iom`'un beklediği format budur. **"IOM for GH"** bilinçli olarak
*bare* `<OpenModel>` üretir (Grasshopper eklentisinin doğrudan deserializer'ı için) ve
`import_iom` tarafından reddedilir; betik bunu tespit edip uyarır.

## Round-trip self-check (ÖLÇ, sonra bak)

Her dosyada betik, API'nin kurduğu modeli kaynak XML'in iddiasıyla karşılaştırır ve
şunları raporlar/denetler:

- **Üye sayısı** API == kaynak mı (eksikse profil-adı büyük olasılıkla IDEA kesit
  veritabanında çözülmedi).
- Her üyenin **kesiti çözüldü mü** (`cross_section_id` null değil mi).
- **Operation sayısı 0 mı** (tasarıma-hazır boş bağlantı beklenir).
- Üye başına **bearing / continuous** bayrakları ve **Alfa** (`alpha_rotation`).

`.ideaCon` sorun işaretlense de **yine de yazılır** (IDEA'da açıp farkı göresin diye);
ama süreç çıkış kodu sıfırdan farklı olur, böylece batch'te sorun görünür kalır.

## Bilinen risk

En olası aksama **profil-adı çözümü**: emit-iom kesitleri yalnız isimle yazar
(`UC 203 x 203 x 52`, `CrossSectionConversionTable=SCIA`). İsim IDEA MPRL'inde
eşleşmezse üye kurulamaz. Self-check bunu "eksik üye / kesitsiz üye" olarak yakalar;
çözüm sırası: conversion table'ı ayarla → `standardizeProfileName`'i IDEA adlarıyla
hizala → son çare emit-iom'a parametrik kesit boyutları ekle.
