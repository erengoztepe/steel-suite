"""Standart-parametrik değer katmanı.

Araç iki standardı da destekler: AISC (emperyal) ve Eurocode/TS EN (metrik).
Bağlantı geometrisi (delik boyutu, kenar mesafesi, cıvata aralığı) ve kaynak
sembolü konvansiyonu standarda göre çatallanır. Tüm geometrik değerler dışarıya
**milimetre** cinsinden verilir; AISC tabloları inç'ten mm'ye çevrilir.

ÖNEMLİ: Buradaki sayısal değerler yalnızca birincil standart tablolarından
(AISC J3.3/J3.4/J3.5, EN 1993-1-8 Tablo 3.3, EN 1090-2) doldurulur. Araştırmada
çürütülen "yaklaşık" değerler (s>=3d, kenar 1.5-2D, delik=çap+2mm vb.) burada
KULLANILMAZ — bkz. memory/steel-drawing-rules.md.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol


class HoleType(str, Enum):
    STD = "STD"   # standart yuvarlak delik
    OVS = "OVS"   # büyük (oversize) delik
    SSL = "SSL"   # kısa oval (short-slotted)
    LSL = "LSL"   # uzun oval (long-slotted)


class WeldConvention(str, Enum):
    """Kaynak sembolü yerleşim konvansiyonu. AWS ile ISO 2553 arasında
    ok-tarafı/diğer-taraf yerleşimi FARKLIDIR — hardcode edilmez, standarttan gelir."""
    AWS = "AWS"       # Kuzey Amerika (AWS A2.4): ok tarafı = referans çizgisinin altı
    ISO = "ISO"       # ISO 2553: kesikli+düz çift referans çizgisi sistemi


@dataclass(frozen=True)
class BoltGeometry:
    """Bir cıvata çapı için doğrulanmış geometri (mm)."""
    designation: str        # ör. "M20" veya "3/4in"
    nominal_d: float        # nominal cıvata çapı (mm)
    holes: dict[HoleType, tuple[float, float]]  # delik tipi -> (genişlik, uzunluk) mm; yuvarlakta ikisi eşit
    min_edge_rolled: float  # merkezden haddelenmiş kenara min mesafe (mm)
    min_edge_sheared: float # kesilmiş/alev kesim kenara min mesafe (mm)
    min_spacing: float      # min merkez-merkez aralık (mm)
    pref_spacing: float     # tercih edilen merkez-merkez aralık (mm)

    def hole(self, htype: HoleType) -> tuple[float, float]:
        return self.holes[htype]


class Standard(Protocol):
    """İki standardın da uyguladığı ortak arayüz."""
    name: str
    units: str                 # "imperial" | "metric" — kaynak birimi (çıktı hep mm)
    weld_convention: WeldConvention

    def bolt(self, designation: str) -> BoltGeometry: ...

    def max_edge(self, thickness_mm: float) -> float:
        """Azami kenar mesafesi (mm) — levha kalınlığına bağlı."""
        ...

    def max_spacing(self, thickness_mm: float) -> float:
        """Azami cıvata aralığı (mm) — levha kalınlığına bağlı."""
        ...


IN_TO_MM = 25.4


def inch(value: float) -> float:
    """İnç -> mm dönüşümü (AISC tablolarını mm'ye çevirmek için)."""
    return value * IN_TO_MM


_REGISTRY: dict[str, Standard] = {}


def register(std: Standard) -> None:
    _REGISTRY[std.name] = std


def get_standard(name: str) -> Standard:
    if name not in _REGISTRY:
        raise KeyError(f"Bilinmeyen standart: {name!r}. Mevcut: {sorted(_REGISTRY)}")
    return _REGISTRY[name]


def available() -> list[str]:
    return sorted(_REGISTRY)
