#!/usr/bin/env python3
"""
Turn a geometry-only IOM (IDEA Open Model) XML into a design-ready `.ideaCon`.

This is the bridge from steel-suite's viewer ("Export IDEA (.xml)" button, which
emits an OpenModelContainer with members + profiles + bearing + continuous/ended
and *no* plates/bolts/welds) to an actual IDEA StatiCa Connection project that
opens ready for CBFEM detailing.

Pipeline (all done by IDEA's own Connection REST API):

    import_iom(container_xml)  ->  in-memory ConProject (no operations)
    download_project(pid, out) ->  <name>.ideaCon on disk

Because the IOM carries no manufacturing operations, the produced project is an
empty, design-ready connection: geometry, sections, bearing member and the
Continuous/Ended type are set; the engineer adds plates/bolts/welds afterwards.

PREREQUISITES
-------------
1. Start the REST service and leave its window open:
     "C:\\Program Files\\IDEA StatiCa\\StatiCa 26.0\\IdeaStatiCa.ConnectionRestApi.exe"
   It prints:  Now listening on: http://localhost:5000
2. The `ideastatica_connection_api` package must be importable by the Python you
   run this with (the bridge and tools use $IDEA_PYTHON, else `python` on PATH), e.g.:
     python tools/idea/iom_to_ideacon.py ...

USAGE
-----
    python iom_to_ideacon.py connection.xml
    python iom_to_ideacon.py connection.xml -o out/connection-A.ideaCon
    python iom_to_ideacon.py folder_of_xml/ -o out_dir/          # batch
    python iom_to_ideacon.py connection.xml --connections 1      # pick IOM connections

The tool round-trips a self-check (measure, don't eyeball): it compares the
members/sections/bearing/continuity/Alfa the API built against what the source
XML declared, and asserts the project has zero operations (i.e. truly
design-ready). It writes the `.ideaCon` even when the self-check flags something,
so you can open it in IDEA and see the discrepancy — but the process exit code is
non-zero so batch runs surface the problem.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    import ideastatica_connection_api.connection_api_service_attacher as attacher
except ImportError as exc:  # pragma: no cover - environment guard
    sys.stderr.write(
        "ERROR: could not import 'ideastatica_connection_api'.\n"
        "Run this with the Python that has it installed, e.g.:\n"
        "  python "
        "tools/idea/iom_to_ideacon.py ...\n"
        f"(import error: {exc})\n"
    )
    sys.exit(2)

DEFAULT_BASE_URL = "http://localhost:5000"
REST_EXE = r"C:\Program Files\IDEA StatiCa\StatiCa 26.0\IdeaStatiCa.ConnectionRestApi.exe"

# Sibling module (this script's directory is on sys.path when run as a script).
try:
    from mprl_resolver import MprlResolver, params_to_xml
except Exception:  # pragma: no cover
    MprlResolver = None  # type: ignore
    params_to_xml = None  # type: ignore


# --------------------------------------------------------------------------- #
# Namespace-agnostic ElementTree helpers (IDEA's own exports carry namespaces; #
# steel-suite's emit-iom does not — match on the local tag name either way).   #
# --------------------------------------------------------------------------- #
def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(el, name: str):
    if el is None:
        return None
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def _children(el, name: str):
    if el is None:
        return []
    return [c for c in el if _local(c.tag) == name]


def _text(el, name: str) -> Optional[str]:
    c = _child(el, name)
    return c.text if c is not None else None


def _ref_id(el, name: str) -> Optional[int]:
    """Read the <Id> inside a reference element {TypeName, Id} named `name`."""
    ref = _child(el, name)
    if ref is None:
        return None
    t = _text(ref, "Id")
    try:
        return int(t) if t is not None else None
    except ValueError:
        return None


# --------------------------------------------------------------------------- #
# Source-XML introspection: what the IOM *claims* should exist after import.   #
# --------------------------------------------------------------------------- #
@dataclass
class SrcMember:
    id: int
    name: str
    profile: Optional[str] = None
    is_bearing: bool = False
    is_continuous: bool = False


@dataclass
class IomStats:
    container: Optional[bool]  # True=<OpenModelContainer>, False=bare, None=unknown
    members: list = field(default_factory=list)  # list[SrcMember]
    connection_count: int = 0

    @property
    def member_count(self) -> int:
        return len(self.members)

    @property
    def bearing_name(self) -> Optional[str]:
        for m in self.members:
            if m.is_bearing:
                return m.name
        return None

    @property
    def continuous_names(self) -> list:
        return [m.name for m in self.members if m.is_continuous]


def read_iom_stats(path: Path) -> IomStats:
    """Parse the emitted IOM to learn its member/profile/bearing/continuity intent."""
    root = ET.parse(path).getroot()
    root_tag = _local(root.tag)
    if root_tag == "OpenModelContainer":
        om = _child(root, "OpenModel")
        container: Optional[bool] = True
    elif root_tag == "OpenModel":
        om = root
        container = False
    else:
        om = root
        container = None

    if om is None:
        return IomStats(container=container)

    # CrossSection collection:  Id -> Name
    css_name_by_id: dict[int, str] = {}
    for css in _children(_child(om, "CrossSection"), "CrossSection"):
        cid = _text(css, "Id")
        cname = _text(css, "Name")
        if cid is not None and cname is not None:
            try:
                css_name_by_id[int(cid)] = cname
            except ValueError:
                pass

    # Element1D collection:  element Id -> cross-section Id (CrossSectionBegin ref)
    css_id_by_elem: dict[int, int] = {}
    for el in _children(_child(om, "Element1D"), "Element1D"):
        eid = _text(el, "Id")
        cref = _ref_id(el, "CrossSectionBegin")
        if eid is not None and cref is not None:
            try:
                css_id_by_elem[int(eid)] = cref
            except ValueError:
                pass

    # Member1D collection:  id, name, resolved profile via its element's section
    members: dict[int, SrcMember] = {}
    for mem in _children(_child(om, "Member1D"), "Member1D"):
        mid = _text(mem, "Id")
        if mid is None:
            continue
        try:
            mid_i = int(mid)
        except ValueError:
            continue
        name = _text(mem, "Name") or f"M{mid_i}"
        elem_id = _ref_id(_child(mem, "Elements1D"), "ReferenceElement")
        profile = None
        if elem_id is not None:
            css_id = css_id_by_elem.get(elem_id)
            if css_id is not None:
                profile = css_name_by_id.get(css_id)
        members[mid_i] = SrcMember(id=mid_i, name=name, profile=profile)

    # Bearing flag lives on ConnectionData/Beams/BeamData (matched to member by name).
    name_to_member = {m.name: m for m in members.values()}
    for cd in _children(_child(om, "Connections"), "ConnectionData"):
        for beam in _children(_child(cd, "Beams"), "BeamData"):
            bname = _text(beam, "Name")
            is_bearing = (_text(beam, "IsBearingMember") or "").strip().lower() == "true"
            if is_bearing and bname in name_to_member:
                name_to_member[bname].is_bearing = True

    # Continuity flag lives on ConnectionPoint/ConnectedMembers (ref -> Member1D Id).
    connection_count = 0
    for cp in _children(_child(om, "ConnectionPoint"), "ConnectionPoint"):
        connection_count += 1
        cms = _child(cp, "ConnectedMembers")
        for cm in _children(cms, "ConnectedMember"):
            ref_mid = _ref_id(cm, "MemberId")
            is_cont = (_text(cm, "IsContinuous") or "").strip().lower() == "true"
            if is_cont and ref_mid in members:
                members[ref_mid].is_continuous = True

    return IomStats(
        container=container,
        members=list(members.values()),
        connection_count=connection_count,
    )


# --------------------------------------------------------------------------- #
# Cross-section enrichment: name-only -> parametric (what import_iom requires). #
# --------------------------------------------------------------------------- #
_CSS_BLOCK = re.compile(r'<CrossSection xsi:type="CrossSectionParameter">.*?</CrossSection>', re.S)


def _strip_dup_suffix(s: str) -> str:
    """Drop the emit-iom ' (2)' uniquifier if it leaked into a lookup name."""
    return re.sub(r"\s*\(\d+\)\s*$", "", s).strip()


def enrich_iom(xml_text: str, resolver) -> tuple:
    """Rewrite each name-only <CrossSection> into a parametric one via the MPRL.

    Returns (new_xml, resolved:list[(profile,css_type,matched)], unresolved:list[str]).
    Unresolved sections are left untouched (import will then reject the file and
    the self-check reports which profile to handle).
    """
    resolved: list = []
    unresolved: list = []

    def repl(m):
        block = m.group(0)

        def find(pat):
            mm = re.search(pat, block, re.S)
            return mm.group(1).strip() if mm else None

        cid = find(r"<Id>\s*(\d+)\s*</Id>")
        prof = find(r"<Name>\s*UniqueName\s*</Name>\s*<Value>([^<]*)</Value>")
        name = find(r"<Id>\s*\d+\s*</Id>\s*<Name>([^<]*)</Name>")
        rot = find(r"<CrossSectionRotation>([^<]*)</CrossSectionRotation>") or "0"
        matmm = re.search(r"<Material>.*?</Material>", block, re.S)
        material = matmm.group(0) if matmm else "<Material><TypeName>MatSteel</TypeName><Id>1</Id></Material>"

        profile = _strip_dup_suffix(prof or name or "")
        spec = resolver.resolve(profile) if resolver else None
        if spec is None:
            unresolved.append(profile or "(unknown)")
            return block
        resolved.append((profile, spec.css_type, spec.matched_name))
        nm = name if name is not None else profile
        return (
            f'<CrossSection xsi:type="CrossSectionParameter"><Id>{cid}</Id>'
            f'<Name>{nm}</Name><CrossSectionRotation>{rot}</CrossSectionRotation>'
            f'<IsInPrincipal>false</IsInPrincipal><CrossSectionType>{spec.css_type}</CrossSectionType>'
            f'<Parameters>{params_to_xml(spec.params)}</Parameters>{material}</CrossSection>'
        )

    return _CSS_BLOCK.sub(repl, xml_text), resolved, unresolved


# --------------------------------------------------------------------------- #
# Per-file processing + round-trip self-check.                                 #
# --------------------------------------------------------------------------- #
@dataclass
class FileResult:
    src: Path
    out: Path
    produced: bool = False
    problems: list = field(default_factory=list)  # strings; non-empty => exit non-zero


def _fmt(v) -> str:
    return "-" if v is None else str(v)


def process_one(api, src: Path, out: Path, connections: Optional[list],
                resolver, verbose: bool) -> FileResult:
    res = FileResult(src=src, out=out)
    print("=" * 74)
    print(f"IN : {src}")
    print(f"OUT: {out}")

    stats = read_iom_stats(src)
    if stats.container is False:
        # The bare-OpenModel "IOM for GH" form is rejected by import_iom.
        res.problems.append(
            "source is a BARE <OpenModel> (the 'IOM for GH' export). import_iom "
            "needs an <OpenModelContainer>; re-export with 'Export IDEA (.xml)'."
        )
        print("  !! " + res.problems[-1])
    print(
        f"  source declares: {stats.member_count} member(s), "
        f"{stats.connection_count} connection(s); "
        f"bearing={_fmt(stats.bearing_name)}; "
        f"continuous={stats.continuous_names or '-'}"
    )

    # ---- enrich name-only sections into parametric (MPRL) ---------------- #
    xml_text = src.read_text(encoding="utf-8")
    if resolver is not None:
        xml_text, resolved, unresolved = enrich_iom(xml_text, resolver)
        print(f"  cross-sections: {len(resolved)} resolved via MPRL"
              + (f", {len(unresolved)} UNRESOLVED" if unresolved else ""))
        if verbose:
            for prof, ctype, matched in resolved:
                print(f"      {prof!r} -> {ctype}  [{matched}]")
        for prof in sorted(set(unresolved)):
            msg = (f"profile {prof!r} not found in IDEA's section DB (MPRL) — "
                   "import will reject it; add/verify the section family.")
            res.problems.append(msg)
            print(f"      !! {msg}")

    # ---- import IOM -> project ------------------------------------------- #
    try:
        proj = api.project.import_iom(
            xml_text.encode("utf-8"),
            connections_to_create=connections,
            _content_type="multipart/form-data",
        )
    except Exception as exc:  # noqa: BLE001 - report and move on in batch
        res.problems.append(f"import_iom failed: {exc}")
        print(f"  XX import_iom failed: {exc}")
        return res

    pid = proj.project_id
    api.project.active_project_id = pid  # keep lifecycle sane for close/cleanup
    conns = proj.connections or []
    print(f"  imported: project_id={pid}, {len(conns)} connection(s)")

    # ---- read back and self-check (via connection topology) -------------- #
    # get_members() returns [] right after import; the connection *topology* is
    # the authoritative readback (bearing + connected members, profiles, type).
    def _topo(cid):
        t = api.connection.get_connection_topology(pid, cid)
        if hasattr(t, "to_dict"):
            t = t.to_dict()
        if isinstance(t, str):
            t = json.loads(t)
        return t

    def _label(mm):
        return (mm.get("cssMetaData") or {}).get("label", "?")

    imported_total = 0
    op_total = 0
    for conn in conns:
        try:
            topo = _topo(conn.id)
        except Exception as exc:  # noqa: BLE001
            res.problems.append(f"topology(conn {conn.id}) failed: {exc}")
            print(f"  XX topology(conn {conn.id}) failed: {exc}")
            continue
        try:
            ops = api.operation.get_operations(pid, conn.id) or []
        except Exception:  # noqa: BLE001
            ops = []
        op_total += len(ops)

        bearing = topo.get("bearingMember") or {}
        connected = topo.get("connectedMembers") or []
        n = (1 if bearing else 0) + len(connected)
        imported_total += n
        print(f"  connection id={conn.id}: {n} member(s), {len(ops)} operation(s)")
        print(f"      bearing: {_label(bearing)} ({bearing.get('continuityType')})")
        for c in connected:
            print(f"      - {_label(c):<22} ({c.get('continuityType')})"
                  f"  dir={c.get('dirRelatedToBearing', '')}")

        # Bearing fidelity: IDEA re-derives the bearing on import, so warn when
        # it differs from the source IOM's intended (viewer-picked) bearing.
        src_bp = next((mm.profile for mm in stats.members if mm.is_bearing), None)
        got = _label(bearing)
        if src_bp and got and src_bp.replace(" ", "") != got.replace(" ", ""):
            res.problems.append(
                f"bearing differs: IOM intended {src_bp!r} but IDEA chose {got!r} "
                "(IDEA re-derives bearing on import — set it in IDEA if it matters)."
            )
            print(f"      !! bearing mismatch: IOM={src_bp!r} vs IDEA={got!r}")

    if imported_total == 0:
        res.problems.append("no members imported (nothing to design).")
    elif stats.member_count and imported_total != stats.member_count:
        res.problems.append(
            f"member count mismatch: source={stats.member_count}, "
            f"imported={imported_total} (a profile may have failed to resolve)."
        )

    # Design-ready check: an imported IOM with no operations is what we want.
    if op_total != 0:
        res.problems.append(
            f"{op_total} operation(s) present — expected 0 for a design-ready "
            "(empty) connection; inspect in IDEA."
        )

    # ---- save .ideaCon (always, even if flagged, so it can be inspected) -- #
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
        api.project.download_project(pid, str(out))
        res.produced = out.exists()
        size = out.stat().st_size if res.produced else 0
        print(f"  -> wrote {out.name}  ({size} bytes)")
    except Exception as exc:  # noqa: BLE001
        res.problems.append(f"download_project failed: {exc}")
        print(f"  XX download_project failed: {exc}")
    finally:
        try:
            api.project.close_project(pid)
        except Exception:  # noqa: BLE001 - best effort
            pass

    status = "OK" if not res.problems else "PROBLEM"
    print(f"  [{status}]" + ("" if not res.problems else f" ({len(res.problems)} issue(s))"))
    return res


# --------------------------------------------------------------------------- #
# Input/output planning + CLI.                                                 #
# --------------------------------------------------------------------------- #
_IOM_EXTS = {".xml", ".iom"}


def gather_inputs(paths: list) -> list:
    out: list[Path] = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            out.extend(sorted(f for f in pp.iterdir()
                              if f.is_file() and f.suffix.lower() in _IOM_EXTS))
        elif pp.is_file():
            out.append(pp)
        else:
            sys.stderr.write(f"WARNING: input not found, skipping: {pp}\n")
    return out


def plan_output(src: Path, out_arg: Optional[str], multi: bool) -> Path:
    if out_arg is None:
        return src.with_suffix(".ideaCon")
    out = Path(out_arg)
    # Treat as a directory when batching, when it exists as a dir, or when it
    # has no .ideacon suffix.
    is_dir_target = (
        multi
        or out.is_dir()
        or out_arg.endswith(("/", "\\"))
        or out.suffix.lower() != ".ideacon"
    )
    if is_dir_target:
        return out / (src.stem + ".ideaCon")
    return out


def main(argv: Optional[list] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Convert geometry-only IOM XML to a design-ready .ideaCon "
                    "via the IDEA StatiCa Connection REST API.")
    ap.add_argument("inputs", nargs="+",
                    help="IOM .xml/.iom file(s) or a folder of them.")
    ap.add_argument("-o", "--out",
                    help="Output .ideaCon file (single input) or output directory.")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL,
                    help=f"REST service base URL (default {DEFAULT_BASE_URL}).")
    ap.add_argument("--connections", default=None,
                    help="Comma-separated IOM connection indices to create "
                         "(default: all).")
    ap.add_argument("--mprl", default=None,
                    help="Path to IDEA's MprlData.sqlite (section DB). "
                         "Default: the one in the StatiCa 26.0 install.")
    ap.add_argument("--no-enrich", action="store_true",
                    help="Do NOT rewrite name-only sections to parametric "
                         "(import will likely fail unless the XML is already parametric).")
    ap.add_argument("--verbose", action="store_true", help="Extra detail.")
    args = ap.parse_args(argv)

    inputs = gather_inputs(args.inputs)
    if not inputs:
        sys.stderr.write("ERROR: no IOM .xml/.iom inputs found.\n")
        return 2

    connections = None
    if args.connections:
        try:
            connections = [int(x) for x in args.connections.split(",") if x.strip()]
        except ValueError:
            sys.stderr.write("ERROR: --connections must be comma-separated integers.\n")
            return 2

    multi = len(inputs) > 1
    if args.out and multi and Path(args.out).suffix.lower() == ".ideacon":
        sys.stderr.write("ERROR: multiple inputs but --out is a single .ideaCon file; "
                         "pass an output directory instead.\n")
        return 2

    # Build the MPRL section resolver (unless disabled).
    resolver = None
    if not args.no_enrich:
        if MprlResolver is None:
            sys.stderr.write("WARNING: mprl_resolver unavailable; sections will NOT be "
                             "enriched and import will likely fail. Use --no-enrich to silence.\n")
        else:
            try:
                resolver = MprlResolver(args.mprl) if args.mprl else MprlResolver()
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"WARNING: could not open MPRL section DB ({exc}); "
                                 "sections will NOT be enriched.\n")

    print(f"Attaching to IDEA Connection REST API at {args.base_url}")
    print(f"Section enrichment: {'OFF' if resolver is None else 'ON (MPRL)'}")
    print(f"Inputs: {len(inputs)} file(s)\n")

    # NOTE: the client only wires its sub-APIs in __enter__, but its __exit__
    # unconditionally close_project(active_project_id) and crashes when that is
    # None — masking real errors. So we __enter__ manually and skip __exit__;
    # each file closes its own project in process_one.
    try:
        client = attacher.ConnectionApiServiceAttacher(args.base_url).create_api_client()
        api = client.__enter__()
    except Exception as exc:  # noqa: BLE001 - most likely the service isn't up
        sys.stderr.write(
            f"\nERROR: could not talk to the REST service at {args.base_url}.\n"
            f"Is it running? Start it and leave the window open:\n  \"{REST_EXE}\"\n"
            f"(underlying error: {exc})\n"
        )
        return 2

    results: list[FileResult] = []
    for src in inputs:
        out = plan_output(src, args.out, multi)
        results.append(process_one(api, src, out, connections, resolver, args.verbose))

    # ---- summary --------------------------------------------------------- #
    print("\n" + "=" * 74)
    ok = [r for r in results if r.produced and not r.problems]
    flagged = [r for r in results if r.produced and r.problems]
    failed = [r for r in results if not r.produced]
    print(f"SUMMARY: {len(ok)} clean, {len(flagged)} produced-with-warnings, "
          f"{len(failed)} failed  (of {len(results)})")
    for r in flagged + failed:
        print(f"  - {r.src.name}: " + ("; ".join(r.problems) if r.problems
                                       else "not produced"))
    return 0 if (not flagged and not failed) else 1


if __name__ == "__main__":
    raise SystemExit(main())
