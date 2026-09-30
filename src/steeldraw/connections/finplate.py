"""Fin plate (yüzey levhası / shear tab) kesme bağlantısı — ön görünüş.

Standarttan gelen geometriyle (delik boyutu, min kenar, tercih edilen aralık)
parametrik olarak yerleşimi hesaplar; levhayı, cıvata deliklerini (blok),
kaynak sembolünü, ölçüleri ve part-mark balonunu çizer.

Yerleşim (ön görünüş, destek yüzü solda x=0):
    y ekseni yukarı, cıvatalar x=gauge'de tek düşey sıra.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ezdxf.document import Drawing
from ezdxf.enums import TextEntityAlignment
from ezdxf.layouts import Modelspace

from ..dxf.symbols import bolt_hole_block, part_mark_block
from ..standards import HoleType, WeldConvention
from .base import Connection, add_linear_dim_rendered
from .viewplan import ViewPlan, finplate_view_plan

_PLATE_LAYER = "S-DETL"
_TEXT_LAYER = "S-ANNO-TEXT"
_WELD_LAYER = "S-ANNO-WELD"


@dataclass
class FinPlate(Connection):
    bolt: str = "3/4in"          # cıvata tanımı (standarda göre)
    n_bolts: int = 3             # düşey cıvata sayısı
    plate_thickness: float = 10  # mm (bilgi/etikette; ön görünüşte gösterilmez)
    hole_type: HoleType = HoleType.STD
    pitch: float | None = None   # c-c aralık (mm); None -> tercih edilen
    edge_v: float | None = None  # üst/alt kenar mesafesi (mm); None -> min kenar
    gauge: float = 50            # kaynaklı kenardan cıvata sırasına yatay mesafe (mm)
    end_edge: float | None = None  # serbest düşey kenara mesafe (mm); None -> min kenar
    weld_size: float = 6         # köşe kaynağı bacak boyu (mm)
    part_mark: str = "p1"
    # --- Görünüş zarfı (şablon dışı geometriyi yakalamak için) ---
    skew_angle: float = 90.0     # plan'da kirişin destek yüzüne açısı (90 = dik)
    slope_angle: float = 0.0     # kiriş eğimi (0 = düz)
    sides: int = 1               # 1 = tek taraflı, 2 = gövdenin iki tarafı
    n_cols: int = 1              # düşey cıvata sırası (kolon) sayısı
    coped: bool = False          # kirişte kertme (cope) var mı
    _bg: object = field(default=None, init=False, repr=False)

    def view_plan(self) -> ViewPlan:
        """Bu fin plate için gereken görünüş seti + şablon-dışı bayraklar."""
        return finplate_view_plan(
            skew_angle=self.skew_angle,
            slope_angle=self.slope_angle,
            sides=self.sides,
            n_cols=self.n_cols,
            coped=self.coped,
        )

    def _geom(self):
        bg = self.standard.bolt(self.bolt)
        pitch = self.pitch or round(bg.pref_spacing)
        edge_v = self.edge_v or round(bg.min_edge_rolled)
        end_edge = self.end_edge or round(bg.min_edge_rolled)
        return bg, pitch, edge_v, end_edge

    def draw(self, msp: Modelspace, doc: Drawing) -> None:
        bg, pitch, edge_v, end_edge = self._geom()
        hw, hl = bg.hole(self.hole_type)

        depth = (self.n_bolts - 1) * pitch + 2 * edge_v
        width = self.gauge + end_edge

        # --- Destek yüzü (kaynaklı kenar), x=0 düşey çizgi ---
        y_top, y_bot = depth / 2, -depth / 2
        msp.add_line((0, y_top + 20), (0, y_bot - 20),
                     dxfattribs={"layer": _PLATE_LAYER})

        # --- Fin plate dış hattı ---
        msp.add_lwpolyline(
            [(0, y_bot), (width, y_bot), (width, y_top), (0, y_top)],
            close=True, dxfattribs={"layer": _PLATE_LAYER},
        )

        # --- Cıvata delikleri (blok) ---
        blk = bolt_hole_block(doc, hw, hl)
        bolt_ys = [y_bot + edge_v + i * pitch for i in range(self.n_bolts)]
        for by in bolt_ys:
            msp.add_blockref(blk, (self.gauge, by), dxfattribs={"layer": "S-ANNO-BOLT"})

        # --- Kaynak sembolü (standart konvansiyonuna göre) ---
        self._weld_symbol(msp, at=(0, 0))

        # --- Part-mark balonu ---
        mb = part_mark_block(doc, radius=6)
        mx, my = width + 24, y_top
        msp.add_blockref(mb, (mx, my), dxfattribs={"layer": "S-ANNO-MARK"})
        msp.add_text(self.part_mark, height=3.0,
                     dxfattribs={"layer": "S-ANNO-MARK", "style": "STEEL"}
                     ).set_placement((mx, my), align=TextEntityAlignment.MIDDLE_CENTER)
        msp.add_line((width, y_top), (mx - 6, my),
                     dxfattribs={"layer": "S-ANNO-MARK"})

        # --- Ölçülendirme ---
        self._dimension(msp, bolt_ys, edge_v, pitch, width, depth, y_top, y_bot)

        # --- Etiket ---
        label = (f"FIN PLATE {self.part_mark}  |  {self.n_bolts}x{self.bolt} "
                 f"({self.hole_type.value})  |  t={self.plate_thickness}  |  {self.standard.name}")
        msp.add_text(label, height=3.0,
                     dxfattribs={"layer": _TEXT_LAYER, "style": "STEEL"}
                     ).set_placement((0, y_bot - 40), align=TextEntityAlignment.LEFT)

    def _dimension(self, msp, bolt_ys, edge_v, pitch, width, depth, y_top, y_bot):
        xd = width + 55  # ölçü zinciri x konumu (sağda)
        # Alt kenar mesafesi
        add_linear_dim_rendered(msp, base=(xd, 0), p1=(self.gauge, y_bot), p2=(self.gauge, bolt_ys[0]), angle=90)
        # Cıvata pitch zinciri
        for i in range(len(bolt_ys) - 1):
            add_linear_dim_rendered(msp, base=(xd, 0), p1=(self.gauge, bolt_ys[i]), p2=(self.gauge, bolt_ys[i + 1]), angle=90)
        # Üst kenar mesafesi
        add_linear_dim_rendered(msp, base=(xd, 0), p1=(self.gauge, bolt_ys[-1]), p2=(self.gauge, y_top), angle=90)
        # Yatay: gauge ve toplam genişlik
        add_linear_dim_rendered(msp, base=(0, y_bot - 20), p1=(0, y_bot), p2=(self.gauge, y_bot), angle=0)
        add_linear_dim_rendered(msp, base=(0, y_bot - 32), p1=(0, y_bot), p2=(width, y_bot), angle=0)

    def _weld_symbol(self, msp, at):
        """Köşe (fillet) kaynak sembolü — ok + dirsek + referans çizgisi + üçgen.

        AWS A2.4: ok tarafı sembolü referans çizgisinin ALTINA çizilir.
        ISO 2553: sürekli referans çizgisine ek olarak kesikli tanımlama
        (identification) çizgisi bulunur; ok tarafı sürekli çizgi tarafındadır.
        Konvansiyon standard.weld_convention'dan gelir (hardcode edilmez).
        """
        jx, jy = at                 # kaynak kökü (destek yüzü)
        knee = (-28.0, 22.0)        # dirsek noktası
        ref_end = (-72.0, 22.0)     # referans çizgisi sol ucu
        ry = knee[1]

        # Ok kılavuzu (kökten dirseğe) + yatay referans çizgisi
        msp.add_line((jx, jy), knee, dxfattribs={"layer": _WELD_LAYER})
        msp.add_line(knee, ref_end, dxfattribs={"layer": _WELD_LAYER})

        # Ok ucu (küçük dolu üçgen)
        ah = 3.0
        import math
        ang = math.atan2(knee[1] - jy, knee[0] - jx)
        for da in (0.4, -0.4):
            msp.add_line((jx, jy),
                         (jx + ah * math.cos(ang + da), jy + ah * math.sin(ang + da)),
                         dxfattribs={"layer": _WELD_LAYER})

        # Fillet üçgeni (dik sol bacak) — AWS ok tarafı = referans çizgisinin altı
        tri = 4.0
        below = self.standard.weld_convention == WeldConvention.AWS
        tx = knee[0] - 8
        ty = ry - tri if below else ry + tri
        msp.add_lwpolyline(
            [(tx, ry), (tx + tri, ry), (tx, ty)],
            close=True, dxfattribs={"layer": _WELD_LAYER},
        )
        # Kaynak bacak boyu yazısı (üçgenin solu)
        msp.add_text(f"{self.weld_size:g}", height=2.5,
                     dxfattribs={"layer": _WELD_LAYER, "style": "STEEL"}
                     ).set_placement((tx - 3, ry), align=TextEntityAlignment.MIDDLE_RIGHT)

        if self.standard.weld_convention == WeldConvention.ISO:
            # ISO 2553: kesikli tanımlama çizgisi (sürekli çizginin karşı tarafı)
            iy = ry + 3.5
            msp.add_line((knee[0], iy), (ref_end[0], iy),
                         dxfattribs={"layer": _WELD_LAYER, "linetype": "DASHED"})
