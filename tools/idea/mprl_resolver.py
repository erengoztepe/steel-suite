r"""
Resolve a steel profile NAME into the parametric cross-section IDEA StatiCa's
Connection REST API needs for `import_iom`.

WHY THIS EXISTS
---------------
steel-suite's viewer emits IOM cross-sections *by name only* (a `UniqueName`
string, e.g. "UC 203 x 203 x 46"). IDEA StatiCa Checkbot tolerates that (it has
an interactive section-mapping step), but the headless REST `import_iom` does
NOT — it needs a fully parametric section and otherwise fails with
    "Missing cross-section parameter 'B'".
So before import we rewrite each name-only section into a parametric one.

DIMENSION SOURCE
----------------
IDEA's own Material & Profile Reference Library, shipped as a SQLite DB inside
the install: `...\StatiCa 26.0\MprlData.sqlite`. Reading dimensions from there
means they match IDEA exactly (same install, same catalog).

PARAM SCHEMAS (verified against IDEA's own `export_iom` output, not guessed)
---------------------------------------------------------------------------
  RolledI  : B, H, s, t, r2, tapperF, r1     (B←B, H←D, s←tw, t←tf, r2←rw, r1←r1)
  RolledCHS: R, t                            (R = D/2 outer radius)
  RolledRHS: D, B, t, r1, r2, d              (1:1 with MPRL DimensionSerialized)
NOTE the I-section radius convention: IDEA r2 = ROOT radius (MPRL 'rw'),
IDEA r1 = TOE radius (MPRL 'r1'). They are the opposite of what the names
suggest; this was confirmed by exporting HEA240 from IDEA (r2=0.021, r1=0.0001).

All lengths are SI metres (as IOM requires).
"""
from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

DEFAULT_MPRL = r"C:\Program Files\IDEA StatiCa\StatiCa 26.0\MprlData.sqlite"

# Leading-alpha prefix -> family. Longest match wins.
_I_PREFIXES = {
    "UC", "UB", "UKC", "UKB", "UBP", "UKBP", "UKA",
    "HE", "HEA", "HEB", "HEM", "HD", "HL", "HP", "HN",
    "IPE", "IPN", "I", "W", "J", "S", "M", "UKPFC",  # (UKPFC handled as channel below)
}


@dataclass
class CssSpec:
    css_type: str                 # IOM CrossSectionType string
    params: list                  # ordered [(name, value_metres), ...]
    matched_name: str             # the MPRL entry we matched
    note: str = ""                # e.g. "approx radii" when a fallback was used


def _nums(text: str) -> list:
    """All numeric tokens in a name, as floats (handles 114.3, 14.2, comma dec)."""
    return [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", text)]


def _prefix(name: str) -> str:
    m = re.match(r"\s*([A-Za-z]+)", name)
    return (m.group(1).upper() if m else "")


def _norm(name: str) -> str:
    """Uppercase, drop spaces — so 'UC 305 x 305 x 118' == 'UC305x305x118'."""
    return re.sub(r"\s+", "", name).upper()


class MprlResolver:
    def __init__(self, db_path: str = DEFAULT_MPRL):
        self.db_path = db_path
        # Read-only + immutable so we can read while the IDEA service holds the file.
        uri = f"file:{Path(db_path).as_posix()}?mode=ro&immutable=1"
        self.con = sqlite3.connect(uri, uri=True)
        self._i_by_norm: dict[str, dict] = {}
        self._chs: list[tuple[float, float, str]] = []          # (D, t, name)
        self._rhs: list[tuple[float, float, float, str, dict]] = []  # (D, B, t, name, dim)
        self._load()

    # ---- load caches -------------------------------------------------- #
    def _rows(self, table: str):
        try:
            return self.con.execute(
                f"SELECT Name, DimensionSerialized FROM '{table}' WHERE DimensionSerialized IS NOT NULL"
            ).fetchall()
        except sqlite3.Error:
            return []

    def _load(self):
        for name, dim_s in self._rows("CssIProfiles"):
            try:
                dim = json.loads(dim_s)
            except Exception:
                continue
            self._i_by_norm[_norm(name)] = dim
        for name, dim_s in self._rows("CssCircularHollows"):
            try:
                dim = json.loads(dim_s)
            except Exception:
                continue
            self._chs.append((dim.get("D", 0.0), dim.get("t", 0.0), name))
        for table in ("CssSquareHollows", "CssRectangularHollows"):
            for name, dim_s in self._rows(table):
                try:
                    dim = json.loads(dim_s)
                except Exception:
                    continue
                self._rhs.append((dim.get("D", 0.0), dim.get("B", 0.0), dim.get("t", 0.0), name, dim))

    # ---- public API --------------------------------------------------- #
    def resolve(self, profile: str) -> Optional[CssSpec]:
        if not profile:
            return None
        fam = self._family(profile)
        if fam == "I":
            return self._resolve_i(profile)
        if fam == "CHS":
            return self._resolve_chs(profile)
        if fam in ("RHS", "SHS"):
            return self._resolve_rhs(profile)
        return None  # unsupported family (e.g. FAB welded box, channel, angle, T)

    def _family(self, profile: str) -> str:
        p = _prefix(profile)
        if p == "CHS":
            return "CHS"
        if p == "RHS":
            return "RHS"
        if p == "SHS":
            return "SHS"
        if p in _I_PREFIXES:
            return "I"
        return "?"

    # ---- per-family resolution --------------------------------------- #
    def _resolve_i(self, profile: str) -> Optional[CssSpec]:
        dim = self._i_by_norm.get(_norm(profile))
        if dim is None:
            return None
        params = [
            ("B", dim["B"]), ("H", dim["D"]), ("s", dim["tw"]), ("t", dim["tf"]),
            ("r2", dim.get("rw", 0.0)), ("tapperF", dim.get("tapperF", 0)), ("r1", dim.get("r1", 0.0)),
        ]
        return CssSpec("RolledI", params, profile)

    def _resolve_chs(self, profile: str) -> Optional[CssSpec]:
        n = _nums(profile)
        if len(n) < 2:
            return None
        d_mm, t_mm = n[0], n[1]
        best = self._closest_hollow(self._chs, [(d_mm, 0), (t_mm, 1)])
        if best is None:
            return None
        D, t, name = best
        return CssSpec("RolledCHS", [("R", D / 2.0), ("t", t)], name)

    def _resolve_rhs(self, profile: str) -> Optional[CssSpec]:
        n = _nums(profile)
        if len(n) < 3:
            return None
        d_mm, b_mm, t_mm = n[0], n[1], n[2]
        # Prefer plain hot-finished names (RHS/SHS) over cold-formed variants.
        cands = [(D, B, t, name, dim) for (D, B, t, name, dim) in self._rhs
                 if abs(D * 1000 - d_mm) < 0.6 and abs(B * 1000 - b_mm) < 0.6 and abs(t * 1000 - t_mm) < 0.15]
        if not cands:
            return None
        cands.sort(key=lambda c: (not _prefix(c[3]) in ("RHS", "SHS"), c[3]))
        D, B, t, name, dim = cands[0]
        params = [
            ("D", dim["D"]), ("B", dim["B"]), ("t", dim["t"]),
            ("r1", dim.get("r1", 0.0)), ("r2", dim.get("r2", 0.0)), ("d", dim.get("d", 0.0)),
        ]
        return CssSpec("RolledRHS", params, name)

    @staticmethod
    def _closest_hollow(rows, keys_mm):
        """rows: tuples with metre values at given indices; keys_mm: [(target_mm, idx)]."""
        best = None
        best_err = 1e9
        for row in rows:
            err = 0.0
            ok = True
            for target_mm, idx in keys_mm:
                v_mm = row[idx] * 1000.0
                err += abs(v_mm - target_mm)
                if abs(v_mm - target_mm) > max(0.6, 0.01 * target_mm):
                    ok = False
                    break
            if ok and err < best_err:
                best_err = err
                best = row
        return best


# Canonical CrossSectionType order for stable output (matches IDEA's export).
def params_to_xml(params: list) -> str:
    def esc(v):
        return v
    out = []
    for name, val in params:
        out.append(
            f'<Parameter xsi:type="ParameterDouble"><Name>{name}</Name><Value>{val}</Value></Parameter>'
        )
    return "".join(out)


if __name__ == "__main__":
    import sys
    r = MprlResolver(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MPRL)
    for p in ["UC 203 x 203 x 46", "UB 203 x 133 x 25", "CHS 114.3 x 5",
              "RHS 500 x 300 x 14.2", "UC305x305x118", "FAB-BOX 650x300x35"]:
        spec = r.resolve(p)
        if spec:
            print(f"{p:24} -> {spec.css_type:10} {spec.params}  [{spec.matched_name}] {spec.note}")
        else:
            print(f"{p:24} -> UNRESOLVED")
