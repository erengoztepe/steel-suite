"""DXF doküman fabrikası.

Doğrulanmış ezdxf pratikleri (bkz. memory/steel-drawing-rules.md):
- Stil KATMAN düzeyinde merkezi; entity'ler linetype=BYLAYER, color=256 ile miras alır.
- Paperspace kullanılacaksa DXF R2000+ gerekir -> varsayılan R2010.
- Ölçülendirmede add_linear_dim sonrası dim.render() ZORUNLU (document değil,
  connections katmanında; burada stil hazırlanır).

Model uzayı 1:1 milimetre. Anotasyon boyutu `scale` (ör. 1:10 -> scale=10)
ile ölçeklenir: dimstyle.dimscale = scale, böylece ölçü yazısı/oku pafta
üzerinde sabit fiziksel boyutta çıkar.
"""
from __future__ import annotations

import ezdxf
from ezdxf.document import Drawing

from .layers import LAYERS

# EN ISO 129-1: ölçü metni ölçü çizgisinin ÜSTÜNDE, alttan okunur.
DIMSTYLE_NAME = "STEEL-ISO"
TEXTSTYLE_NAME = "STEEL"

# Pafta üzerinde hedeflenen fiziksel boyutlar (mm)
_TEXT_H_MM = 2.5      # ISO standart yazı yüksekliği
_ARROW_MM = 2.5


def new_document(scale: float = 10.0, dxfversion: str = "R2010") -> Drawing:
    """Katmanları, stilleri ve ölçü stilini kurulu boş bir DXF döndürür.

    scale: çizim ölçeği paydası (1:10 için 10). Anotasyonlar buna göre büyütülür.
    """
    doc = ezdxf.new(dxfversion, setup=True)  # setup=True: standart linetype+textstyle yükler

    # Metrik ortam
    doc.header["$INSUNITS"] = 4       # millimeters
    doc.header["$MEASUREMENT"] = 1    # metric
    doc.header["$LWDISPLAY"] = 1      # çizgi kalınlıklarını göster

    _setup_layers(doc)
    _setup_text_style(doc)
    _setup_dim_style(doc, scale)
    return doc


def _setup_layers(doc: Drawing) -> None:
    for ld in LAYERS.values():
        if ld.name in doc.layers:
            layer = doc.layers.get(ld.name)
        else:
            layer = doc.layers.add(ld.name)
        layer.color = ld.color
        layer.dxf.linetype = ld.linetype
        layer.dxf.lineweight = ld.lineweight
        layer.description = ld.description


def _setup_text_style(doc: Drawing) -> None:
    if TEXTSTYLE_NAME not in doc.styles:
        # ISO uyumlu tek çizgi font; isoCP genişletilmiş kayıt setup=True ile gelir
        doc.styles.add(TEXTSTYLE_NAME, font="isocp.shx")


def _setup_dim_style(doc: Drawing, scale: float) -> None:
    if DIMSTYLE_NAME in doc.dimstyles:
        doc.dimstyles.discard(DIMSTYLE_NAME)
    dim = doc.dimstyles.add(DIMSTYLE_NAME)
    dim.dxf.dimtxsty = TEXTSTYLE_NAME
    dim.dxf.dimtxt = _TEXT_H_MM       # yazı yüksekliği (model birimi; dimscale ile çarpılır)
    dim.dxf.dimasz = _ARROW_MM        # ok boyutu
    dim.dxf.dimscale = scale          # genel anotasyon ölçek faktörü (1:scale)
    dim.dxf.dimtad = 1                # metin ölçü çizgisinin ÜSTÜNDE (EN ISO 129-1)
    dim.dxf.dimgap = 0.625            # metin-çizgi boşluğu
    dim.dxf.dimexe = 1.25             # uzatma çizgisi taşması
    dim.dxf.dimexo = 0.625            # uzatma çizgisi offset
    dim.dxf.dimdec = 0                # ondalık basamak (mm tam sayı)
    dim.dxf.dimlunit = 2              # ondalık birim
    dim.dxf.dimse1 = 0
    dim.dxf.dimse2 = 0
