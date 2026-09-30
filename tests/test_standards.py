"""Standart değer tablolarının regresyon testleri.

Birincil kaynaktan doğrulanmış değerleri kilitler; araştırmada ÇÜRÜTÜLEN
yaklaşık değerlerin (delik=çap+2mm, s>=3d vb.) geri sızmasını engeller.
"""
import math

import pytest

from steeldraw.standards import HoleType, available, get_standard

MM = 25.4


def test_both_standards_registered():
    assert set(available()) == {"AISC", "EC3"}


# --- AISC (AISC 360-16/-22) ---

def test_aisc_std_hole_3_4():
    b = get_standard("AISC").bolt("3/4in")
    # STD delik = 13/16" = 20.6375 mm
    assert b.holes[HoleType.STD][0] == pytest.approx(13 / 16 * MM)
    # min kenar = 1" = 25.4 mm (tek sütun, 360-16/-22)
    assert b.min_edge_rolled == pytest.approx(1.0 * MM)
    assert b.min_edge_rolled == b.min_edge_sheared  # ayrım kaldırıldı


def test_aisc_spacing_min_is_2_667d_not_3d():
    b = get_standard("AISC").bolt("3/4in")
    # ÇÜRÜTÜLEN: min aralık 3d DEĞİL; kod minimumu 2-2/3 d
    assert b.min_spacing == pytest.approx(2.667 * 0.75 * MM)
    assert b.pref_spacing == pytest.approx(3.0 * 0.75 * MM)


def test_aisc_max_edge_and_spacing():
    s = get_standard("AISC")
    # max kenar = min(12t, 6in). t=10mm -> 120 vs 152.4 -> 120
    assert s.max_edge(10) == pytest.approx(120.0)
    # max aralık = min(24t, 12in). t=10 -> 240 vs 304.8 -> 240
    assert s.max_spacing(10) == pytest.approx(240.0)


# --- Eurocode (EN 1993-1-8 + EN 1090-2) ---

def test_ec3_m20_hole_is_22():
    b = get_standard("EC3").bolt("M20")
    # EN 1090-2 Tablo 11: M20 normal yuvarlak = d + 2 = 22 mm
    assert b.holes[HoleType.STD][0] == 22.0
    assert b.nominal_d == 20.0


def test_ec3_m20_edge_and_spacing_from_d0():
    b = get_standard("EC3").bolt("M20")
    d0 = 22.0
    assert b.min_edge_rolled == pytest.approx(1.2 * d0)   # 26.4
    assert b.min_spacing == pytest.approx(2.2 * d0)       # 48.4


def test_ec3_m24_oversize_is_6mm_clearance_not_4():
    b = get_standard("EC3").bolt("M24")
    # ÇÜRÜTÜLEN calc değeri: OVS = d+4. DOĞRU (Tablo 11): M24 OVS = d+6 = 30
    assert b.holes[HoleType.OVS][0] == 30.0


def test_ec3_max_spacing_capped_at_200():
    s = get_standard("EC3")
    assert s.max_spacing(20) == pytest.approx(min(14 * 20, 200))  # 200
    assert s.max_edge(10) == pytest.approx(4 * 10 + 40)           # 80


def test_slot_is_longer_than_wide():
    for std, desig in [("AISC", "3/4in"), ("EC3", "M20")]:
        b = get_standard(std).bolt(desig)
        w, l = b.holes[HoleType.SSL]
        assert l > w, f"{std} {desig} kısa oval uzunluk>genişlik olmalı"
        w2, l2 = b.holes[HoleType.LSL]
        assert l2 > l, "uzun oval, kısa ovalden uzun olmalı"
