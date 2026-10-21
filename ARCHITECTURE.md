# Legal Assistant — Architecture

> Based on the current code (`src/index.ts` + the `kb/` build scripts): the architecture, data pipeline, retrieval path, storage layout, access control, and design trade-offs of the legal RAG system.

---

## 1. Overview

Legal Assistant is a **single-file serverless app on the Cloudflare edge** that answers questions about mainland China law. It is built on **RAG (retrieval-augmented generation)**: instead of fine-tuning a model, it retrieves the relevant articles, puts them into the context, and generates an answer with citations.

One Worker does four things:

1. **Serves the frontend**: `GET /` returns an embedded single-page Q&A UI (all CSS/JS inline)
2. **Vector retrieval**: embeds the question and queries a Vectorize index
3. **Generation**: sends the retrieved articles to DeepSeek and streams the answer
4. **Access control**: invite codes, enforced server-side (usage limits / revocation / one user online at a time, state in D1)

There is no backend framework. The article vectors live in a Cloudflare Vectorize index (`legal-kb`); invite codes and sessions live in Cloudflare D1 (`legal-assistant-users`). All user-facing text, including the system prompt, lives in `src/locale/zh-CN.ts`.

### Stack

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Workers (V8 isolate) |
| Language | TypeScript (strict, ES2022) |
| Build / deploy | Wrangler 3.x |
| Generation model | DeepSeek `deepseek-v4-flash` (OpenAI-compatible) |
| Embedding model | SiliconFlow `BAAI/bge-m3` (1024 dimensions, strong on Chinese) |
| Vector store | Cloudflare Vectorize (`legal-kb`, cosine metric) |
| Invite code / session state | Cloudflare D1 (`legal-assistant-users`, SQLite) |
| Frontend | Plain HTML/CSS/JS (embedded) |
| Offline build | Python 3 (fetch / chunk / embed) |

---

## 2. Deployment topology

```
┌──────────┐  HTTPS  ┌──────────────────────────────┐
│ Browser  │ ──────▶ │ Cloudflare Edge  Worker       │
│  Q&A UI  │ ◀─SSE── │  Bindings:                    │
└──────────┘         │   Vars      LLM_* / EMBED_*   │
                     │   Secrets   LLM_API_KEY / EMBED_API_KEY
                     │   VECTORIZE legal-kb          │
                     │   DB        legal-assistant-users (D1)
                     └───┬──────────────┬────────────┘
     ② embed question    │              │ ③ vector search     ④ generate
                         ▼              ▼                     ▼
              api.siliconflow.cn   Vectorize (legal-kb)   api.deepseek.com
                 (bge-m3)                                 (deepseek-v4-flash)
```

---

## 3. Two paths: offline build vs online serving

### 3.1 Offline build (`kb/`, run locally, produces vectors.ndjson → imported into Vectorize)

```
kb/laws.json (which laws to include + metadata)
      │
      ▼  build_chunks.py
Fetch text (GitHub just-laws) → skip frontmatter → detect chapter headings / bold article markers
      → one chunk per article, Chinese article numerals converted to integers
      → kb/chunks.json (law / book / chapter / article no / force / validity / source / text / embed_text)
      │
      ▼  embed.py (needs SILICONFLOW_KEY)
Each embed_text → bge-m3 vector (raw floats, no quantization)
      → kb/vectors.ndjson, one row per chunk: {id, values:[1024], metadata:{law/article_cn/zhang/bian/xiaoli/text/source}}
      │
      ▼  wrangler vectorize insert/upsert legal-kb --file=kb/vectors.ndjson
Vectors + metadata written to the Vectorize index (insert the first time, upsert by id afterwards)
```

**Key point**: the article text is stored as **metadata** on each vector, and the `id` is `<law>-<article no>`, so re-upserting the same id overwrites instead of creating duplicates.

### 3.2 Online serving (`/legal`, per question)

```
handleLegal(request, env):
  1. Parse body; check invite code (X-Invite-Code or body.code) and session; fail → 401 / 409
  2. Atomically consume one use of the code
  3. Take the latest user message as the retrieval query
  4. embedQuery: call bge-m3 for the query vector
  5. searchKB: env.VECTORIZE.query(qv, {topK, returnMetadata: 'all'})
  6. Build systemContent = system prompt + retrieved articles (with validity / source from metadata)
  7. fetch DeepSeek (stream, thinking: disabled, max_tokens: 4096)
  8. Stream the response through; retrieved articles go in the X-Legal-Hits header
```

**Retrieval cost**: one Vectorize network call per question (tens of milliseconds). In exchange there is no 128 MB Worker memory ceiling, and the index can grow to the full legal corpus. The free tier includes 5M stored vector dimensions and 30M queried vector dimensions per month; beyond that it is $0.05 per 100M dimensions per month.

---

## 4. Frontend flow

```
Open page → invite gate (#gate; skipped if localStorage already has a code + session)
          → Q&A page (welcome card + example questions + coverage)
User asks / clicks an example → send()
  1. Append user bubble, push to history[]
  2. Append assistant bubble (hits area + body area) + blinking cursor
  3. POST /legal (X-Invite-Code / X-Session-Token headers, body = full history)
  4. 401 / 409 → back to the gate, roll back this turn
  5. Read X-Legal-Hits → render reference chips
  6. Read the SSE stream (buffered split on \n\n so events are never cut across chunks)
     → accumulate deltas → minimal Markdown (escape + **bold** + `code`) → render live
  7. Done: push the assistant answer to history
```

- **Multi-turn**: the frontend sends the whole `history[]`; retrieval uses only the latest user message, while DeepSeek still sees the full conversation. The conversation lives in browser memory and is lost on refresh.
- **References**: `X-Legal-Hits` shows which articles the answer is based on, which matters for traceability in a legal setting.

---

## 5. Storage layout

| Data | Location | Notes |
|------|----------|-------|
| Article text + metadata + vectors | Cloudflare Vectorize (`legal-kb`) | Imported offline; queried on demand via the binding |
| Chunk output | `kb/chunks.json` (git) | Human-readable; source for regenerating vectors |
| Vector import file | `kb/vectors.ndjson` (git-ignored) | Produced by `embed.py`, consumed by `wrangler vectorize insert/upsert` |
| Law list | `kb/laws.json` (git) | Declares which laws to include |
| Raw source cache | `kb/raw/` | Avoids refetching on reruns |
| Invite code state (limit / revoked) + sessions | Cloudflare D1 (`legal-assistant-users`) | Configuration comes from `invite-codes.txt` (local) via `npm run apply-codes`; `used_count` and sessions are runtime state only in D1 |
| API keys | Secrets `LLM_API_KEY` / `EMBED_API_KEY` | Never committed |
| UI text + system prompt | `src/locale/zh-CN.ts` | Kept separate so the code stays English-only |

---

## 6. Access control

| Where | Purpose | Security boundary |
|-------|---------|:---:|
| Frontend `#gate` overlay | Stops casual users, better UX | ❌ bypassable |
| Frontend call to `/verify` | Immediate feedback + obtain session_token | ❌ helper only |
| Server-side checks in `/verify` + `/legal` (D1) | No valid code / session → 401 / 409, no retrieval or DeepSeek access | ✅ **the only real boundary** |

Each invite code has its own state in D1:

```
invite_codes: status (active / revoked) · max_uses / used_count
sessions:     code → device_id + session_token of the current holder (one row per code = one user online)
```

- **Usage limit**: each `/legal` call consumes a use with a single `UPDATE ... WHERE used_count < max_uses RETURNING used_count`, so concurrent requests cannot overshoot the limit
- **Revocation**: `status = 'revoked'`; `/verify` and `/legal` reject it immediately
- **One user online (last login wins, not a permanent device lock)**: `/verify` **unconditionally** upserts the session row, so anyone with a valid code takes over the session. The previous holder gets a 409 on their next `/legal` call because the token no longer matches; **the frontend returns to the gate and clears the local session, and the user must re-enter the code to reclaim it**.
  - Two earlier designs were wrong. v1 permanently bound a code to the first device, so nobody else could ever get a session. v2 switched to takeover but added a silent automatic re-`/verify` on page load or on 409, which meant a kicked-out user would kick the other person back as soon as they refreshed or sent a message. The current version removes automatic reconnect entirely: reclaiming a session is always an explicit user action.
- **Anonymous `device_id`**: a random id generated and stored by the browser. It is only a local identifier; **it does not take part in authorization and is never used to reconnect** — the real boundary is "only one valid session_token at a time".

Codes are managed in `invite-codes.txt` (`code[,max_uses][,status]`) and synced with `npm run apply-codes`, which only updates `max_uses` / `status` and never resets usage.

---

## 7. Anti-hallucination design

1. **Strict system prompt**: answer only from retrieved articles; cite each one by law name and article number; say so when they are insufficient; **never invent article numbers**; append a disclaimer.
2. **Visible references**: `X-Legal-Hits` returns the retrieved articles so users can check the basis of the answer.
3. **Validity in context**: each retrieved article carries its validity status (e.g. in force) for the model to consider.
4. **Thinking disabled**: answers directly, which keeps output stable.

> This is an information retrieval aid, not legal advice; both the UI and the system prompt say so.

---

## 8. Design trade-offs

| Decision | Benefit | Cost |
|----------|---------|------|
| RAG instead of fine-tuning | Traceable, easy to update, changing laws only rebuilds the index | Depends on retrieval recall |
| Vectorize retrieval | No 128 MB memory ceiling, scales to the full corpus, free tier covers the current size | Retrieval is a network call (tens of ms) |
| Text stored as vector metadata | No script size / memory limits, idempotent ids make updates easy | Import goes through the wrangler CLI, one extra step beyond deploy |
| SSE pass-through | Low latency, the Worker only forwards | Hard to post-process answers server-side |
| Frontend sends full history | Simple, no server-side conversation state | Long conversations grow tokens (no trimming) |
| Text in a locale file | Code stays English-only; text is easy to edit | One extra indirection in the HTML template |

---

## 9. Known limitations and next steps

1. **Data coverage**: pilot of 6 laws; text comes from the open-source mirror `just-laws` (should be spot-checked against the official current text); bulk full-text retrieval from the official flk database (docx/OFD + encrypted list API) is not solved yet.
2. **No reranker**: top-k uses raw vector scores; adding `bge-reranker` would improve precision.
3. **No history trimming / rate limiting**, and the invite code is stored in plain text in localStorage.
4. **Error details leak**: `/legal` returns the upstream error body on 502; production should sanitize it.

---

## 10. File map

| File | Role |
|------|------|
| `src/index.ts` | Routing + invite codes (D1) + RAG retrieval (embedQuery / searchKB → Vectorize) + /legal + embedded frontend |
| `src/locale/zh-CN.ts` | UI text, error messages, example questions, system prompt |
| `kb/laws.json` | Law list + metadata |
| `kb/build_chunks.py` | Fetch + split per article → chunks.json |
| `kb/embed.py` | Embed → kb/vectors.ndjson (for wrangler vectorize insert/upsert) |
| `db/schema.sql` | D1 tables (invite_codes / sessions) |
| `scripts/apply-codes.mjs` | invite-codes.txt → D1 upsert (`npm run apply-codes`) |
| `wrangler.toml` | Worker name, vars, `[[vectorize]]` / `[[d1_databases]]` bindings |
| `README.md` | Usage / deployment / knowledge base / invite codes |
| `ARCHITECTURE.md` | This document |

---

## 11. Request sequence

```mermaid
sequenceDiagram
    participant U as Browser
    participant W as Worker
    participant DB as D1 (legal-assistant-users)
    participant V as Vectorize (legal-kb)
    participant E as SiliconFlow (bge-m3)
    participant D as DeepSeek

    U->>W: GET /
    W-->>U: Q&A UI (with invite gate)

    U->>W: POST /verify { code, device_id }
    W->>DB: Check invite_codes; if valid, upsert sessions unconditionally (kicks out the current user)
    DB-->>W: OK / invalid · revoked · over limit
    W-->>U: 200 {ok:true, session_token} / 401 {error}

    U->>W: POST /legal { messages } [X-Invite-Code, X-Session-Token]
    W->>DB: Check invite_codes state
    alt code invalid / revoked / over limit
        W-->>U: 401 {error}
    else code valid
        W->>DB: Does sessions.session_token match?
        alt session taken by another device
            W-->>U: 409 {error}
            Note over U: Frontend returns to the gate and clears the local session; no auto-reconnect.<br/>The user must re-enter the code to reclaim it.
        else session matches
            W->>DB: Atomic UPDATE used_count (limit check)
            W->>E: Embed question (bge-m3)
            E-->>W: 1024-dim vector
            W->>V: query(vector, topK=6, returnMetadata=all)
            V-->>W: top-6 articles (text / source in metadata)
            W->>D: system (prompt + articles) + conversation, stream
            D-->>W: SSE answer stream
            W-->>U: SSE pass-through + X-Legal-Hits header
        end
    end
```
