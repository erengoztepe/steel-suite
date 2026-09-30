#!/usr/bin/env bash
# Regenerate every reference connection end-to-end and audit the result.
#
# This is the regression net: each connection is an independent generalization test (a new
# input mostly reveals which of our "rules" was really just a house-style parameter), so all
# of them must be re-checked on every change -- not just the one being worked on.
#
# The connection fixtures are LOCAL ONLY: they live in the git-ignored fixtures/ folder (an IOM
# .xml plus its same-named .ifc), with golden snapshots in the git-ignored tests/golden/.
# Missing fixtures are skipped, not failed, so a fresh clone runs clean.
set -uo pipefail
cd "$(dirname "$0")/.."

# name | IOM path
CASES=(
  "fin_plate|fixtures/fin_plate.iom.xml"
  "end_plate|fixtures/end_plate.xml"
)

fail=0
ran=0
for case in "${CASES[@]}"; do
  name="${case%%|*}"; iom="${case##*|}"
  if [ ! -f "$iom" ]; then printf '\n=== %s === SKIPPED (no local fixture %s)\n' "$name" "$iom"; continue; fi
  ran=$((ran + 1))
  spec="apps/drawgen/out/spec_${name}.json"
  dxf="output/${name}.dxf"
  printf '\n=== %s ===\n' "$name"
  # Run build.ts from its own workspace so `npx tsx` resolves there; the IOM and spec paths
  # are passed relative to the repo root, hence the ../.. hop back out.
  ( cd apps/drawgen && npx tsx src/drawing/build.ts "../../${iom}" "../../${spec}" ) >/dev/null \
    || { echo "BUILD FAILED"; fail=1; continue; }
  python server/render.py "$spec" "$dxf" >/dev/null || { echo "RENDER FAILED"; fail=1; continue; }
  python tools/verify_drawing.py "$dxf" "$spec" --golden "tests/golden/${name}.json" | tail -n 20
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail=1
done

printf '\n'
if [ "$ran" -eq 0 ]; then echo "NO LOCAL FIXTURES -- nothing checked (see fixtures/)"; exit 0; fi
if [ "$fail" -eq 0 ]; then echo "ALL CASES PASS"; else echo "SOME CASES FAILED"; fi
exit "$fail"
