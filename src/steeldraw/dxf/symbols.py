"""Tekrar eden semboller için blok (BLOCK) fabrikası.

Doğrulanmış ezdxf pratiği: tekrar eden geometri bir kez blok tanımı olarak
oluşturulur (doc.blocks.new), sonra add_blockref ile örneklenir; her örnek
bağımsız ölçek/döndürme alır. Cıvata delikleri, kaynak sembolü kuyruğu,
part-mark balonu gibi öğeler için idealdir.

Bloklar 1 birim = 1 mm ölçeğinde, cıvata NOMINAL çapına göre parametrik
adlarla tanımlanır (ör. BOLT_STD_20). Örnekleme sırasında ölçek 1.0'dır;
geometri zaten gerçek mm boyutundadır.
"""
from __future__ import annotations

from ezdxf.document import Drawing

from .layers import LAYERS  # noqa: F401  (katman adlarına referans netliği için)

_BOLT_LAYER = "S-ANNO-BOLT"


def _bolt_block_name(hole_w: float, hole_l: float) -> str:
    if abs(hole_w - hole_l) < 1e-6:
        return f"BOLT_RND_{hole_w:.1f}".replace(".", "_")
    return f"BOLT_SLOT_{hole_w:.1f}x{hole_l:.1f}".replace(".", "_")


def bolt_hole_block(doc: Drawing, hole_w: float, hole_l: float, *, with_center: bool = True) -> str:
    """Bir cıvata deliği bloğu tanımlar (yoksa) ve blok adını döndürür.

    Yuvarlak delik -> daire; oval delik -> iki yarım daire + iki doğru (slot).
    Merkez işareti eksen katmanında küçük artı olarak eklenir.
    Blok origin = delik merkezi.
    """
    name = _bolt_block_name(hole_w, hole_l)
    if name in doc.blocks:
        return name
    blk = doc.blocks.new(name=name)
    r = hole_w / 2.0

    if abs(hole_w - hole_l) < 1e-6:
        blk.add_circle((0, 0), r, dxfattribs={"layer": _BOLT_LAYER})
    else:
        # Yatay oval: merkezler ±((L-W)/2)
        dx = (hole_l - hole_w) / 2.0
        blk.add_arc((-dx, 0), r, 90, 270, dxfattribs={"layer": _BOLT_LAYER})
        blk.add_arc((dx, 0), r, 270, 90, dxfattribs={"layer": _BOLT_LAYER})
        blk.add_line((-dx, r), (dx, r), dxfattribs={"layer": _BOLT_LAYER})
        blk.add_line((-dx, -r), (dx, -r), dxfattribs={"layer": _BOLT_LAYER})

    if with_center:
        c = max(r * 0.6, 1.5)
        blk.add_line((-c, 0), (c, 0), dxfattribs={"layer": "S-DETL-CNTR"})
        blk.add_line((0, -c), (0, c), dxfattribs={"layer": "S-DETL-CNTR"})
    return name


def part_mark_block(doc: Drawing, radius: float = 6.0) -> str:
    """Part/piece mark balonu (daire) bloğu. Metin çağrı yerinde eklenir."""
    name = f"MARK_BALLOON_{radius:.0f}"
    if name in doc.blocks:
        return name
    blk = doc.blocks.new(name=name)
    blk.add_circle((0, 0), radius, dxfattribs={"layer": "S-ANNO-MARK"})
    return name
