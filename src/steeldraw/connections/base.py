"""Bağlantı üreteçleri için ortak temel."""
from __future__ import annotations

from dataclasses import dataclass

from ezdxf.document import Drawing
from ezdxf.layouts import Modelspace

from ..dxf.document import DIMSTYLE_NAME, new_document
from ..standards import Standard, get_standard


@dataclass
class Connection:
    """Tüm bağlantı üreteçlerinin tabanı."""
    standard: Standard

    @classmethod
    def with_standard(cls, name: str, **kwargs):
        return cls(standard=get_standard(name), **kwargs)

    def build(self, scale: float = 5.0) -> Drawing:
        doc = new_document(scale=scale)
        self.draw(doc.modelspace(), doc)
        return doc

    def draw(self, msp: Modelspace, doc: Drawing) -> None:  # pragma: no cover - abstract
        raise NotImplementedError

    def save(self, path: str, scale: float = 5.0) -> None:
        self.build(scale=scale).saveas(path)


def add_linear_dim_rendered(msp: Modelspace, base, p1, p2, *, angle: float = 0.0):
    """add_linear_dim + ZORUNLU render() sarmalayıcısı (AISC/AutoCAD tuzağı)."""
    dim = msp.add_linear_dim(
        base=base, p1=p1, p2=p2, angle=angle,
        dimstyle=DIMSTYLE_NAME,
        dxfattribs={"layer": "S-ANNO-DIMS"},
    )
    dim.render()
    return dim
