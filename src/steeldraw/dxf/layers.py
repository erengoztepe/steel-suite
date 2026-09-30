"""NCS (US National CAD Standard) uyumlu katman tanımları.

Yapısal disiplin kodu 'S'. Katman adı: Discipline-Major[-Minor][-Status].
Stil KATMAN düzeyinde merkezidir; entity'ler BYLAYER ile miras alır
(bkz. dxf/document.py). Çizgi kalınlıkları ISO 128 gruplarına dayanır:
görünen hat kalın (0.50), yardımcı/gizli/ölçü ince (0.25/0.35).

ezdxf lineweight birimi 1/100 mm (50 = 0.50 mm). Geçerli değerlerden biri
olmalı: 0,5,9,13,...,50,...,200,211. -1 = BYLAYER.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LayerDef:
    name: str
    color: int          # ACI renk indeksi (1=kırmızı,2=sarı,3=yeşil,4=camgöbeği,5=mavi,6=magenta,7=byh,8=gri)
    linetype: str       # "CONTINUOUS", "HIDDEN", "CENTER", "PHANTOM"
    lineweight: int     # 1/100 mm
    description: str = ""


# ISO 128 kalınlık grubu (ölçek 1:10 detay için tipik): kalın=0.50, ince=0.25
_THICK = 50
_MEDIUM = 35
_THIN = 25

# Kanonik katman seti — çelik bağlantı detayı çizimi
LAYERS: dict[str, LayerDef] = {
    "S-DETL":       LayerDef("S-DETL",       7, "CONTINUOUS", _THICK,  "Görünen kenar / ana profil hatları"),
    "S-DETL-HIDD":  LayerDef("S-DETL-HIDD",  8, "HIDDEN",     _THIN,   "Gizli hatlar"),
    "S-DETL-CNTR":  LayerDef("S-DETL-CNTR",  1, "CENTER",     _THIN,   "Eksen / simetri çizgileri"),
    "S-DETL-PATT":  LayerDef("S-DETL-PATT",  8, "CONTINUOUS", _THIN,   "Kesit tarama (hatch)"),
    "S-ANNO-DIMS":  LayerDef("S-ANNO-DIMS",  3, "CONTINUOUS", _THIN,   "Ölçülendirme (EN ISO 129-1)"),
    "S-ANNO-TEXT":  LayerDef("S-ANNO-TEXT",  7, "CONTINUOUS", _THIN,   "Genel yazı / notlar"),
    "S-ANNO-WELD":  LayerDef("S-ANNO-WELD",  2, "CONTINUOUS", _MEDIUM, "Kaynak sembolleri (AWS A2.4 / ISO 2553)"),
    "S-ANNO-BOLT":  LayerDef("S-ANNO-BOLT",  4, "CONTINUOUS", _MEDIUM, "Cıvata / delik gösterimleri"),
    "S-ANNO-MARK":  LayerDef("S-ANNO-MARK",  6, "CONTINUOUS", _THIN,   "Part / piece mark balonları"),
    "S-ANNO-SYMB":  LayerDef("S-ANNO-SYMB",  5, "CONTINUOUS", _THIN,   "Kesit / detay referans işaretleri"),
    "S-ANNO-TTLB":  LayerDef("S-ANNO-TTLB",  7, "CONTINUOUS", _MEDIUM, "Antet / çerçeve (ISO 7200)"),
    "S-ANNO-GRID":  LayerDef("S-ANNO-GRID",  1, "CENTER",     _THIN,   "Aks çizgileri"),
}


def layer_names() -> list[str]:
    return list(LAYERS)
