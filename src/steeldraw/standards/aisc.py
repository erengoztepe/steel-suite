"""AISC 360 (emperyal) cıvata geometrisi.

Kaynak: ANSI/AISC 360-16/-22 Tablo J3.3 (delik boyutları), Tablo J3.4
(min kenar mesafesi — 2010'dan beri TEK sütun; kesilmiş/haddelenmiş ayrımı
kaldırıldı), Bölüm J3.3 (min aralık) ve J3.5 (max kenar/aralık).
Değerler inç cinsinden girilir, dışarıya mm olarak verilir.

NOT: Sevkiyat öncesi bu tablolar kendi AISC 360-22 kopyanızdan satır satır
teyit edilmeli (araştırmada aisc.org PDF'e 403 nedeniyle doğrudan erişilemedi;
değerler birden çok bağımsız ikincil kaynakla doğrulandı).
"""
from __future__ import annotations

from .base import BoltGeometry, HoleType, Standard, WeldConvention, inch, register

# Tablo J3.3 — inç. Her giriş: (STD çap, OVS çap, SSL (W,L), LSL (W,L))
_J33_IN: dict[str, tuple[float, float, tuple[float, float], tuple[float, float]]] = {
    "1/2in":   (9 / 16,  5 / 8,   (9 / 16, 11 / 16),  (9 / 16, 1 + 1 / 4)),
    "5/8in":   (11 / 16, 13 / 16, (11 / 16, 7 / 8),   (11 / 16, 1 + 9 / 16)),
    "3/4in":   (13 / 16, 15 / 16, (13 / 16, 1.0),     (13 / 16, 1 + 7 / 8)),
    "7/8in":   (15 / 16, 1 + 1 / 16, (15 / 16, 1 + 1 / 8), (15 / 16, 2 + 3 / 16)),
    "1in":     (1 + 1 / 16, 1 + 1 / 4, (1 + 1 / 16, 1 + 5 / 16), (1 + 1 / 16, 2 + 1 / 2)),
    "1-1/8in": (1 + 1 / 8 + 1 / 16, 1 + 1 / 8 + 5 / 16, (1 + 1 / 8 + 1 / 16, 1 + 1 / 8 + 3 / 8), (1 + 1 / 8 + 1 / 16, 2.5 * (1 + 1 / 8))),
    "1-1/4in": (1 + 1 / 4 + 1 / 16, 1 + 1 / 4 + 5 / 16, (1 + 1 / 4 + 1 / 16, 1 + 1 / 4 + 3 / 8), (1 + 1 / 4 + 1 / 16, 2.5 * (1 + 1 / 4))),
}

# Nominal cıvata çapı (inç)
_NOMINAL_IN = {
    "1/2in": 1 / 2, "5/8in": 5 / 8, "3/4in": 3 / 4, "7/8in": 7 / 8,
    "1in": 1.0, "1-1/8in": 1 + 1 / 8, "1-1/4in": 1 + 1 / 4,
}

# Tablo J3.4 — min kenar mesafesi (inç), tek sütun (360-16/-22)
_MIN_EDGE_IN = {
    "1/2in": 3 / 4, "5/8in": 7 / 8, "3/4in": 1.0, "7/8in": 1 + 1 / 8,
    "1in": 1 + 1 / 4, "1-1/8in": 1 + 1 / 2, "1-1/4in": 1 + 5 / 8,
}


class AISC(Standard):
    name = "AISC"
    units = "imperial"
    weld_convention = WeldConvention.AWS

    def bolt(self, designation: str) -> BoltGeometry:
        if designation not in _J33_IN:
            raise KeyError(f"AISC cıvata tanımı yok: {designation!r}. Mevcut: {sorted(_J33_IN)}")
        std, ovs, ssl, lsl = _J33_IN[designation]
        d = _NOMINAL_IN[designation]
        edge = inch(_MIN_EDGE_IN[designation])
        return BoltGeometry(
            designation=designation,
            nominal_d=inch(d),
            holes={
                HoleType.STD: (inch(std), inch(std)),
                HoleType.OVS: (inch(ovs), inch(ovs)),
                HoleType.SSL: (inch(ssl[0]), inch(ssl[1])),
                HoleType.LSL: (inch(lsl[0]), inch(lsl[1])),
            },
            # 360-16/-22: kesilmiş/haddelenmiş kenar ayrımı kaldırıldı -> ikisi eşit
            min_edge_rolled=edge,
            min_edge_sheared=edge,
            min_spacing=inch(2.667 * d),   # J3.3 mutlak minimum: 2-2/3 d
            pref_spacing=inch(3.0 * d),    # tercih edilen: 3d
        )

    def max_edge(self, thickness_mm: float) -> float:
        # J3.5: min(12t, 6 in)
        return min(12.0 * thickness_mm, inch(6.0))

    def max_spacing(self, thickness_mm: float) -> float:
        # J3.5 (boyalı / korozyona maruz olmayan): min(24t, 12 in)
        return min(24.0 * thickness_mm, inch(12.0))


register(AISC())
