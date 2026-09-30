"""Görünüş seçim katmanı — şablon (worst-case set) + zarf (guard) kontrolü.

Felsefe (bkz. sohbet kararı):
    * Şablon tabanlı: bağlantı tipine SABİT bir görünüş seti atanır. Şablon,
      tipin varsayımları içinde kalan HER parça için yeterli olacak şekilde
      "worst case"e göre tasarlanır (fazla görünüş > eksik görünüş).
    * Zarf kontrolü: parça, şablonun varsaydığı geometrik zarfın DIŞINA çıkarsa
      sessizce eksik üretmek yerine ya ek görünüş önerilir ya da "manuel inceleme
      gerekli" bayrağı basılır. Sessiz eksiklik en tehlikeli sonuçtur.

Bu modül yalnızca KARAR verir (hangi görünüşler + hangi bayraklar). Çizimi
bağlantı üreteci yapar. Böylece karar mantığı çizimden bağımsız test edilir.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class View(str, Enum):
    """Bir teknik çizimde üretilebilecek görünüş türleri."""
    FRONT = "FRONT"      # ön görünüş / elevation — levha derinliği, cıvata sırası, kaynak
    TOP = "TOP"          # üst görünüş / plan — levha kalınlığı, hangi taraf, boşluk, çift taraf
    SECTION = "SECTION"  # kesit (cıvata hizasından) — kiriş gövdesi + levha + cıvata gövdesi
    AUX = "AUX"          # yardımcı görünüş — eğik/şevli yüzeyin gerçek boyu
    DETAIL = "DETAIL"    # detay (büyütülmüş) — kritik lokal bölge (ör. kesim/kertme)


class Severity(str, Enum):
    INFO = "INFO"        # bilgi: şablon içinde, standart davranış
    WARN = "WARN"        # şablon zarfının kenarında — ek görünüş otomatik eklendi
    REVIEW = "REVIEW"    # zarf DIŞI — manuel inceleme gerekli, sessiz üretme


@dataclass(frozen=True)
class ViewFlag:
    code: str            # makine-okur kod (ör. "SKEW")
    severity: Severity
    message: str         # insan-okur açıklama


@dataclass
class ViewPlan:
    views: list[View]
    flags: list[ViewFlag] = field(default_factory=list)

    @property
    def needs_manual_review(self) -> bool:
        return any(f.severity is Severity.REVIEW for f in self.flags)

    def add(self, view: View) -> None:
        if view not in self.views:
            self.views.append(view)


# --- Zarf eşikleri (fin plate) -------------------------------------------
# Çelik detaylandırmada ~±2° içindeki sapma "kare" (dik) kabul edilir; bunun
# üzeri gerçek-boy sorunları doğurur. Değerler şablon varsayımıdır, standart
# tablo değeri DEĞİLDİR — bu yüzden burada, geometri kaynağında tutulur.
SKEW_TOL_DEG = 2.0    # kirişin ayağı dikten sapması için tolerans
SLOPE_TOL_DEG = 2.0   # kiriş eğimi (elevation'ın gerçek-boy olmama eşiği)


def bearing_member_base_views() -> list[View]:
    """Bir fin plate bağlantısında BEARING MEMBER'ı (destek + kaynaklı levha)
    tek başına eksiksiz gösteren minimum görünüş seti.

    Ayrıştırma ilkesi: önce taşıyıcı (bearing) elemanı bul; onu eksiksiz
    göstermek için kaç görünüş gerektiğini saptamak KOLAYDIR — çünkü çizimin
    koordinat sistemini o belirler (bkz. Tekla ana-parça mantığı). Taşınan her
    eleman genellikle bunun üzerine yalnızca +1 görünüş ekler.

        FRONT   — levha yüksekliği, cıvata sırası, kaynak, part-mark
        SECTION — destek yüzüne kaynak + levha kalınlığı (elevation'da görünmez)
    """
    return [View.FRONT, View.SECTION]


def finplate_view_plan(
    *,
    n_supported: int | None = None,  # taşınan eleman sayısı; None -> sides'tan türet
    skew_angle: float = 90.0,   # plan'da kirişin destek yüzüne yaptığı açı (90 = dik)
    slope_angle: float = 0.0,   # kirişin düşeyle/yatayla eğimi (0 = düz)
    sides: int = 1,             # 1 = tek taraflı levha, 2 = gövdenin iki tarafı
    n_cols: int = 1,            # düşey cıvata sırası (kolon) sayısı
    coped: bool = False,        # kirişte kertme/kesim (cope) var mı
) -> ViewPlan:
    """Fin plate görünüş seti: bearing-member tabanı + taşınan eleman başına +1.

    Hesap:
        views = bearing_member_base_views()      # FRONT + SECTION
              + her taşınan eleman için TOP/plan  # cıvatalı kiriş(ler)

    Tek destek + tek kiriş (dik, tek sıra, kertmesiz) için sonuç FRONT+SECTION+TOP
    = 3 görünüş; bu, tek görünüşün gösteremediğini (kalınlık + taraf + gövde
    ilişkisi) kapsar ve YETERLİDİR. Taşınan eleman arttıkça (çift taraf) her biri
    +1 görünüş getirir.
    """
    if n_supported is None:
        n_supported = max(1, sides)   # çift taraflı = gövdenin iki yanında birer kiriş

    # 1) Bearing member (destek + kaynaklı levha) — tabanı o belirler
    plan = ViewPlan(views=list(bearing_member_base_views()))
    # 2) Taşınan her eleman genellikle +1 görünüş (plan/top)
    plan.add(View.TOP)
    if n_supported > 1:
        plan.flags.append(ViewFlag(
            "MULTI_SUPPORTED", Severity.WARN,
            f"{n_supported} taşınan eleman: bearing tabanına ek olarak her biri "
            "+1 görünüş gerektirir; taşınan elemanlar tek plan görünüşünde "
            "birleştirilemiyorsa ayrı görünüş açılmalı.",
        ))

    # --- Zarf kontrolleri ---
    skew_dev = abs(skew_angle - 90.0)
    if skew_dev > SKEW_TOL_DEG:
        plan.add(View.AUX)
        plan.flags.append(ViewFlag(
            "SKEW", Severity.REVIEW,
            f"Kiriş {skew_dev:.1f}° eğik bağlanıyor (>{SKEW_TOL_DEG}°): üst görünüş "
            f"izdüşüm gösterir, gerçek boy için yardımcı görünüş eklendi — "
            f"cıvata/boşluk ölçüleri manuel doğrulanmalı.",
        ))

    if abs(slope_angle) > SLOPE_TOL_DEG:
        plan.add(View.AUX)
        plan.flags.append(ViewFlag(
            "SLOPE", Severity.REVIEW,
            f"Kiriş {abs(slope_angle):.1f}° eğimli (>{SLOPE_TOL_DEG}°): ön görünüş "
            f"gerçek boy değil, yardımcı görünüş eklendi — manuel inceleme gerekli.",
        ))

    if sides >= 2:
        plan.flags.append(ViewFlag(
            "DOUBLE_SIDED", Severity.WARN,
            "Çift taraflı levha: üst görünüş her iki levhayı göstermeli; ön "
            "görünüşte levhalar çakışır — kesit ikinci levhayı da işaretlemeli.",
        ))

    if n_cols > 1:
        plan.flags.append(ViewFlag(
            "MULTI_COLUMN", Severity.WARN,
            f"{n_cols} düşey cıvata sırası: ön görünüşe yatay gauge ölçüsü "
            "eklenmeli (şablon tek sıra varsayar).",
        ))

    if coped:
        plan.add(View.DETAIL)
        plan.flags.append(ViewFlag(
            "COPED", Severity.WARN,
            "Kirişte kertme (cope) var: kertme geometrisi ön görünüşte tam "
            "görünmez, detay görünüşü eklendi.",
        ))

    return plan
