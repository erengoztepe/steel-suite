"""Eurocode 3 / TS EN 1993-1-8 (metrik) cıvata geometrisi.

Kaynaklar (birincil standart PDF'lerinden doğrulandı):
- Delik boyutları: EN 1090-2:2018 Tablo 11 (nominal delik toleransları).
- Kenar/aralık: EN 1993-1-8:2005 Tablo 3.3 (min/max), tümü d0 (delik çapı) cinsinden.
- İyi uygulama (tam ezilme dayanımı) Tablo 3.4: e1=3.0d0, e2=1.5d0, p1=3.75d0, p2=3.0d0.

Min değerler (Tablo 3.3): e1=e2=1.2·d0, p1=2.2·d0, p2=2.4·d0.
Tüm değerler zaten mm.
"""
from __future__ import annotations

from .base import BoltGeometry, HoleType, Standard, WeldConvention, register

# Nominal cıvata çapı d (mm)
_D = {"M12": 12, "M14": 14, "M16": 16, "M18": 18, "M20": 20,
      "M22": 22, "M24": 24, "M27": 27, "M30": 30, "M36": 36}

# EN 1090-2 Tablo 11 — normal yuvarlak delik boşluğu (mm) -> d0 = d + boşluk
_NORMAL_CLR = {"M12": 1, "M14": 1, "M16": 2, "M18": 2, "M20": 2,
               "M22": 2, "M24": 2, "M27": 3, "M30": 3, "M36": 3}
# Büyük (oversize) delik boşluğu
_OVS_CLR = {"M12": 3, "M14": 3, "M16": 4, "M18": 4, "M20": 4,
            "M22": 4, "M24": 6, "M27": 8, "M30": 8, "M36": 8}
# Kısa oval delik: uzunluğa eklenen (width = normal yuvarlak d0)
_SSL_ADD = {"M12": 4, "M14": 4, "M16": 6, "M18": 6, "M20": 6,
            "M22": 6, "M24": 8, "M27": 10, "M30": 10, "M36": 10}


def _d0(desig: str) -> float:
    return _D[desig] + _NORMAL_CLR[desig]


class Eurocode(Standard):
    name = "EC3"
    units = "metric"
    weld_convention = WeldConvention.ISO

    def bolt(self, designation: str) -> BoltGeometry:
        if designation not in _D:
            raise KeyError(f"EC3 cıvata tanımı yok: {designation!r}. Mevcut: {sorted(_D)}")
        d = _D[designation]
        d0 = _d0(designation)
        ovs = d + _OVS_CLR[designation]
        ssl_len = d + _SSL_ADD[designation]   # kısa oval uzunluğu (ör. M20 -> 26)
        lsl_len = 1.5 * d                      # uzun oval toplam uzunluğu (ör. M20 -> 30)
        return BoltGeometry(
            designation=designation,
            nominal_d=float(d),
            holes={
                HoleType.STD: (float(d0), float(d0)),
                HoleType.OVS: (float(ovs), float(ovs)),
                HoleType.SSL: (float(d0), float(ssl_len)),
                HoleType.LSL: (float(d0), float(lsl_len)),
            },
            # EN 1993-1-8 min kenar 1.2·d0 (haddelenmiş/kesilmiş ayrımı yok)
            min_edge_rolled=1.2 * d0,
            min_edge_sheared=1.2 * d0,
            min_spacing=2.2 * d0,              # p1 min
            # Detaylandırma varsayılanı: min (2.2·d0) ile iyi-uygulama (3.75·d0) arası
            pref_spacing=round(2.5 * d0),
        )

    def max_edge(self, thickness_mm: float) -> float:
        # Tablo 3.3, maruz (A) sütunu — güvenli varsayılan: 4t + 40 mm
        return 4.0 * thickness_mm + 40.0

    def max_spacing(self, thickness_mm: float) -> float:
        # Tablo 3.3: p1 max = min(14t, 200 mm)
        return min(14.0 * thickness_mm, 200.0)


register(Eurocode())
