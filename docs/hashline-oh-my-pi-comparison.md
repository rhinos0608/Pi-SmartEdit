# SmartEdit vs oh-my-pi hashline design

Fresh reference: `can1357/oh-my-pi` at commit `4a7b586821a4df0afcea657717247f6ec9db8f88` (2026-09-24). The original comparison was against `b6b3430b38f620394f209b998bbbce04a32580b8`; the 2026-09-25 audit below rechecked the current implementation module by module.

This comparison intentionally treats SmartEdit's planner, workspace-evidence authority,
and transaction kernel as architectural constraints. Ideas are imported only where
they improve the existing structured hashline protocol without duplicating those layers.

| Concern | oh-my-pi | SmartEdit | Decision |
| --- | --- | --- | --- |
| Agent schema | Hashline mode is a separate one-field `{input}` schema | One union schema advertised old/new, raw, target, refactor, and hashline together | **Adopt principle:** hashline mode now advertises a separate hashline-only schema and rejects alternate dialects at runtime. |
| Model prompt | Full and compact hashline prompts with concrete syntax, invariants, and examples | Hashline semantics were mostly implicit in field names and generic tool guidance | **Adopt:** explicit complete-anchor, replacement-content, deletion, pre-edit-anchor, reread, and visible-line guidance in the tool/schema contract. |
| Delete semantics | Deletion is an explicit `CUT`, not an empty `PUT` | Missing hashline content previously normalized to deletion | **Adapt:** structured protocol keeps `content: null`, but hashline-only mode requires the field so deletion is explicit. |
| Gap insertion | `<N` / `>N` gap locators insert without re-emitting keeper lines | Engine already supported `:before` / `:after` anchors, but the agent schema did not teach them | **Adopt principle using existing machinery:** hashline-only schema now documents `LINE+ID:before/after` and validates the unsuffixed base anchor in `end`. |
| File freshness identity | Four-hex whole-file snapshot tag in each section | Per-line LINE+ID hashes plus workspace evidence SHA/range authority | **Keep SmartEdit:** adding file tags would duplicate existing freshness/evidence state. |
| Seen-line enforcement | Snapshot store records lines actually displayed; unseen/elided anchors are rejected | Prior-authority store already accumulates exact strong read ranges for unchanged content | **Keep/reuse SmartEdit:** prompt now states the rule; authorization remains in the existing evidence system. |
| Anchor addressing | Original line numbers under a file snapshot tag | Complete LINE+ID anchors | **Keep SmartEdit:** line hashes provide local identity and fit SmartRead output. |
| Block addressing | `N*` syntax resolved by a block resolver | Optional AST symbol hint scopes stale-anchor fallback | **Keep SmartEdit:** importing block DSL would duplicate AST targeting. |
| Parser/tokenizer | Custom PUT/CUT/MV/REM grammar and streaming parser | Structured JSON edit items validated by canonical contract | **Do not import:** provider-visible JSON already fits Pi and SmartEdit. |
| Stale recovery | Retained snapshot chain; recover only when a unique safe mapping and surrounding/syntax context are proven | Direct hash check → retained-read token provenance → snapshot-proven uniform drift with neighbouring context → AST-scoped/full fallback using snapshot-reconstructed old text | **Adopted and adapted:** the unsafe short-hash ±5 mutation path is gone. Recovery now carries proof from the retained read; unproven drift fails closed. |
| Apply ordering | Original-coordinate sections are staged, coalesced, then committed atomically | Hashline edits resolve against immutable content, overlap-check, then apply descending; patch kernel commits transactions | **Equivalent principle already present.** |
| Multi-file edits | Session patcher stages sections and commits as a transaction | Patch transaction kernel groups files and commits atomically | **Keep SmartEdit:** fixed xxHash initialization at the async hashline boundary instead of adding another store. |
| Clipboard/moves | CUT registers can move blocks across files | Dedicated `transfer` tool owns preserve/relocate semantics | **Do not import:** registers would overlap transfer's responsibility. |
| No-op loops | Session store counts repeated identical no-ops and escalates | Shared session mutation guard now tracks byte-identical no-op requests across edit and transfer | **Adopted:** two identical no-op results are tolerated; the third identical request is rejected before mutation and any real applied mutation clears the strikes. |
| Model-specific prompt density | Catalog can select compact/full prompt | No model catalog policy in this extension | **Do not force-fit:** keep one concise tool description plus schema descriptions. |
| Observability | Metaharness records hashline op subtypes and failures | Hashline fallback metrics and structured mutation diagnostics exist in-process | **Keep SmartEdit instrumentation:** recovery/failure modes remain observable without importing OMP's metaharness. |

## Mechanical fixes made during comparison

1. `applyHashlinePath()` now initializes xxhash explicitly before synchronous
   validation/rebase code. Multi-file staging no longer depends on an earlier read
   accidentally warming the WASM hasher.
2. Removed the stray `mf:` label in `computeLineHashSync`.
3. Hashline schema descriptions now define complete LINE+ID anchors and
   `hashline.content` as replacement content.
4. Hashline-only mode requires explicit `hashline.content`; `null` is deletion.
5. Existing `:before` / `:after` gap insertion is part of the advertised hashline-only protocol, with runtime validation for its base anchor.
6. `hashline-recovery.ts` authenticates model-authored LINE+ID tokens against the retained read snapshot and accepts stale-anchor relocation only when one uniform shift is proven by byte-identical target lines plus observed neighbouring context.
7. Model-facing mismatch guidance requires a re-read and explicitly warns against splicing a line number from one read row with a hash suffix from another.
8. The `transfer` tool no longer relocates stale source/destination anchors by short hash. Because transfer already runs behind evidence/transaction freshness and has no independent recovery snapshot, stale transfer anchors fail closed.
9. Legacy `tryRebaseAnchor`/`tryRebaseAll` remain only as low-level compatibility/test helpers and are documented as non-authoritative for mutations.
10. The SmartRead tool-result seam separates raw file bytes from rendered presentation. Freshness/fallback snapshots store raw bytes, while provenance parses only exact `LINE+ID|text` rows actually displayed inside the `@path`/PINE envelope, preventing rendered wrappers from becoming recovery authority.
11. A read→cache→planner regression using the real PINE envelope shape plus a partial-read test proves unseen rows do not acquire hashline provenance.
12. Snapshot-proven stale-anchor recovery has a language-aware structural veto. When a full retained snapshot and tree-sitter grammar are available, SmartEdit compares the enclosing symbol ancestry of the observed and recovered spans. A candidate that moved into a different function/class context is rejected before any fuzzy fallback; plain-text/top-level files keep the existing textual proof path.
13. One session-owned repeated-no-op guard is shared by `edit` and `transfer`. The first two byte-identical no-op results are tolerated, the second warns, and the third identical request is rejected before entering the mutation pipeline. Any real applied mutation clears the strikes, so this is loop suppression rather than a permanent request blacklist.

## 2026-09-25 fresh module-by-module audit

This pass re-read current oh-my-pi at `4a7b586821a4df0afcea657717247f6ec9db8f88`,
including the Rust hashline engine and the current coding-agent/read docs. The useful
change upstream since the original comparison is not a new wire syntax; it is a much
stronger recovery proof. Current OMP maps unchanged lines from a retained snapshot,
requires coherent drift for the edit, validates surrounding context, and rejects
recovery into a structurally different duplicate construct.

| Current OMP module / surface | SmartEdit counterpart | Fresh decision |
| --- | --- | --- |
| `input.rs` / `parser.rs` | `edit-contract.ts`, `hashline-content.ts`, `hashline-anchor.ts` | Keep SmartEdit JSON. OMP's section grammar is compact, but a second parser/DSL would add model syntax and duplicate the existing typed contract. |
| `apply.rs` | `hashline-apply.ts` + `core/edit-planner.ts` | Keep. Both resolve original coordinates and reject overlapping mutations before commit. SmartEdit's shared planner is the better integration point for mixed capability batches. |
| `snapshots.rs` + read `[PATH#TAG]` headers | `context/read-cache.ts` + workspace evidence authority | Keep SmartEdit authority split. A second whole-file tag would duplicate SHA/range freshness already carried by workspace evidence. Retained read snapshots are still valuable as recovery evidence, not as a new public token. |
| `patcher.rs` prepare/commit | `mutation/kernel.ts`, transaction/journal, edit planner | Already stronger/integrated. SmartEdit's shared mutation kernel owns rollback, crash recovery, verification, evidence invalidation, and multi-file atomicity. |
| `recovery.rs` line mapping + context preservation | new `hashline-recovery.ts` | Import the principle. SmartEdit now requires token provenance, one uniform displacement, exact target text, observed neighbouring context, and one unique candidate. |
| syntax-context guard in current recovery | text-neighbour proof + existing tree-sitter enclosing-symbol resolver | Imported as an additive veto. Snapshot-proven textual recovery still establishes the candidate; when a full parseable snapshot exists, the recovered span must preserve its enclosing symbol fingerprint or recovery fails closed and requires a re-read. |
| seen-line enforcement | `evidence-authority.ts` + retained read token provenance | Keep SmartEdit. Evidence controls whether the model had authority to mutate a span; provenance separately proves the exact LINE+ID token was emitted by that read. |
| `messages.rs` mismatch/recovery diagnostics | `hashline-validate.ts` + schema descriptions | Import retry ergonomics. Rejection now tells the model to re-read and copy a complete token, never synthesize a repaired LINE+ID. |
| no-op loop guard | shared `MutationLoopGuard` in session orchestration | Imported at the shared layer rather than the hashline matcher. Edit (normal/hashline/refactor) and transfer share one session guard; two identical no-ops are allowed, the third is blocked, and successful mutation resets the ledger. |
| CUT/PASTE/MV registers | first-class `transfer` tool | Keep SmartEdit separation. Transfer preserves observed source text without teaching the edit tool another mini-language. Its anchors are now exact-only unless a future transfer-specific recovery proof is added. |
| compact/full model-specific prompt selection | one concise hashline schema/prompt | Defer model catalog policy. Only repeated malformed-call patterns should justify a model-specific prompt fork; protocol semantics should remain identical. |
| streaming preview | SmartEdit staging/diff surfaces | No architecture import. SmartEdit already computes staged changes through the shared planner and verifier lifecycle; OMP's streaming parser is coupled to its text DSL. |

### Architectural conclusions

The protocol now treats the short hash as a **freshness check**, not an identity proof.
Identity comes from the retained read: an authored LINE+ID must have existed verbatim in
that snapshot. Recovery is then a proof that the observed text moved coherently, rather
than a search for a nearby suffix that happens to match. This closes the mixed LINE+ID
corruption class where a line number and hash suffix originate from different rows.

The layers are deliberately separate:

1. **Workspace evidence** answers whether the model observed/owns the mutation span.
2. **Hashline snapshot provenance** answers whether the exact model-authored token was
   actually emitted by the read.
3. **Recovery proof** answers whether stale observed text moved to one uniquely
   corroborated location.
4. **Planner + mutation kernel** own overlap checks, atomicity, rollback, verification,
   evidence invalidation, and finalization.

That split avoids making hashline recovery a second authorization system. It also means a
malformed token fails before fuzzy matching can reinterpret it, while a real token whose
content moved locally can still use the existing AST-scoped/full fallback after direct
snapshot-proven relocation fails.

### Remaining idea not imported

- **Adaptive compact prompts.** OMP has model-specific compact guidance. SmartEdit should
  only add this if repeated malformed-call patterns show prompt volume is the cause; a
  schema semantic fork would be the wrong fix.
