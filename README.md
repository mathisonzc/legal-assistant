# Legal Assistant

A **mainland China legal Q&A** app running on a **Cloudflare Worker**. It uses **RAG (retrieval-augmented generation)**: the user's question is embedded, the most relevant law articles are retrieved from a vector index, and **DeepSeek** writes an answer that cites each article it relies on.

- Generation model: DeepSeek `deepseek-v4-flash`
- Embedding model: SiliconFlow `BAAI/bge-m3` (1024 dimensions, strong on Chinese)
- Vector store: Cloudflare Vectorize
- Access control: invite codes, state kept in Cloudflare D1
- Pilot coverage: Civil Code, Labor Law, Labor Contract Law, Consumer Rights Protection Law, Road Traffic Safety Law, **1652 articles** in total

> The UI, the system prompt, and the law data are in Simplified Chinese because the app answers questions about Chinese law. All user-facing text lives in [`src/locale/zh-CN.ts`](src/locale/zh-CN.ts).

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Project layout](#project-layout)
- [Building the knowledge base](#building-the-knowledge-base)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Invite codes](#invite-codes)
- [API](#api)
- [Configuration](#configuration)
- [Operations](#operations)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [License](#license)

---

## Features

- ⚖️ Ask about mainland China law; answers give the conclusion first, then the basis, **citing each article by law name and article number**
- 🔍 Semantic retrieval: bge-m3 embeddings + Cloudflare Vectorize
- 📎 **Transparent references**: each answer lists the articles actually retrieved (`X-Legal-Hits` header)
- 🛡️ Anti-hallucination: the system prompt forces answers to rely only on retrieved articles, forbids inventing article numbers, and appends a disclaimer
- ⚡ Streaming responses (SSE)
- 🎟️ Invite-code access control, enforced server-side (D1: usage limits / revocation / one user online at a time)
- 🔒 All keys are Cloudflare Secrets, never committed

---

## Architecture

```
Browser
    │ HTTPS (question)
    ▼
Cloudflare Edge ── Worker
    │  ① Check invite code + session (D1)
    │  ② Question → SiliconFlow bge-m3 embedding ──────────▶ api.siliconflow.cn
    │  ③ Vectorize query, top-6 articles with metadata
    │  ④ System prompt + retrieved articles + conversation → DeepSeek (stream) ─▶ api.deepseek.com
    ▼
Browser ◀── SSE answer stream (+ X-Legal-Hits header)
```

Three RAG steps: **embed → retrieve → generate**. DeepSeek only generates; retrieval happens at the edge. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for details.

---

## Project layout

```
legal-assistant/
├── src/
│   ├── index.ts            # Worker: routing + invite codes (D1) + RAG retrieval + /legal + embedded frontend
│   └── locale/zh-CN.ts     # all user-facing text and the system prompt
├── kb/                     # knowledge base build (offline, not part of the Worker runtime)
│   ├── laws.json           # pilot law list + metadata
│   ├── build_chunks.py     # fetch law Markdown → split per article → chunks.json
│   ├── embed.py            # chunks.json → bge-m3 vectors → vectors.ndjson (for Vectorize)
│   ├── chunks.json         # chunk output (human-readable)
│   └── raw/                # cached source files
├── db/
│   └── schema.sql          # D1 tables: invite_codes / sessions
├── scripts/
│   └── apply-codes.mjs     # invite-codes.txt → D1 (npm run apply-codes)
├── invite-codes.txt.example
├── .dev.vars.example
├── wrangler.toml           # Worker config: vars, Vectorize and D1 bindings
└── package.json            # dev / deploy / apply-codes scripts
```

Stack: TypeScript + Cloudflare Workers + Wrangler 3.x; the offline build scripts use Python 3.

---

## Building the knowledge base

The law data is built offline and imported into Vectorize.

```
Official metadata (flk.npc.gov.cn conventions) + open-source text (GitHub just-laws)
        │  kb/laws.json declares which laws to include
        ▼
python3 kb/build_chunks.py                  # fetch + split per article → kb/chunks.json
        ▼
SILICONFLOW_KEY=sk-xxx python3 kb/embed.py  # bge-m3 embeddings → kb/vectors.ndjson
        ▼
npx wrangler vectorize insert legal-kb --file=kb/vectors.ndjson   # first import
npx wrangler vectorize upsert legal-kb --file=kb/vectors.ndjson   # later updates
```

- **Granularity**: one article = one chunk, with metadata (law name / book / chapter / article number / force level / validity / source).
- **Text source**: the open-source repo [`ImCa0/just-laws`](https://github.com/ImCa0/just-laws), a clean mirror of the official texts.
- **Adding laws**: add entries to `kb/laws.json` and rerun the steps above. Chunk ids are stable (`<law>-<article no>`), so `upsert` overwrites instead of duplicating.

---

## Local development

```bash
npm install

cp .dev.vars.example .dev.vars          # fill in your keys (never commit .dev.vars)
cp invite-codes.txt.example invite-codes.txt

npx wrangler d1 execute legal-assistant-users --local --file=db/schema.sql
npm run apply-codes:local               # load invite codes into the local D1

npm run dev                             # wrangler dev
npx tsc --noEmit                        # type check
```

Vectorize has no local emulation; `wrangler dev` needs `--remote` (or a deployed index) for retrieval to work.

---

## Deployment

### 0. Log in to Cloudflare (once)

```bash
npx wrangler login
npx wrangler whoami
```

### 1. Set secrets

```bash
echo "sk-your-deepseek-key"    | npx wrangler secret put LLM_API_KEY
echo "sk-your-siliconflow-key" | npx wrangler secret put EMBED_API_KEY
```

### 2. Create the Vectorize index and import vectors (once)

```bash
npx wrangler vectorize create legal-kb --dimensions=1024 --metric=cosine
npx wrangler vectorize insert legal-kb --file=kb/vectors.ndjson
```

### 3. Create the D1 database (once)

```bash
npx wrangler d1 create legal-assistant-users
# put the printed database_id into the [[d1_databases]] block in wrangler.toml
npx wrangler d1 execute legal-assistant-users --remote --file=db/schema.sql
npm run apply-codes
```

### 4. Deploy the Worker

```bash
npx wrangler deploy
```

To serve it on your own domain, uncomment the `[[routes]]` block in `wrangler.toml`. With `custom_domain = true`, `wrangler deploy` creates the DNS record and certificate for you.

### 5. Verify

Open the Worker URL, enter an invite code, and ask a question. Or with curl (get a `session_token` from `/verify` first, then call `/legal` with the headers):

```bash
URL=https://<your-worker>.workers.dev
DEVICE=test-device-1
TOKEN=$(curl -s $URL/verify \
  -H "Content-Type: application/json" \
  -d "{\"code\":\"your-invite-code\",\"device_id\":\"$DEVICE\"}" | jq -r .session_token)

curl -sN $URL/legal \
  -H "Content-Type: application/json" \
  -H "X-Invite-Code: your-invite-code" -H "X-Device-Id: $DEVICE" -H "X-Session-Token: $TOKEN" \
  -d '{"question":"<your question>"}'
```

---

## Invite codes

The service requires a **valid invite code**, checked **server-side**: `/legal` returns 401/409 without a valid code and session, so the underlying models cannot be reached by bypassing the page. Each code has its own state in **Cloudflare D1**:

- **Usage limit**: optional cap on total uses, so a leaked code cannot run up the DeepSeek bill
- **Revocation**: disable a single code without affecting others
- **One user online at a time (last login wins)**: each code has a single session. Anyone who calls `/verify` with the code **takes over** the session. The previous holder gets a 409 on their next request; the UI returns to the gate and clears the local session. Reclaiming the session requires typing the code again. There is deliberately no automatic reconnect, otherwise a kicked-out user would immediately kick the other person back
- **Anonymous `device_id`**: a random id generated and stored by the browser. It is only a local identifier; it does not take part in authorization and is never used to reconnect automatically

Codes are kept in a plain text file and synced with one command:

```bash
npm run apply-codes    # invite-codes.txt → upsert into D1 (--remote)
```

File format, one per line, `code[,max_uses][,status]`:

```
CODE-XXXXXX-YYYYYY            # unlimited, active
CODE-XXXXXX-YYYYYY,100        # limited to 100 uses, active
CODE-XXXXXX-YYYYYY,,revoked   # revoked
```

| Task | How |
|------|-----|
| List codes | open `invite-codes.txt` |
| Add / change limit / revoke | edit the file → `npm run apply-codes` (only `max_uses`/`status` change; usage is kept) |
| Generate a random code | `echo "CODE-$(openssl rand -hex 3 \| tr 'a-f' 'A-F')-$(openssl rand -hex 3 \| tr 'a-f' 'A-F')"` |
| See who is online for a code | `npx wrangler d1 execute legal-assistant-users --remote --command "SELECT * FROM sessions WHERE code='<code>'"` |

> `invite-codes.txt` is git-ignored and is the source of truth for configuration. `used_count` and sessions are runtime state that only lives in D1.

---

## API

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Q&A web page |
| `/verify` | POST | Check the invite code and take over the session; returns `{ok:true, session_token}` (200) or `{error}` (401) |
| `/legal` | POST | Streaming legal RAG answer (SSE); **requires a valid invite code and session** |

### `/verify` request

```jsonc
{ "code": "invite code", "device_id": "anonymous id generated and stored by the browser" }
```

On failure it returns 401 with an `error` field: invalid / revoked / usage limit reached. On success it always issues a new `session_token` and kicks out whoever was online.

### `/legal` request

Send `X-Invite-Code: <code>` and `X-Session-Token: <token from /verify>` (the code may also go in the body as `"code"`; the session token must be a header). The frontend also sends `X-Device-Id`, but the server only checks whether the session token matches the current session.

```jsonc
{ "question": "..." }                                 // single question
{ "messages": [ {"role":"user","content":"..."} ] }  // multi-turn
{ "question": "...", "topK": 8 }                      // optional: number of articles (default 6, max 12)
```

- `401`: invite code invalid / revoked / over limit
- `409`: code is valid but the session was taken by another device; the UI returns to the gate and the user must re-enter the code

### `/legal` response

OpenAI-compatible SSE stream. The `X-Legal-Hits` header carries the retrieved articles (`<law> <article> | ...`, URL-encoded).

---

## Configuration

### `wrangler.toml` → `[vars]` (public)

| Variable | Value |
|----------|-------|
| `LLM_BASE_URL` | `https://api.deepseek.com` |
| `LLM_MODEL` | `deepseek-v4-flash` |
| `EMBED_BASE_URL` | `https://api.siliconflow.cn/v1` |
| `EMBED_MODEL` | `BAAI/bge-m3` |

### Bindings

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "legal-kb"

[[d1_databases]]
binding = "DB"
database_name = "legal-assistant-users"
database_id = "<your-database-id>"
```

### Secrets

| Variable | How to set |
|----------|------------|
| `LLM_API_KEY` | `echo "sk-..." \| npx wrangler secret put LLM_API_KEY` |
| `EMBED_API_KEY` | `echo "sk-..." \| npx wrangler secret put EMBED_API_KEY` |

### Text and prompt

Edit [`src/locale/zh-CN.ts`](src/locale/zh-CN.ts) to change the UI text, error messages, example questions, or the LLM system prompt.

---

## Operations

```bash
npx wrangler deploy         # redeploy after code changes
npx wrangler tail           # live logs
npm run apply-codes         # update invite codes

# Add laws: edit kb/laws.json, then
python3 kb/build_chunks.py
SILICONFLOW_KEY=sk-xxx python3 kb/embed.py
npx wrangler vectorize upsert legal-kb --file=kb/vectors.ndjson
```

---

## Roadmap

- **Now (Phase 0 pilot)**: 6 core laws, 1652 articles, Vectorize retrieval.
- **Accuracy**: rerank top-k with `bge-reranker`; cover more laws.
- **Full coverage (Phase 1/2)**: mainland China has about 17,000 laws and regulations (200k–500k articles). Vectorize removes the scale limit; the remaining work is bulk enumeration and full-text retrieval from the official database flk.npc.gov.cn (its list API is encrypted).

---

## FAQ

**Q: Will the model make up articles?**
The system prompt requires answers to rely only on retrieved articles, cite each one, say so when the articles are insufficient, and never invent article numbers. It also appends a disclaimer. The references shown above each answer are the articles actually retrieved, so they can be checked.

**Q: How do I add or replace laws?**
Edit `kb/laws.json`, rerun `build_chunks.py` and `embed.py`, then `wrangler vectorize upsert`.

**Q: Commands hang behind a local proxy?**
Wrangler warns `Proxy environment variables detected`. Add `--noproxy "*"` to curl for mainland China endpoints such as SiliconFlow; `embed.py` already bypasses the proxy.

**Q: Can I use a different vector store?**
Replace `embedQuery` / `searchKB` in `src/index.ts`. The generation step and the frontend do not need changes.

---

## License

[MIT](LICENSE)

> This project is for information retrieval only. Answers are not legal advice; always check the official current text and consult a qualified lawyer.
