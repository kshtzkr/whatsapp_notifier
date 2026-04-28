# Graphify this repository

[Graphify](https://github.com/sponsors/safishamsi) turns a folder of code and docs into a **persistent knowledge graph**: entities, relationships (tagged as extracted vs inferred), community clusters, and browsable outputs. Use it when you want a map of `whatsapp_notifier` before refactoring, onboarding, or tracing how bulk delivery, providers, and Rails integration connect.

This document describes how to run the pipeline **from the gem root** (`whatsapp_notifier/`). It mirrors the `/graphify` agent workflow; you can also run the same steps in a terminal.

## Prerequisites

- **Python 3** with pip
- Install the package (the CLI may be published as `graphifyy`):

  ```bash
  python3 -m pip install graphifyy
  ```

- Optional: `graphify` on your `PATH` (the installer may expose it). If missing, use `python3 -m` forms below.

## What gets indexed here

Reasonable targets for this repo:

| Path | Role |
|------|------|
| `.` (repo root) | Full corpus: `lib/`, `spec/`, `docs/`, `examples/` |
| `lib/whatsapp_notifier` | Core implementation only (smaller graph) |
| `docs/` | Policy and setup prose only |

Ruby (`.rb`) is treated as **code** (AST + optional semantic extraction). Markdown under `docs/` is **documents**.

## One-shot run (full pipeline)

From the repository root:

1. **Ensure graphify is importable** and record the interpreter (so later steps use the same venv):

   ```bash
   mkdir -p graphify-out
   python3 -c "import graphify" 2>/dev/null || python3 -m pip install graphifyy -q
   python3 -c "import sys; open('graphify-out/.graphify_python', 'w').write(sys.executable)"
   ```

2. **Detect files** (writes `graphify-out/.graphify_detect.json`; inspect with a JSON viewer or small script if you need counts).

3. **Extract**  
   - **Code:** AST extraction over Ruby files (imports/calls structure).  
   - **Docs / non-code:** semantic extraction (LLM) unless the corpus is code-only.  
   For large corpora, graphify supports **caching** and **chunked** extraction; see upstream docs.

4. **Build graph, cluster, report** — produces the main artifacts below.

5. **Label communities** — short human names per cluster, then regenerate the report.

6. **HTML** — interactive `graphify-out/graph.html` (skipped or warned if the graph is huge).

7. **Cleanup** — some intermediate JSON files may be removed at the end of a full run; **`graph.json`**, **`GRAPH_REPORT.md`**, and **`graph.html`** are the durable outputs.

Use the interpreter pinned in `graphify-out/.graphify_python` for all `python -c "…"` snippets so a venv and the CLI stay consistent:

```bash
PY="$(cat graphify-out/.graphify_python)"
"$PY" -c "import graphify; print('ok')"
```

## Outputs (under `graphify-out/`)

After a successful run you should have:

| Output | Purpose |
|--------|---------|
| `graph.html` | Interactive graph in a browser (no server) |
| `GRAPH_REPORT.md` | Audit-style report: god nodes, surprising links, suggested questions, token usage |
| `graph.json` | GraphRAG-style structured graph for tools or custom queries |
| `cost.json` | Cumulative token accounting across runs (if enabled by your graphify version) |

Optional flags (when using the full `/graphify` agent or CLI with the same options):

- `--no-viz` — report + JSON only  
- `--obsidian` / `--obsidian-dir` — Obsidian vault + canvas  
- `--update` — incremental re-extraction for changed files only  
- `--directed` — preserve edge direction in the graph  
- `--svg` / `--graphml` / `--neo4j` — extra export formats  

## Queries after the graph exists

With `graphify-out/graph.json` present, you can:

- **Broad context:** BFS-style “what is X connected to?”  
- **Paths:** shortest path between two labeled concepts  
- **Explain:** neighborhood of one node  

The graphify CLI or agent subcommands (`query`, `path`, `explain`) operate on that file; answers should cite graph edges and confidence tags, not invent links.

## Large repo warning

If detection reports **very high** file or word counts, run graphify on a **subfolder** (for example `lib/whatsapp_notifier` only) first. That keeps HTML visualization and clustering responsive.

## CI and secrets

Do **not** commit API keys or production phone numbers into the corpus before indexing. This gem’s **specs and examples** should use placeholders; scrub any local overrides before running graphify on a copy of the tree if you use real data in dev.

## Related project docs

- [Rails setup](rails_setup.md) — initializer and Active Job wiring  
- [Bulk messaging policy](bulk_messaging_policy.md) — rate limits and guardrails  

---

*Workflow reference: Cursor `/graphify` skill (graph detection → AST + semantic merge → cluster → report → HTML). For the canonical flag list and agent-only steps (parallel semantic chunks, Whisper for video), use the skill or upstream graphify documentation.*
