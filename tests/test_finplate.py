"""Fin plate üretecinin uçtan uca (DXF) testi."""
import ezdxf

from steeldraw.connections.finplate import FinPlate


def _build(standard, bolt, n):
    doc = FinPlate.with_standard(standard, bolt=bolt, n_bolts=n).build(scale=5)
    return doc


def test_finplate_aisc_audit_clean():
    doc = _build("AISC", "3/4in", 3)
    auditor = doc.audit()
    assert len(auditor.errors) == 0
    assert len(doc.modelspace()) > 0


def test_finplate_ec3_audit_clean():
    doc = _build("EC3", "M20", 4)
    auditor = doc.audit()
    assert len(auditor.errors) == 0


def test_finplate_has_expected_layers_and_blocks():
    doc = _build("AISC", "3/4in", 3)
    assert "S-DETL" in doc.layers
    assert "S-ANNO-DIMS" in doc.layers
    # cıvata deliği bloğu üretildi
    assert any(b.name.startswith("BOLT_") for b in doc.blocks)


def test_finplate_dimensions_rendered():
    # add_linear_dim sonrası render() edilmezse AutoCAD göstermez.
    doc = _build("EC3", "M20", 3)
    dims = doc.modelspace().query("DIMENSION")
    assert len(dims) >= 4
