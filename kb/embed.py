#!/usr/bin/env python3
"""
Read kb/chunks.json, embed each chunk with SiliconFlow bge-m3, and write NDJSON
for importing into Cloudflare Vectorize with wrangler.

Writes kb/vectors.ndjson, one row per chunk:
  {"id": "...", "values": [1024 floats], "metadata": {law, article_cn, zhang, bian, xiaoli, text, source}}

Usage:
  SILICONFLOW_KEY=sk-xxx python3 kb/embed.py
  npx wrangler vectorize insert legal-kb --file=kb/vectors.ndjson   # first import
  npx wrangler vectorize upsert legal-kb --file=kb/vectors.ndjson   # later updates (same id overwrites)

Create the index once before the first import:
  npx wrangler vectorize create legal-kb --dimensions=1024 --metric=cosine
"""
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY = os.environ.get("SILICONFLOW_KEY", "").strip()
if not KEY:
    sys.exit("SILICONFLOW_KEY environment variable is not set")

API = "https://api.siliconflow.cn/v1/embeddings"
MODEL = "BAAI/bge-m3"
BATCH = 32
METADATA_FIELDS = ("law", "article_cn", "zhang", "bian", "xiaoli", "text", "source")

# Bypass any local proxy (SiliconFlow is a mainland China endpoint)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def embed_batch(texts):
    body = json.dumps({"model": MODEL, "input": texts}).encode("utf-8")
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    for attempt in range(5):
        try:
            with opener.open(req, timeout=60) as r:
                d = json.loads(r.read().decode("utf-8"))
            return [item["embedding"] for item in sorted(d["data"], key=lambda x: x["index"])]
        except Exception as e:  # noqa
            wait = 3 * (attempt + 1)
            print(f"    retry {attempt+1}: {e} (waiting {wait}s)")
            time.sleep(wait)
    raise RuntimeError("embed batch failed")


def main():
    chunks = json.loads((HERE / "chunks.json").read_text(encoding="utf-8"))
    print(f"Embedding {len(chunks)} chunks, batch={BATCH}")
    out = HERE / "vectors.ndjson"
    t0 = time.time()
    with out.open("w", encoding="utf-8") as f:
        for i in range(0, len(chunks), BATCH):
            batch = chunks[i:i + BATCH]
            embs = embed_batch([c["embed_text"] for c in batch])
            for c, e in zip(batch, embs):
                row = {
                    "id": c["id"],
                    "values": e,
                    "metadata": {k: c[k] for k in METADATA_FIELDS},
                }
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
            done = min(i + BATCH, len(chunks))
            print(f"  {done}/{len(chunks)}  ({time.time()-t0:.0f}s)")

    mb = out.stat().st_size / 1024 / 1024
    print(f"\n✅ {len(chunks)} chunks -> {out}  ({mb:.2f} MB)")
    print("Next steps:")
    print("  npx wrangler vectorize create legal-kb --dimensions=1024 --metric=cosine  # first time only")
    print("  npx wrangler vectorize insert legal-kb --file=kb/vectors.ndjson")


if __name__ == "__main__":
    main()
