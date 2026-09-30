/**
 * Gate check run on an IFC's bytes BEFORE it is handed to the fragments
 * importer: drop the body of any element whose geometry is a boolean chain too
 * deep for web-ifc to evaluate, and report what was dropped.
 *
 * WHY THIS EXISTS. web-ifc evaluates a nested `IfcBooleanResult` tree
 * sequentially, each step operating on the mesh the previous step produced. Cost
 * grows with the mesh, so a long chain does not get slowly slower — it stops
 * finishing. Measured on a large Revit 2025 export (57.9 MB):
 *
 *   - STEP parse of the whole file .................. 0.5 s
 *   - geometry for all 8642 elements ................ never completes (30 min+)
 *   - the same, minus ONE element ................... 1.4 s
 *
 * That one element is a slab whose Body is a `'CSG'` representation carrying a
 * chain of 119 `IfcBooleanResult` over 120 extrusions. The next-worst element in
 * the same file carries 12, and only two carry more than 10 — so this is not a
 * category or a file-size problem, it is a single pathological body. A comparable
 * model that opens fine contains 55 booleans in total.
 *
 * WHY IT IS A PRE-PASS AND NOT A LOADER OPTION. `IfcImporter` can exclude whole
 * CATEGORIES (`classes.elements` is a set of IFC type numbers) but has no
 * per-element hook, and a single web-ifc geometry call is synchronous — it never
 * yields, so it cannot be timed out from outside. Refusing the body before
 * conversion starts is the only thing that can prevent the stall rather than
 * merely report it.
 *
 * WHAT IT EDITS. As little as possible, so the transform stays auditable: the
 * offending `IfcShapeRepresentation` is removed from its owner's representation
 * list, and only if that empties the list is the product's `Representation`
 * slot nulled and the now-empty entity dropped. Sibling representations survive,
 * which matters — `Axis` is what the centerline resolver reads. The element
 * keeps its GlobalId, name and property sets and stays in the model tree; it
 * simply draws nothing. Orphaned geometry entities are left in place: nothing
 * references them, and web-ifc only ever evaluates geometry reachable from a
 * product.
 *
 * The caller must keep feeding the ORIGINAL bytes to the extractors (see
 * `ifc-sources.ts`) — this reduced copy is for the viewer's geometry only.
 */

/**
 * Booleans allowed in one representation before its body is refused.
 *
 * Evidence for the value is thin on purpose — one pathological element observed
 * (119) against a worst legitimate case of 12 in the same file. 40 sits an order
 * of magnitude clear of anything legitimate seen so far and a third of the way
 * below the one known failure, but it is a knob, not a constant: every drop is
 * reported so the number can be re-tuned against real files rather than guessed
 * at again.
 */
export const DEFAULT_BOOLEAN_BUDGET = 40;

/** One element whose body was refused, as reported to the user. */
export interface DroppedBody {
  /** Express id of the product (`#326561`), for looking it up in the file. */
  expressId: number;
  ifcType: string;
  globalId: string | null;
  name: string | null;
  /** Booleans in the refused representation — the reason it was refused. */
  booleanCount: number;
  /** True when the element lost every representation, not just this one. */
  lostAllGeometry: boolean;
}

export interface BooleanBudgetResult {
  /**
   * The bytes to convert. The SAME object as the input when nothing exceeded
   * the budget — identity is the guarantee that a file which already works is
   * not silently rewritten.
   */
  bytes: ArrayBuffer;
  dropped: DroppedBody[];
  scanMs: number;
}

/** Bytes -> string, byte-for-byte (`TextDecoder("latin1")` is windows-1252 and
 *  remaps 0x80–0x9F, which would not round-trip). */
function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return parts.join("");
}

/** The inverse of {@link decodeLatin1}. */
function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

interface EntityHit {
  id: number;
  type: string;
  /** Offsets into the source text: `[lineStart, lineEnd)`, newline excluded. */
  lineStart: number;
  lineEnd: number;
  /** Offset of the first character inside the entity's argument parentheses. */
  argStart: number;
}

/**
 * Walk every `#id=TYPE(...)` line once, slicing only the id and the type so a
 * multi-hundred-MB file is not turned into a million substrings.
 */
function forEachEntity(text: string, visit: (hit: EntityHit) => void): void {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let end = text.indexOf("\n", pos);
    if (end === -1) end = n;
    // Trailing \r on CRLF files must not become part of the last argument.
    const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    if (text.charCodeAt(pos) === 35 /* # */) {
      const eq = text.indexOf("=", pos);
      if (eq !== -1 && eq < lineEnd) {
        const paren = text.indexOf("(", eq);
        if (paren !== -1 && paren < lineEnd) {
          const id = Number(text.slice(pos + 1, eq));
          if (Number.isFinite(id)) {
            visit({ id, type: text.slice(eq + 1, paren), lineStart: pos, lineEnd, argStart: paren + 1 });
          }
        }
      }
    }
    pos = end + 1;
  }
}

/** Express ids referenced in a stretch of argument text, quotes excluded. */
function refsIn(text: string, from: number, to: number): number[] {
  const out: number[] = [];
  let inString = false;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === 39 /* ' */) {
      inString = !inString;
      continue;
    }
    if (inString || c !== 35 /* # */) continue;
    let j = i + 1;
    let value = 0;
    while (j < to) {
      const d = text.charCodeAt(j);
      if (d < 48 || d > 57) break;
      value = value * 10 + (d - 48);
      j++;
    }
    if (j > i + 1) out.push(value);
    i = j - 1;
  }
  return out;
}

/**
 * Split a STEP argument list into top-level arguments, respecting quoted
 * strings and nested aggregates.
 */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (inString) {
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") inString = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out;
}

const unquote = (arg: string): string | null =>
  arg.startsWith("'") && arg.endsWith("'") ? arg.slice(1, -1) : null;

const isBooleanType = (type: string) =>
  type === "IFCBOOLEANRESULT" || type === "IFCBOOLEANCLIPPINGRESULT";

/**
 * Refuse every representation whose boolean count exceeds `budget`.
 *
 * Pure and synchronous: bytes in, bytes out, no DOM and no importer — so it can
 * run wherever the conversion runs.
 */
export function applyBooleanBudget(
  input: ArrayBuffer,
  budget: number = DEFAULT_BOOLEAN_BUDGET,
): BooleanBudgetResult {
  const startedAt = Date.now();
  const text = decodeLatin1(new Uint8Array(input));

  // --- pass 1: the only three entity kinds this needs -----------------------
  // Booleans are what makes a body expensive; shape representations and product
  // definition shapes are the chain that leads from one back up to its element.
  const booleanOperands = new Map<number, number[]>();
  const shapeReps = new Map<number, { items: number[]; hit: EntityHit }>();
  const definitionShapes = new Map<number, { reps: number[]; hit: EntityHit }>();

  forEachEntity(text, (hit) => {
    if (isBooleanType(hit.type)) {
      booleanOperands.set(hit.id, refsIn(text, hit.argStart, hit.lineEnd));
    } else if (hit.type === "IFCSHAPEREPRESENTATION") {
      shapeReps.set(hit.id, { items: refsIn(text, hit.argStart, hit.lineEnd), hit });
    } else if (hit.type === "IFCPRODUCTDEFINITIONSHAPE") {
      definitionShapes.set(hit.id, { reps: refsIn(text, hit.argStart, hit.lineEnd), hit });
    }
  });

  if (booleanOperands.size === 0) {
    return { bytes: input, dropped: [], scanMs: Date.now() - startedAt };
  }

  // --- how many booleans does each boolean subtree contain? -----------------
  const subtreeCount = new Map<number, number>();
  const countBooleans = (id: number, seen: Set<number>): number => {
    const memo = subtreeCount.get(id);
    if (memo !== undefined) return memo;
    if (seen.has(id)) return 0; // malformed cycle — refuse to spin on it
    seen.add(id);
    let total = 1;
    for (const operand of booleanOperands.get(id) ?? []) {
      if (booleanOperands.has(operand)) total += countBooleans(operand, seen);
    }
    seen.delete(id);
    subtreeCount.set(id, total);
    return total;
  };
  for (const id of booleanOperands.keys()) countBooleans(id, new Set());

  // --- which shape representations blow the budget? -------------------------
  // Counted over the representation's own items so a representation holding
  // several separate boolean trees is judged on their total, the way web-ifc
  // will actually pay for it.
  const overBudget = new Map<number, number>(); // shapeRep id -> boolean count
  for (const [repId, rep] of shapeReps) {
    let total = 0;
    for (const item of rep.items) {
      if (booleanOperands.has(item)) total += subtreeCount.get(item) ?? 0;
    }
    if (total > budget) overBudget.set(repId, total);
  }

  if (overBudget.size === 0) {
    return { bytes: input, dropped: [], scanMs: Date.now() - startedAt };
  }

  // --- pass 2: which element owns each offending representation? ------------
  // Targeted rather than a full reverse index: there are only ever a handful of
  // these, so a native substring scan per id beats indexing 800k entities.
  const lineStartBefore = (offset: number) => text.lastIndexOf("\n", offset) + 1;

  /** Entities whose arguments reference `id` (excluding `id`'s own line). */
  const referrers = (id: number): EntityHit[] => {
    const needle = `#${id}`;
    const found: EntityHit[] = [];
    const seen = new Set<number>();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      const after = text.charCodeAt(at + needle.length);
      if (after >= 48 && after <= 57) continue; // #3265 inside #326561
      const start = lineStartBefore(at);
      if (start === at) continue; // the entity's own declaration
      if (text.charCodeAt(start) !== 35) continue;
      const eq = text.indexOf("=", start);
      const paren = text.indexOf("(", eq);
      let end = text.indexOf("\n", start);
      if (end === -1) end = text.length;
      const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
      if (eq === -1 || paren === -1 || paren > lineEnd) continue;
      const ownerId = Number(text.slice(start + 1, eq));
      if (!Number.isFinite(ownerId) || seen.has(ownerId)) continue;
      seen.add(ownerId);
      found.push({ id: ownerId, type: text.slice(eq + 1, paren), lineStart: start, lineEnd, argStart: paren + 1 });
    }
    return found;
  };

  /** Byte-range edits to apply, collected before anything is rewritten. */
  const edits: { start: number; end: number; text: string }[] = [];
  const dropped: DroppedBody[] = [];

  for (const [repId, booleanCount] of overBudget) {
    // rep -> product definition shape -> product
    const shapeOwners = referrers(repId).filter((r) => definitionShapes.has(r.id));
    for (const owner of shapeOwners) {
      const pds = definitionShapes.get(owner.id);
      if (!pds) continue;
      const remaining = pds.reps.filter((r) => r !== repId);
      const product = referrers(owner.id).find((r) => r.type.startsWith("IFC"));
      if (!product) continue;

      const productArgs = splitArgs(text.slice(product.argStart, product.lineEnd - 1));
      dropped.push({
        expressId: product.id,
        ifcType: product.type,
        // IfcRoot's first and third attributes, shared by every product.
        globalId: unquote(productArgs[0] ?? "") ?? null,
        name: unquote(productArgs[2] ?? "") ?? null,
        booleanCount,
        lostAllGeometry: remaining.length === 0,
      });

      if (remaining.length > 0) {
        // Sibling representations survive — only the offending one goes.
        const args = text.slice(owner.argStart, owner.lineEnd - 1);
        const rebuilt = splitArgs(args)
          .map((arg, i) =>
            i === 2 ? `(${remaining.map((r) => `#${r}`).join(",")})` : arg,
          )
          .join(",");
        edits.push({ start: owner.argStart, end: owner.lineEnd - 1, text: rebuilt });
      } else {
        // Nothing left to represent: null the product's Representation slot and
        // drop the now-empty definition shape rather than leave `()` behind.
        const productRebuilt = productArgs
          .map((arg, i) => (i === 6 && arg.trim() === `#${owner.id}` ? "$" : arg))
          .join(",");
        edits.push({ start: product.argStart, end: product.lineEnd - 1, text: productRebuilt });
        edits.push({ start: owner.lineStart, end: owner.lineEnd, text: "" });
      }
    }
  }

  if (edits.length === 0) {
    return { bytes: input, dropped: [], scanMs: Date.now() - startedAt };
  }

  // --- rewrite ---------------------------------------------------------------
  edits.sort((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // overlapping edits: first one wins
    pieces.push(text.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(text.slice(cursor));

  // A deleted line leaves its newline behind; harmless to STEP, but tidier gone.
  const rewritten = pieces.join("").replace(/\n\n+/g, "\n");
  const bytes = encodeLatin1(rewritten);

  return {
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    dropped,
    scanMs: Date.now() - startedAt,
  };
}
