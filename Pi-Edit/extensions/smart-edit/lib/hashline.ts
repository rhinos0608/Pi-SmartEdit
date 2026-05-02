/**
 * Hashline-anchored line hashing for zero-text-reproduction editing.
 *
 * Mirrors oh-my-pi's line-hash.ts (can1357/oh-my-pi).
 *
 * Key idea: each line of the file is tagged with a short, single-token
 * hash (LINE+ID, e.g. "42ab"). Edits reference anchors instead of
 * reproducing text. Hashes also serve as freshness checks — if the
 * file changed since the last read, hashes won't match and the edit
 * is rejected before any mutation.
 *
 * Design constraints:
 * - Deterministic: same line always produces same hash
 * - Fast: sub-μs per line (~1ms for 1000-line file)
 * - Single-token BPE: "42ab" must tokenize as 1 token in cl100k/o200k/Claude
 * - Stable: bigram table never changes (would invalidate saved anchors)
 * - Collision-rate target: < 20% for 100 distinct source lines
 *
 * The bigram table has 672 entries — every two-letter pair aa..zz
 * except 4 exclusions that are unnatural or BPE-unfriendly:
 *   - xz (x never precedes z in valid words)
 *   - zy (z never precedes y in valid words)
 *   - zz (end-of-token boundary marker in some BPE tokenizers)
 *   - qz (q never followed by z in any valid English/technical word)
 *
 * Order is stable forever.
 */

// ─── Bigram table ────────────────────────────────────────────────────────────

/**
 * 672 single-token BPE bigrams — every two-letter pair from aa..zz
 * except the 4 exclusions listed above.
 *
 * Confirmed by: 26×26 = 676 total bigrams, minus 4 excluded = 672.
 *
 * All entries tokenize as exactly 1 BPE token in cl100k/o200k/Claude vocab.
 * Order is stable forever — changing order would invalidate saved anchors.
 */
export const HASHLINE_BIGRAMS = [
  // aa..az (26)
  "aa","ab","ac","ad","ae","af","ag","ah","ai","aj","ak","al","am","an","ao",
  "ap","aq","ar","as","at","au","av","aw","ax","ay","az",
  // ba..bz (26)
  "ba","bb","bc","bd","be","bf","bg","bh","bi","bj","bk","bl","bm","bn","bo",
  "bp","bq","br","bs","bt","bu","bv","bw","bx","by","bz",
  // ca..cz (26)
  "ca","cb","cc","cd","ce","cf","cg","ch","ci","cj","ck","cl","cm","cn","co",
  "cp","cq","cr","cs","ct","cu","cv","cw","cx","cy","cz",
  // da..dz (26)
  "da","db","dc","dd","de","df","dg","dh","di","dj","dk","dl","dm","dn","do",
  "dp","dq","dr","ds","dt","du","dv","dw","dx","dy","dz",
  // ea..ez (26)
  "ea","eb","ec","ed","ee","ef","eg","eh","ei","ej","ek","el","em","en","eo",
  "ep","eq","er","es","et","eu","ev","ew","ex","ey","ez",
  // fa..fz (26)
  "fa","fb","fc","fd","fe","ff","fg","fh","fi","fj","fk","fl","fm","fn","fo",
  "fp","fq","fr","fs","ft","fu","fv","fw","fx","fy","fz",
  // ga..gz (26)
  "ga","gb","gc","gd","ge","gf","gg","gh","gi","gj","gk","gl","gm","gn","go",
  "gp","gq","gr","gs","gt","gu","gv","gw","gx","gy","gz",
  // ha..hz (26)
  "ha","hb","hc","hd","he","hf","hg","hh","hi","hj","hk","hl","hm","hn","ho",
  "hp","hq","hr","hs","ht","hu","hv","hw","hx","hy","hz",
  // ia..iz (26)
  "ia","ib","ic","id","ie","if","ig","ih","ii","ij","ik","il","im","in","io",
  "ip","iq","ir","is","it","iu","iv","iw","ix","iy","iz",
  // ja..jz (26)
  "ja","jb","jc","jd","je","jf","jg","jh","ji","jj","jk","jl","jm","jn","jo",
  "jp","jq","jr","js","jt","ju","jv","jw","jx","jy","jz",
  // ka..kz (26)
  "ka","kb","kc","kd","ke","kf","kg","kh","ki","kj","kk","kl","km","kn","ko",
  "kp","kq","kr","ks","kt","ku","kv","kw","kx","ky","kz",
  // la..lz (26)
  "la","lb","lc","ld","le","lf","lg","lh","li","lj","lk","ll","lm","ln","lo",
  "lp","lq","lr","ls","lt","lu","lv","lw","lx","ly","lz",
  // ma..mz (26)
  "ma","mb","mc","md","me","mf","mg","mh","mi","mj","mk","ml","mm","mn","mo",
  "mp","mq","mr","ms","mt","mu","mv","mw","mx","my","mz",
  // na..nz (26)
  "na","nb","nc","nd","ne","nf","ng","nh","ni","nj","nk","nl","nm","nn","no",
  "np","nq","nr","ns","nt","nu","nv","nw","nx","ny","nz",
  // oa..oz (26)
  "oa","ob","oc","od","oe","of","og","oh","oi","oj","ok","ol","om","on","oo",
  "op","oq","or","os","ot","ou","ov","ow","ox","oy","oz",
  // pa..pz (26)
  "pa","pb","pc","pd","pe","pf","pg","ph","pi","pj","pk","pl","pm","pn","po",
  "pp","pq","pr","ps","pt","pu","pv","pw","px","py","pz",
  // qa..qz (26, but qz excluded: q never followed by z in valid words)
  "qa","qb","qc","qd","qe","qf","qg","qh","qi","qj","qk","ql","qm","qn","qo",
  "qp","qq","qr","qs","qt","qu","qv","qw","qx","qy",
  // ra..rz (26)
  "ra","rb","rc","rd","re","rf","rg","rh","ri","rj","rk","rl","rm","rn","ro",
  "rp","rq","rr","rs","rt","ru","rv","rw","rx","ry","rz",
  // sa..sz (26)
  "sa","sb","sc","sd","se","sf","sg","sh","si","sj","sk","sl","sm","sn","so",
  "sp","sq","sr","ss","st","su","sv","sw","sx","sy","sz",
  // ta..tz (26)
  "ta","tb","tc","td","te","tf","tg","th","ti","tj","tk","tl","tm","tn","to",
  "tp","tq","tr","ts","tt","tu","tv","tw","tx","ty","tz",
  // ua..uz (26)
  "ua","ub","uc","ud","ue","uf","ug","uh","ui","uj","uk","ul","um","un","uo",
  "up","uq","ur","us","ut","uu","uv","uw","ux","uy","uz",
  // va..vz (26)
  "va","vb","vc","vd","ve","vf","vg","vh","vi","vj","vk","vl","vm","vn","vo",
  "vp","vq","vr","vs","vt","vu","vv","vw","vx","vy","vz",
  // wa..wz (26)
  "wa","wb","wc","wd","we","wf","wg","wh","wi","wj","wk","wl","wm","wn","wo",
  "wp","wq","wr","ws","wt","wu","wv","ww","wx","wy","wz",
  // xa..xz (26, but xz excluded: x never precedes z in valid words)
  "xa","xb","xc","xd","xe","xf","xg","xh","xi","xj","xk","xl","xm","xn","xo",
  "xp","xq","xr","xs","xt","xu","xv","xw","xx","xy",
  // ya..yz (26)
  "ya","yb","yc","yd","ye","yf","yg","yh","yi","yj","yk","yl","ym","yn","yo",
  "yp","yq","yr","ys","yt","yu","yv","yw","yx","yy","yz",
  // za..zy (26, but zy and zz excluded)
  "za","zb","zc","zd","ze","zf","zg","zh","zi","zj","zk","zl","zm","zn","zo",
  "zp","zq","zr","zs","zt","zu","zv","zw","zx",
] as const;

export const HASHLINE_BIGRAMS_COUNT = 672;
export const HASHLINE_CONTENT_SEPARATOR = "|";

/**
 * Regex that matches exactly the 647 bigram entries as an alternation.
 * Used for parsing and validation of LINE+ID anchors.
 */
export const HASHLINE_BIGRAM_RE_SRC =
  `(?:${HASHLINE_BIGRAMS.join("|")})`;

// ─── xxHash32 ───────────────────────────────────────────────────────────────

/**
 * Lazy-init wrapper for xxHash32.
 *
 * Uses Bun's built-in if available (zero overhead), otherwise falls back
 * to xxhash-wasm (~10KB, ~2 GB/s). The WASM path is still sub-ms for
 * typical source files (1000 lines × ~100 chars = 100KB → ~0.05ms).
 */
let _xxhash32: ((input: string, seed?: number) => number) | null = null;
let _initPromise: Promise<void> | null = null;

async function ensureXXHash32(): Promise<(input: string, seed?: number) => number> {
  if (_xxhash32) return _xxhash32;
  if (_initPromise) {
    await _initPromise;
    return _xxhash32!;
  }

  _initPromise = (async () => {
    // xxhash-wasm is reliable across Bun, Node.js, and other runtimes.
    // Bun's native Bun.hash() appears to be a stub in some versions (returns
    // constant values regardless of input/seed), so we always use xxhash-wasm
    // for correctness. xxhash-wasm is fast enough (~2 GB/s, <0.1ms for 10KB).
    const xxhashModule = (await import("xxhash-wasm")) as {
      default: () => Promise<{
        h32: (input: string, seed?: number) => number;
        h32ToString: (input: string, seed?: number) => string;
        create32: (seed?: number) => { update: (data: string) => { digest: () => number } };
        h64: (input: string, seed?: bigint) => bigint;
        h64ToString: (input: string, seed?: bigint) => string;
        create64: (seed?: bigint) => { update: (data: string) => { digest: () => bigint } };
      }>;
    };
    const xxhash = await xxhashModule.default();
    _xxhash32 = (input: string, seed = 0) => xxhash.h32(input, seed);
  })();

  await _initPromise;
  return _xxhash32!;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if c is a letter or digit (Unicode-aware, fast ASCII path).
 */
function hasSignificantChar(line: string): boolean {
  // Fast path: ASCII check (covers 99.9% of source code)
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (
      (c >= 48 && c <= 57)  // 0-9
      || (c >= 65 && c <= 90)  // A-Z
      || (c >= 97 && c <= 122) // a-z
    ) {
      return true;
    }
    // Unicode letter check for non-ASCII (rare in code, but handle it)
    if (
      (c >= 0x80 && (
        // Unicode categories: Lu, Ll, Lt, Lm, Lo (letters), Nd (digit numbers)
        (c >= 0x100 && c <= 0x217F) || // Latin Extended-A and beyond
        (c >= 0x3040 && c <= 0x9FFF) || // CJK
        (c >= 0xAC00 && c <= 0xD7AF)    // Korean Hangul
      ))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if line contains only whitespace and braces ({ }).
 * These are the "structural" lines — empty blocks, separators, etc.
 */
function isStructural(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (
      c !== 32   // space
      && c !== 9  // tab
      && c !== 123 // {
      && c !== 125 // }
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Ordinal bigram for structural lines.
 * 11-13 always get "th" (11th, 12th, 13th have special English forms).
 * Otherwise: 1→st, 2→nd, 3→rd, else→th.
 */
function structuralBigram(lineNumber: number): string {
  const mod100 = lineNumber % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (lineNumber % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a single-token BPE bigram hash for a single line of source.
 *
 * Algorithm:
 * 1. Strip \r, trim trailing whitespace
 * 2. If line contains only whitespace and {/} → return ordinal suffix bigram
 *    (e.g., line 1 → "1st", line 2 → "2nd"). This costs 0 additional tokens.
 * 3. Set seed=0; if line has no alphanumeric chars → seed=lineNumber
 *    (prevents hash collisions on separator/comment lines that lack content)
 * 4. hash = xxHash32(line, seed) % HASHLINE_BIGRAMS_COUNT (672)
 *    Note: Expanded from spec's original 647 to reduce collision rate.
 *
 * @param lineNumber 1-based line number (used for structural bigrams and seed)
 * @param line       The line content (NO trailing newline)
 */
export async function computeLineHash(
  lineNumber: number,
  line: string,
): Promise<string> {
  // Step 1: normalize
  const normalized = line.replace(/\r/g, "").trimEnd();

  // Step 2: structural lines → ordinal bigram
  if (isStructural(normalized)) {
    return structuralBigram(lineNumber);
  }

  // Step 3: compute hash
  const hasher = await ensureXXHash32();

  let seed = 0;
  if (!hasSignificantChar(normalized)) {
    // No alphanumeric chars (pure separator/comment line).
    // Seed by line number to prevent collision with another
    // separator line elsewhere in the file.
    seed = lineNumber;
  }

  const hash = hasher(normalized, seed) % HASHLINE_BIGRAMS_COUNT;
  return HASHLINE_BIGRAMS[hash];
}

/**
 * Synchronous version of computeLineHash.
 * Requires xxHash32 to have been initialized already (call ensureXXHash32 first
 * if unsure). Throws if not yet initialized.
 */
export function computeLineHashSync(
  lineNumber: number,
  line: string,
): string {
  if (!_xxhash32) {
    throw new Error(
      "xxHash32 not initialized. Call computeLineHash() once (async init) " +
      "or ensureXXHash32() before using the sync variant."
    );
  }

  const normalized = line.replace(/\r/g, "").trimEnd();

  if (isStructural(normalized)) {
    return structuralBigram(lineNumber);
  }

  let seed = 0;
  if (!hasSignificantChar(normalized)) {
    seed = lineNumber;
  }

  const hash = _xxhash32(normalized, seed) % HASHLINE_BIGRAMS_COUNT;
  return HASHLINE_BIGRAMS[hash];
}

/**
 * Format a LINE+ID anchor string (e.g., "42ab").
 * Shorthand for `${lineNumber}${computeLineHash(lineNumber, text)}`.
 */
export function formatLineHash(lineNumber: number, text: string): string {
  // Synchronous — requires initHashline() or computeLineHash() to have been
  // called first so that the xxHash32 WASM module is loaded.
  return `${lineNumber}${computeLineHashSync(lineNumber, text)}`;
}

/**
 * Format a full hashline: "42ab|function hello() {"
 * Combines anchor + separator + line content.
 */
export function formatHashLine(lineNumber: number, line: string): string {
  return `${lineNumber}${computeLineHashSync(lineNumber, line)}${HASHLINE_CONTENT_SEPARATOR}${line}`;
}

/**
 * Pre-initialize xxHash32. Call this at startup to avoid async cost on first hash.
 * Idempotent — multiple calls are fine.
 */
export async function initHashline(): Promise<void> {
  await ensureXXHash32();
}

/**
 * Build anchor map + formatted lines for a full file.
 *
 * @param lines Array of lines (no trailing newlines)
 * @returns anchor map + formatted lines
 */
export async function buildHashlineAnchors(
  lines: string[],
): Promise<{
  anchors: Map<string, { text: string; line: number }>;
  formattedLines: string[];
}> {
  const anchors = new Map<string, { text: string; line: number }>();
  const formattedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const text = lines[i];
    const hash = await computeLineHash(lineNum, text);
    const anchor = `${lineNum}${hash}`;
    anchors.set(anchor, { text, line: lineNum });
    formattedLines.push(`${anchor}${HASHLINE_CONTENT_SEPARATOR}${text}`);
  }

  return { anchors, formattedLines };
}