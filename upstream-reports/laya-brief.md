> **Provenance:** this brief was written for a `decide-guard.ts` integration that has since been
> **deleted** (2026-09-22) together with its Laya backend. It is kept as standalone research on Laya
> itself — `.laya/README.md` carries the rebuild recipe and the gotchas that matter in practice.

# Laya on Linux x86_64, CPU-only — sourced brief

**Target:** `laya` 0.3.5 (Convai Innovations) as a replacement for LLM calls on cheap typed judgements
(`choice` / `score` / `noul` + routing), Python 3.14.7, torch 2.14, no GPU.

**Primary sources read** (every claim below cites one of these):

| Tag | Source |
|---|---|
| PYPIMETA | https://pypi.org/pypi/laya/json |
| PYPI | https://pypi.org/project/laya/ |
| GH | https://github.com/NandhaKishorM/laya (README.md) |
| SRC:file | `laya/*.py` at main `573e5b62` = released 0.3.5 (https://github.com/NandhaKishorM/laya/tree/main/laya) |
| CI | https://github.com/NandhaKishorM/laya/blob/main/.github/workflows/ci.yml |
| HF | https://huggingface.co/convaiinnovations/laya (model card) |
| HFCFG | https://huggingface.co/convaiinnovations/laya/raw/main/rl_agent_config.json (+ `multilingual/`, `typed-decisions/`, and the standalone repos) |
| HFAPI | https://huggingface.co/api/models/convaiinnovations/laya?blobs=true |
| HFENV | https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables |
| SWEEP | https://github.com/NandhaKishorM/laya/blob/main/research/results/cpu_51_language_sweep.json |
| ISS:n | https://github.com/NandhaKishorM/laya/issues/n |

Repo main == PyPI 0.3.5 (`573e5b62`, 2026-09-21); the working tree I read is byte-identical to the published release, and there is no `laya/cli.py`, `laya/__main__.py`, or `laya/serve.py` on main.

**Verdict in one line:** installs and runs CPU-only on py3.14 with no wheel gaps, but there is **no ready-made bridge of any kind**, the `noul` primitive is currently unreliable on the shipped weights, and `laya-multilingual` crashes on every `noul` question.

---

## 1. INSTALL

```bash
python3.14 -m venv .venv-laya
. .venv-laya/bin/activate
python -m pip install --upgrade pip

# CPU-only torch FIRST and explicitly — this is the upstream CI recipe (CI → high)
pip install torch --index-url https://download.pytorch.org/whl/cpu

# then the package; torch is already satisfied so no CUDA wheel is pulled
pip install laya

# verify (USE_TF=0 — see §4)
USE_TF=0 python -c "import laya,torch,transformers;print(laya.__version__,torch.__version__,transformers.__version__)"
```

- CPU-only torch wheel install recipe (`pip install torch --index-url https://download.pytorch.org/whl/cpu`) → CI → **high**
- `torch-2.14.0+cpu-cp314-cp314-manylinux_2_28_x86_64.whl` exists on that index; `content-length: 196260719` (~196 MB, vs ~900 MB+ for the default PyPI CUDA-bundled linux wheel) → https://download.pytorch.org/whl/cpu/torch/ → **high**
- `requires_python >=3.10`, deps `torch>=2.0.0 transformers>=4.48.0 safetensors>=0.4.0 huggingface_hub>=0.20.0 numpy>=1.20.0` → PYPIMETA → **high**
- Classifiers list Python 3.10–3.13 only — **3.14 is not among them**, and CI tests 3.10/3.11/3.13 only (3.12 and 3.14 untested upstream) → PYPIMETA, CI → **high**

### Python 3.14 / torch 2.14 / numpy ABI — checked per wheel, no gaps on x86_64

| Package | Version pip resolves today | 3.14 x86_64 wheel | Confidence |
|---|---|---|---|
| torch | 2.14.0 (+cpu on the cpu index) | `cp314-cp314-manylinux_2_28_x86_64` ✅ | high (PyPI JSON + cpu index listing) |
| numpy | 2.5.3 | `cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64` ✅ | high (PyPI JSON) |
| tokenizers | 0.23.2 | `cp310-abi3-manylinux_2_17_x86_64` (abi3 ⇒ forward-compatible) ✅ | high (PyPI JSON) |
| safetensors | 0.8.0 | `cp310-abi3-manylinux_2_17_x86_64` ✅ | high (PyPI JSON) |
| transformers | 5.17.0 | pure-python `py3-none-any`; classifiers include 3.14 ✅ | high (PyPI JSON) |
| huggingface_hub | 1.32.0 | pure-python; classifiers include 3.14 ✅ | high (PyPI JSON) |

So no missing-wheel risk on your stack — **but three real caveats**:

1. **The py3.14 breakage upstream found is Windows-only.** On Windows 11 + py3.14 + torch 2.14, building ModernBERT segfaults in `PreTrainedModel.initialize_weights` during `post_init`, so `Agent(...)` cannot finish loading; the fix is a guarded no-op patch → ISS:123, ISS:129, ISS:161 → **high** for "reported on Windows"; **not verified on Linux** — issue #129 states plainly "The segfault was not remeasured on Windows here. CI for this repo runs on Linux." → ISS:129 → **high**. Treat Linux as *unreported*, not as *known-good*.
2. **Do not let anything pin `transformers` 4.x.** The declared floor is `>=4.48.0`, but on 4.x the multilingual checkpoint silently reads the wrong RoPE base — `laya-multilingual` scores `billing` 0.8647 on the same Hindi input where 5.x gives 0.9328, with no warning; MPS is also broken → ISS:51 (open PR) → **med** (PR not merged, but it names the mechanism and the repo's own test asserts only the `>=4.48` floor, SRC:tests/test_packaging.py).
3. **`pip install laya` alone will pull the CUDA-bundled torch from PyPI** if torch isn't pre-installed, because the declared floor is only `torch>=2.0.0` → PYPIMETA → **high** (inference from the metadata; the 196 MB-vs-CUDA size difference is the cpu-index listing → **high**).

---

## 2. API

### Load

```python
import laya
agent = laya.load("convaiinnovations/laya")                            # English root (ModernBERT-large, 512 ctx)
agent = laya.load("convaiinnovations/laya", subfolder="multilingual")   # mmBERT-base, 1024 ctx
agent = laya.load("convaiinnovations/laya", subfolder="typed-decisions")
```

`def load(model_id_or_path="convaiinnovations/laya", device=None, token=None, subfolder=None) -> Agent` — SRC:laya/agent.py (`load`), SRC:laya/__init__.py → **high**

### predict

`predict` is literally an alias: `predict = system_one` — SRC:laya/agent.py → **high**

```python
def system_one(self, state: Union[str, dict, list],
               questions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]
```

**Exactly two positional args. There is no `temperature=`, no `model=`, no `task=`, no `lang=` on `Agent.predict`** → SRC:laya/agent.py → **high**. (`model`/`task`/`lang` exist only on `Router.predict`.)

`Router.predict(self, state, questions, model=None, task=None, lang=None)` → SRC:laya/router.py → **high**

### Question schema

| type | `criteria` | rendered option labels |
|---|---|---|
| `choice` | `dict {label: description}`, optionally `list[str]` (auto-converted to `{c: None}`) | `"label: description"` |
| `score` | `list[str]` (ordinal levels, index 0 = lowest) | `"level <i>: <text>"` |
| `noul` | optional; `{"true": "...", "false": "..."}` (dict values may also be non-strings) | hardcoded `"false: ..."` / `"true: ..."` |

Source: `_to_internal`, `render_options`, and the `system_one` docstring — SRC:laya/agent.py, SRC:laya/common.py → **high**. `instructions` accepts a non-string and is `json.dumps`-ed — SRC:laya/agent.py → **high**.

```python
questions = {
  "department": {"type": "choice", "instructions": "Which department?", "criteria": {"billing": "invoices", "technical": "bugs"}},
  "urgency":    {"type": "score",  "instructions": "How urgent?",       "criteria": ["not urgent", "soon", "critical"]},
  "refund":     {"type": "noul",   "instructions": "Does the user request a refund?"},
}
res = agent.predict(state, questions)
```

### Result shape

`system_one` returns exactly:

```python
{"model": "laya-rl-agent",
 "answers": {qid: {...}},
 "usage": {"input_tokens": int, "output_tokens": 0}}
```

per-answer:

- `choice`: `{"type","choice": <key>,"probabilities": {key: float},"confidence": float,"action": {"act_probability": float}}`
- `score`: `{"type","score": float (expected level),"legend": {i: text},"probabilities": {i: float},"confidence": float,"action": {...}}`
- `noul`: `{"type","noul": float = P(true),"confidence": float,"action": {...}}`

→ SRC:laya/agent.py (`system_one` return block) → **high**

**Routing metadata is NOT in `system_one` output.** It is added only by the Router:

```python
result = router.predict(state, questions)
result["routing"]   # {'model','repo','reason','detection','workflow'}  (dict subclass RouteDecision)
```

→ SRC:laya/router.py (`Router.predict` sets `result["routing"] = dict(decision)`; `RouteDecision`) → **high**. The GH README's `res_en["routing"]["model"]` example is Router-only, and `router.route(state, questions, model=, task=, lang=).reason` gives the decision with **no forward pass** → SRC:laya/router.py, GH → **high**.

### Device selection

Auto: `cuda` → `mps` → `cpu`. Explicit `device=` is honoured, with a printed warning and CPU fallback if unavailable. On CPU **dtype is forced to `float32` and autocast is disabled** (`use_amp = self.device.type == "cuda"`). A CUDA OOM during placement or inference also falls back to CPU with a printed warning → SRC:laya/agent.py → **high**

### cfg knobs (there is no `temperature` argument — it is checkpoint state)

`agent.cfg` is the raw `rl_agent_config.json` → SRC:laya/agent.py → **high**

| key | English root | multilingual | typed-decisions | note |
|---|---|---|---|---|
| `max_len` | 512 | 1024 | 1024 | read per call via `self.cfg.get` ⇒ **mutable at runtime** |
| `head_max_len` | 192 | 256 | 256 | read per call; **options are truncated/error against this budget** |
| `encoder` | `answerdotai/ModernBERT-large` | `jhu-clsp/mmBERT-base` | `answerdotai/ModernBERT-large` | |
| `head_layers` | 2 | 2 | 2 | |
| `amp_dtype` | `bf16` | `bf16` | `bf16` | ignored on CPU (forced fp32) |
| `temperature` | 3 values | **2 values** | 3 values | per-type; clamped to `[0.5, 5.0]` at load |
| `temperature_by_options` | 6 buckets | `{}` | 6 buckets | key format `"<qtype>:<size>"`, e.g. `"choice:11+"` |

→ HFCFG (both bundled and standalone repos) + SRC:laya/agent.py, SRC:laya/common.py (`TEMP_MIN=0.5`, `TEMP_MAX=5.0`, `temp_bucket` bucket edges `2 / 3-5 / 6-10 / 11+`) → **high**

Raising the option budget at runtime (documented in GH README → **high**):

```python
agent.cfg["head_max_len"] = 512
agent.cfg["max_len"] = 1024          # up to 2048/4096/8192 per README
```

If options don't fit you get a hard error, not a silent truncation:
`ValueError("question %r options exceed head_max_len=%d")` → SRC:laya/agent.py → **high**

Useful extras: `laya.router_questions() / guard_questions() / moderation_questions() / triage_questions() / email_questions()` presets (SRC:laya/presets.py, SRC:laya/__init__.py → **high**); `predict_shortlist(agent, state, questions, embed_fn, k=..., **predict_kwargs)` for >20-option shortlisting (SRC:laya/shortlist.py → **high**).

---

## 3. BRIDGE — **none exists. You will be writing the stdio bridge.**

This is the clearest answer in the brief:

- The released package's public surface is **importable Python only**. `pyproject.toml` declares **no `[project.scripts]` / `console_scripts`**, and there is **no `laya/__main__.py`, no `laya/cli.py`, no `laya/serve.py`** anywhere on main (`573e5b62` = 0.3.5) → SRC:pyproject.toml, SRC:laya/, SRC:setup.py → **high**
- `python -m laya` does **not** work in 0.3.5 — no `__main__` module → SRC:laya/ → **high**
- The only `argparse` in the repo is a **developer benchmark harness**, `research/scripts/bench_local.py`, explicitly "nothing here is imported by the `laya` package" and not installed → SRC:research/README.md, SRC:research/scripts/bench_local.py → **high**
- **No MCP server exists** anywhere in the repo — no `mcp`, `json-rpc`, or `stdio` occurrence in the package or its metadata → SRC:pyproject.toml + full-text search of `laya/` → **high**

Everything resembling a bridge is an **open, unmerged PR**, and I'd expect the specific commands you'd want to be unusable today:

| What | Command quoted in the PR | Status |
|---|---|---|
| CLI | `laya "I was charged twice, please refund"`, `laya "..." --predict`, `laya --model --task --lang --device --json` | **OPEN** (ISS:155; supersedes the closed ISS:121, whose `python -m laya` and `laya/cli.py` are also absent from main) |
| HTTP (Jev wire-compatible) | `laya/serve.py`, `laya-serve` console script, `POST /v1/systemone` + `/health`, `laya[serve]` extra, env `LAYA_HOST/PORT/DEVICE/PRELOAD/MODELS/AUTO_TASK/API_KEY/LAYA_THREADS` | **OPEN** (ISS:31; the request it answers is ISS:32) |
| HTTP (OpenAI-compatible) + Pydantic schemas | `laya/schemas.py`, REST server | **OPEN** (ISS:3) |
| Demo web GUI + JSON API | `examples/server.py`, `POST /predict`, `/predict/batch`, `laya[server]` extra | **OPEN** (ISS:114) |

→ ISS:155, ISS:121, ISS:31, ISS:32, ISS:3, ISS:114 → **high** for the quoted text (it is verbatim from each PR body) and **high** for "not in 0.3.5" (verified against main's tree). Note ISS:121 is *closed* yet its files are absent from main — treat closed PRs as merged only after checking the tree.

**Practical consequence:** a `python -c` shim that reads JSON on stdin and calls `Router.predict`/`Agent.predict` is the whole bridge. The good news is the shape is friendly: `state` accepts a plain `dict` or `str` (JSON-serialised internally via `serialize_state`), questions are plain nested dicts, and the result is already JSON-serialisable as long as you convert numpy floats — **which `system_one` already does** (`round(float(...), 4)` everywhere) → SRC:laya/agent.py, SRC:laya/common.py → **high**. `Router.route()` is pure-Python and needs no checkpoint load, so a cheap routing-only path costs no download (ISS:155 design note → **med**, PR text).

---

## 4. OFFLINE / RUNTIME

### Download sizes (per checkpoint, from the bundled repo)

`Agent.__init__` calls `snapshot_download` with `allow_patterns` scoped to the checkpoint, so only the selected checkpoint is fetched (root checkpoints included — this was bug ISS:97, fixed by ISS:98) → SRC:laya/agent.py, SRC:tests/test_download.py → **high**

Pattern set: `rl_agent_config.json`, `model.safetensors`, `tokenizer/*`, `encoder/*` (the `encoder/` dir holds **only `config.json`** — the real encoder weights live inside `model.safetensors`) → SRC:laya/agent.py, HFAPI → **high**

| Requested | Bytes / files | Confidence |
|---|---|---|
| `laya.load("convaiinnovations/laya")` (English root) | **846,195,574 B / 5 files** (≈846 MB; ≈807 MiB) | high — ISS:98 states the exact post-fix numbers, and `842.6 MB + 3.6 MB` from HFAPI matches |
| `subfolder="multilingual"` | ≈678 MB (`643.8 MB` safetensors + `34.4 MB` tokenizer.json) | high — HFAPI; GH README says "~647 MB" (MiB) — consistent |
| `subfolder="typed-decisions"` | ≈846 MB (`842.6 MB` + `3.6 MB`) | high — HFAPI |
| whole repo, unfiltered | 2,372,586,456 B / 38 files (≈2.37 GB) | high — ISS:98 |

So **846 MB per checkpoint, ~1.5 GB if you serve both English and multilingual** (README calls the three checkpoints "~1.16B parameters" → GH → **high**).

### Cache location and env vars

The default cache is **`~/.cache/huggingface/hub`** (`HF_HOME` defaults to `~/.cache/huggingface` unless `XDG_CACHE_HOME` is set; `HF_HUB_CACHE` defaults to `$HF_HOME/hub`) → HFENV → **high**. `HF_HOME`, `HF_HUB_CACHE`, `HUGGINGFACE_HUB_CACHE` (deprecated alias), `HF_TOKEN` are all honoured by `huggingface_hub` → HFENV → **high**.

**`laya` itself documents none of this** — the strings `HF_HOME`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `local_files_only` appear **nowhere** in the package, tests, or README → full-text search of the repo → **high**. The only env var laya reads itself is `HF_TOKEN` (`token or os.environ.get("HF_TOKEN")`, in both `Agent.__init__` and `Router.__init__`) → SRC:laya/agent.py, SRC:laya/router.py → **high**.

Practical consequence: offline behaviour is your responsibility at the `huggingface_hub` layer, not laya's.

- `HF_HUB_OFFLINE=1`: no HTTP calls to the Hub; cached files only; an error if the file isn't cached; `HfApi` calls raise `OfflineModeIsEnabled` → HFENV → **high**
- `DO_NOT_TRACK=1` / `HF_HUB_DISABLE_TELEMETRY=1`: telemetry off across the HF Python ecosystem → HFENV → **high**
- Recommended for your CPU box, since `snapshot_download` otherwise revalidates metadata on every load even when the weights are cached (HFENV notes `hf_hub_download` still triggers an HTTP request to check for a new version unless `HF_HUB_OFFLINE=1`) → HFENV → **high**; the per-load `snapshot_download` call is in SRC:laya/agent.py → **high**

```bash
export HF_HOME=/opt/models/hf          # optional relocation
export HF_HUB_OFFLINE=1                # after the first warm download
export USE_TF=0 USE_TORCH=1            # see below
export TOKENIZERS_PARALLELISM=false    # the repo's own harness sets this
```

`USE_TF=0` / `USE_TORCH=1` / `TOKENIZERS_PARALLELISM=false` are exactly what the repo sets in every script, test, and in CI env → CI, SRC:tests/test_local_e2e.py, SRC:tests/test_download.py, SRC:research/scripts/*.py → **high**. The stated reason (verbatim, three separate places): *"transformers probes for TensorFlow at import; when TF is present its abseil runtime can deadlock model construction"*, and `test_local_e2e.py` adds the concrete symptom *"`[mutex.cc : 452] RAW: Lock blocking`, hanging `laya.load()` forever"* → SRC:tests/test_local_e2e.py, SRC:research/README.md, CI → **high**. The GH model card puts it next to `laya.load()`: *"**If `laya.load()` hangs:** ... Run with `USE_TF=0`."* → HF → **high**. It is a *conditional* requirement — only if TF is installed alongside torch (unlikely in your venv, but free to set).

### preload() / max_loaded

- `Router(models, device, token, max_loaded=1, default="english", auto_task_detection=False, standalone_repos=False, preload=False)`; `max_loaded` is the LRU cap, `max(1, int(max_loaded))` → SRC:laya/router.py → **high**
- `Router(preload=True)` or `router.preload(["english","multilingual"])` builds every checkpoint up front and **raises `max_loaded` to fit what was preloaded**, so the LRU cannot evict what it just built; `router.attach("english", existing_agent)` avoids a duplicate copy; `router.unload()` / `unload(name)` frees → SRC:laya/router.py → **high**
- Load/unload/attach/preload are guarded by an `RLock`; **inference is deliberately outside the lock** so concurrent predictions share a checkpoint (this was ISS:95) → SRC:laya/router.py → **high**
- With `max_loaded=1` and alternating languages, the model is rebuilt on every switch — **7.4 s median reload on CPU**, 10.3 s on T4 → GH README → **high** (this is the single most important config fact for a CPU box)

### Does inference make network / telemetry calls?

**No network after the weights are cached.** The load path is: `snapshot_download` (only if the path isn't already a local directory — a local dir short-circuits it entirely) → `_fix_tokenizer_config` → `AutoTokenizer.from_pretrained(<local tokenizer dir>)` → `AutoConfig.from_pretrained(<local encoder dir>)` + `AutoModel.from_config(..., attn_implementation="sdpa")` + `load_state_dict(strict=True)`. `from_config` never downloads. `tests/test_download.py::test_local_paths_do_not_download` asserts `snapshot_download` is **never called** for local paths, via `assert_not_called` → SRC:laya/agent.py, SRC:laya/common.py (`build_model`), SRC:tests/test_download.py → **high**. The encoder weights come from `model.safetensors`, and git-pinned `encoder/config.json` is fetched by the allowlist, so the `AutoModel.from_pretrained("answerdotai/ModernBERT-large")` fallback branch (the only network-capable one) is unreachable for real checkpoints → HFAPI + SRC:laya/agent.py → **high**.

**No telemetry code exists in the package** — no analytics, no `requests`, no `httpx`, no posthog/sentry import anywhere in `laya/` → full-text search of `laya/` → **high**. (What HF's own libraries do is governed by `DO_NOT_TRACK` / `HF_HUB_DISABLE_TELEMETRY`, §HFENV.) No source states "laya sends no telemetry" explicitly — see COULD NOT VERIFY.

### Two runtime gotchas worth knowing before you deploy

1. **`_fix_tokenizer_config` writes into the download directory at load time.** It rewrites `tokenizer/tokenizer_config.json` in place (fixing `tokenizer_class: "TokenizersBackend"` → `PreTrainedTokenizerFast`, and converting a list-valued `extra_special_tokens` to a mapping — without which mmBERT/Gemma checkpoints fail with `'list' object has no attribute 'keys'`). Failures are swallowed by a bare `except Exception: pass`. On a **read-only or shared cache** this silently no-ops and the load can then fail for multilingual → SRC:laya/agent.py → **high**.
2. **`reference_compile` is forced off** on the encoder ("can hang on some platforms; that is a loss for the batch sizes Laya runs") → SRC:laya/agent.py → **high**.

---

## 5. LATENCY — CPU only

All numbers below are CPU. The T4 figures the docs headline (39.5 ms / 32.8 ms) are **not** your numbers.

| Source | Scenario | CPU figure | Confidence |
|---|---|---|---|
| GH README (deployment table) | `Router(preload=True)`, per request | **193–464 ms** | high |
| SRC:laya/agent.py (CUDA→CPU fallback warning) | per inference, "roughly 10-15x slower" | **~200–500 ms vs ~35 ms** | high |
| GH README | cold restart, median, `max_loaded=1` language switch | **7.4 s median on CPU** (10.3 s T4) | high |
| SWEEP `part_a` | English, MASSIVE intent, **20 options**, 100 q/lang, batched | min/median/max **11.6 / 20.2 / 25.6 s per language ⇒ 116 / 202 / 256 ms per question** | high (values) / med (interpretation) |
| SWEEP `part_a` | multilingual, same protocol | **7.7 / 8.6 / 10.3 s ⇒ 77 / 86 / 103 ms per question** | high / med |
| SWEEP `part_b` | English, typed-decisions, 400 cases × 5 questions | **557.0 s / 2000 q = 278.5 ms per question; 1392.5 ms per 5-question case** | high / med |

**Read those sweep numbers with care.** They are derived from batched runs, not single-call latency: `score_cases` packs up to `max_seqs=64` sequences per forward pass under a `max_tokens=8192` budget, and the timer starts *after* tokenisation, so the seconds cover forward passes only → SRC:research/scripts/bench_local.py → **high**. The sweep's meta also fixes the measurement conditions at **`torch 2.8.0`, `laya 0.2.0`, `threads: 4`** → SWEEP → **high**. So: **~200 ms per single question, ~120–280 ms/question at batch, ~7.5–13 questions/sec batched** for English; multilingual is ~2.2x faster (GH README claims "~2.2x faster", tagline "2x faster") → **med** on the ratio.

**Warmup exists in practice, but is undocumented for users.** `bench_latency.py` warms up 3 iterations before sampling 15 (`def timed(fn, warmup=3, reps=15)`), and its inference section uses `warmup=2, reps=10`; it then explicitly warms each model before measuring the "hot" path → SRC:research/scripts/bench_latency.py → **high**. The published CPU single-call p50/p95 **are not available**: `bench_latency.py` is designed to emit CPU p50/p95 and says *"CPU numbers"* in its own meta, but the repo's `research/results/` contains only `t4_colab_benchmark.json` and `cpu_51_language_sweep.json` — the latency JSON is absent, and ISS:134 notes `research/results/` doesn't cover all README tables → SRC:research/scripts/bench_latency.py, SRC:research/README.md, ISS:134 → **high**.

**Thread guidance: none shipped.** `torch.set_num_threads` appears exactly once in the whole repo — `tests/test_download.py`, under `if __name__ == "__main__"`, i.e. a test-runner detail, not user guidance → **high**. The only upstream mention of CPU thread control is an **unmerged** PR offering a `LAYA_THREADS` env var "to cap torch intra-op threads for CPU" → ISS:31 → **med**. So `torch.set_num_threads(N)` is left entirely to you; nothing in the package or docs recommends a value.

---

## 6. LICENSE

- PyPI metadata: `license: Apache-2.0`, classifier `License :: OSI Approved :: Apache Software License`, `license_files: ["LICENSE"]` → PYPIMETA → **high**
- `pyproject.toml` (the **code** package): `license = { text = "Apache-2.0" }`; a 10,173-byte `LICENSE` sits at the repo root → SRC:pyproject.toml, SRC:LICENSE → **high**
- Tokenizer/model warning: `laya/agent.py` has a `_fix_tokenizer_config` helper for `mmBERT/Gemma` — a *code* note, not a licence statement → **high** (no licensing consequence implied)
- All three model repos: `cardData.license: apache-2.0`, tags `['license:apache-2.0']` → HF → **high**
- Model card: "Apache 2.0 · Convai Innovations"; GH README LICENSE section: "Apache 2.0. Developed by Convai Innovations." → HF, GH → **high**
- The Jev comparison table lists Laya's weights as "Apache 2.0 ... Open weights, on-premise capable ... $0 self-hosted" → GH → **high**

**Conclusion:** Apache-2.0 covers the code package **and** all three checkpoints, with no commercial-use restriction, no gating, and no separate model licence or Acceptable-Use clause that I could find → **high**. (One caveat that is *not* a licence issue but affects redistribution: the `LICENSE` file is 10,173 bytes and I confirmed it exists at the repo root; PyPI ships it via `license_files`, but I did not read its 10 KB text line-by-line to confirm it is the unmodified Apache-2.0 text — see COULD NOT VERIFY.)

---

## ⚠ Two landmines that change the "replace LLM calls for typed judgements" plan

These matter more than any install detail, and they are the reason I'd stage this rather than swap it in.

### A. `laya-multilingual` raises `IndexError` on **every** `noul` question — unreported bug

`Agent.system_one` computes, per question:

```python
t_scale = self.temperature_by_options.get(temp_bucket(qt, k), self.temperature[qt])
```

The default argument is evaluated **eagerly**, so `self.temperature[qt]` is indexed even when the bucket exists. `QTYPES = {"choice": 0, "score": 1, "noul": 2}` ("noul" is the "check" primitive you want), and the shipped multilingual config has **`temperature: [1.0, 1.0]` — only two entries — with `temperature_by_options: {}`** → `self.temperature[2]` → `IndexError: list index out of range`.

Verified by reproducing that exact expression with the real shipped config values:

```text
== laya (root)          len(temperature)=3  choice/score/noul -> OK
== laya-multilingual    len(temperature)=2  choice OK, score OK, noul -> IndexError: list index out of range
== laya-typed-decisions len(temperature)=3  choice/score/noul -> OK
```

Sources: SRC:laya/agent.py (the line), SRC:laya/common.py (`QTYPES`, `temp_bucket`, `clamp_temperature`), HFCFG (all four multilingual configs — bundled subfolder **and** standalone repo are both `[1.0, 1.0]` / `{}`) → **high for the code + config facts**; **med for the live failure**, because I reproduced the exact expression in isolation rather than executing the real forward pass (torch is not installed in this recon environment). GitHub issue search for `IndexError` returns **0 results**, so this is not a known/tracked bug → **high**.

Workaround if you must use multilingual: set `agent.cfg["temperature"] = [1.0, 1.0, 1.0]` (or any 3-element list) before calling `predict` — the list is read per call, not cached, and `clamp_temperature` will normalise it. English root and `typed-decisions` are unaffected.

### B. `noul` is currently wrong on the shipped weights — the boolean label bias

`render_options` hardcodes noul's model-facing labels to `"false: ..."` / `"true: ..."` → SRC:laya/common.py → **high**. The consequence, per ISS:156: a noul question **returns the negative label regardless of the state**, with `confidence` 1.0000 — with and without `criteria`, so supplying criteria does not help. The isolation the reporter produced shows the trigger is the **label word**, not the primitive and not the position:

| option label pair | positive review | negative review |
|---|---|---|
| `positive` / `negative` | `positive` ✅ | `negative` ✅ |
| `true` / `false` | **`false`** ❌ | `false` ✅ |
| `yes` / `no` | **`no`** ❌ | `no` ✅ |
| `A` / `B` | `A` ✅ | `B` ✅ |
| `1` / `2` | `1` ✅ | `2` ✅ |

→ ISS:156 → **med** (a reporter's claim in an open issue, unreproduced by me and not remeasured by the maintainers — but the two follow-up PRs treat it as real)

The fix is **open, not merged**: ISS:163 proposes switching noul's default model-facing labels to `negative`/`positive` while keeping slot order `[false, true]` so the returned value stays `P(true)`, and adds an optional per-question `labels` mapping; ISS:146 separately normalises native Python `True`/`False` criteria dict keys to `"true"`/`"false"` and documents the `noul` criteria mapping → ISS:163, ISS:146 → **med**. **If you use `noul` for "check" judgements, this is the blocker** — and because it is unreleased, you cannot get the fix from PyPI; you'd patch `render_options`/criteria yourself or vendor main.

**Net recommendation for your use case:** install and pin to the **`typed-decisions`** checkpoint or the English root (both have 3-entry temperatures, so landmine A is avoided); treat `noul` as untrusted until ISS:163 lands; and write your own small stdio bridge (§3) — it is genuinely small, because `state` accepts a `dict` and the output is already JSON-safe.

---

## COULD NOT VERIFY

No primary source confirmed the following. I am not filling these gaps with plausible guesses.

1. **Whether `laya.load()`/inference works on Linux + Python 3.14 + torch 2.14.** The segfault is reported **only on Windows 11** (ISS:123/#129/#161), and #129 states the fix was not remeasured and CI runs Linux — but no source states Linux+3.14 is *known good*, and 3.14 appears in **no** CI matrix. Unknown either way.
2. **The multilingual `noul` `IndexError` was never executed against real weights.** I reproduced the exact temperature expression with the real config values, not a real forward pass. Also **no upstream issue reports it** (`IndexError` search: 0 results) — so there is no upstream confirmation it is real in production, and equally none that it isn't.
3. **CPU single-question latency (p50/p95) with documented warmup.** The README's `193–464 ms` is a range with no stated measurement protocol, `agent.py`'s `~200–500 ms` is an estimate in a warning message, and `bench_latency.py`'s CPU p50/p95 output JSON is **not in the repo**. Every CPU number I can cite is either a range with no methodology or a batched-throughput derivative.
4. **Any user-facing thread-count or warmup guidance.** `torch.set_num_threads` appears only in a test `__main__` block; `LAYA_THREADS` exists only in an unmerged PR. No recommended value, no documented warmup count. The sweep's `threads: 4` is a recorded measurement condition, not advice.
5. **Any explicit "makes no network/telemetry call" statement.** I verified it by reading the load path (all local) and by searching for telemetry code (none). No source asserts it, and `laya` never documents `HF_HUB_OFFLINE` / `HF_HOME` / `local_files_only` at all — offline behaviour is undocumented for this package.
6. **Whether the closed PR ISS:121 (CLI) was rejected or just superseded.** Closed with 1 comment, its files absent from main, and ISS:155 re-opens the same request. Not verifiable from the API without reading the comment thread.
7. **The full text of `LICENSE` (10,173 bytes) — line-by-line confirmation that it is unmodified Apache-2.0.** I verified the metadata declares Apache-2.0 and that the file exists and ships via `license_files`, not that the text is unmodified. (10,173 bytes is in the plausible range for Apache-2.0 + a NOTICE appendix, but I did not confirm.)
8. **`laya`'s actual dependency resolution on your machine.** All wheel-existence facts are verified per package from PyPI/index listings, but I did **not** perform an actual install/resolve on py3.14, so a resolver conflict I did not anticipate remains possible.
9. **Whether `Router.predict`'s `route()` path is truly network-free.** The ISS:155 PR claims "Router.route() is pure (no checkpoint load)" → that is PR prose, and I confirmed `route()` only calls `analyse()` (dependency-free pure Python) — but I did not execute it.
10. **Any performance/accuracy claim about `typed-decisions` on your domain.** The 0.766 figure is on the checkpoint's own benchmark's training split; the repo's own "Honest Limits" say the base checkpoints are near chance zero-shot (0.362/0.342 vs 0.461 majority-class) → GH, HF → **high** as a caveat, but its transfer to your workflows is unverified by anyone.
