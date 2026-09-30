"""Görünüş seçim katmanı (şablon + zarf) testleri."""
from steeldraw.connections.finplate import FinPlate
from steeldraw.connections.viewplan import Severity, View, finplate_view_plan


def test_default_is_bearing_plus_one_supported():
    """Bearing tabanı (FRONT+SECTION) + tek taşınan eleman (TOP), review yok."""
    plan = finplate_view_plan()
    assert plan.views == [View.FRONT, View.SECTION, View.TOP]
    assert not plan.needs_manual_review


def test_extra_supported_member_adds_view_and_warns():
    """Taşınan eleman başına +1: iki kiriş -> MULTI_SUPPORTED bayrağı."""
    plan = finplate_view_plan(n_supported=2)
    assert any(f.code == "MULTI_SUPPORTED" for f in plan.flags)


def test_never_fewer_than_bearing_base():
    """Şablon minimumu asla bearing tabanının (FRONT+SECTION) altına düşmez."""
    plan = finplate_view_plan()
    for required in (View.FRONT, View.SECTION, View.TOP):
        assert required in plan.views


def test_skew_triggers_aux_and_review():
    plan = finplate_view_plan(skew_angle=75.0)
    assert View.AUX in plan.views
    assert plan.needs_manual_review
    assert any(f.code == "SKEW" for f in plan.flags)


def test_small_skew_within_tolerance_is_square():
    plan = finplate_view_plan(skew_angle=91.0)  # 1° < 2° tolerans
    assert View.AUX not in plan.views
    assert not plan.needs_manual_review


def test_slope_triggers_aux_and_review():
    plan = finplate_view_plan(slope_angle=6.0)
    assert View.AUX in plan.views
    assert plan.needs_manual_review


def test_double_sided_warns_but_not_review():
    plan = finplate_view_plan(sides=2)
    assert any(f.code == "DOUBLE_SIDED" for f in plan.flags)
    assert not plan.needs_manual_review  # WARN, REVIEW değil


def test_coped_adds_detail_view():
    plan = finplate_view_plan(coped=True)
    assert View.DETAIL in plan.views
    assert any(f.code == "COPED" and f.severity is Severity.WARN for f in plan.flags)


def test_multi_column_warns():
    plan = finplate_view_plan(n_cols=2)
    assert any(f.code == "MULTI_COLUMN" for f in plan.flags)


def test_finplate_exposes_view_plan():
    fp = FinPlate.with_standard("AISC", bolt="3/4in", n_bolts=3, skew_angle=70.0)
    plan = fp.view_plan()
    assert plan.needs_manual_review
    assert View.AUX in plan.views
