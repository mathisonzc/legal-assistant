#!/usr/bin/env python3
"""
Phase 0 pilot: split the law Markdown files listed in laws.json (from just-laws)
into one knowledge chunk per article.

Writes kb/chunks.json. Each chunk looks like:
  {
    "id": "<short law name>-<article no>[-<book>]",
    "law": "<full law name>",
    "bian": "<book; Civil Code only, empty otherwise>",
    "zhang": "<chapter heading>",
    "article_no": 8,          # article number as an int (for exact lookup / sorting)
    "article_cn": "<article label in Chinese numerals>",
    "flxz": "<legal force level>",
    "zdjg": "<enacting authority>",
    "xiaoli": "<validity status>",
    "source": "https://raw.githubusercontent.com/ImCa0/just-laws/...",
    "text": "<original article text, used for display and citation>",
    "embed_text": "<law name + book + chapter + article text, used for embedding>"
  }

Only fetches and chunks; embedding happens in kb/embed.py (needs an API key).
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LAWS = json.loads((HERE / "laws.json").read_text(encoding="utf-8"))
BASE = LAWS["source_repo"]

# Chinese numerals -> int (up to 1260, enough for the 1260 articles of the Civil Code)
CN_DIGIT = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
            "六": 6, "七": 7, "八": 8, "九": 9, "两": 2}
CN_UNIT = {"十": 10, "百": 100, "千": 1000}


def cn2int(s: str) -> int:
    s = s.strip()
    if not s:
        return -1
    total, section, number = 0, 0, 0
    for ch in s:
        if ch in CN_DIGIT:
            number = CN_DIGIT[ch]
        elif ch in CN_UNIT:
            unit = CN_UNIT[ch]
            if number == 0:
                number = 1  # a bare "ten" means 10, "ten-one" means 11
            section += number * unit
            number = 0
        else:
            return -1
    return total + section + number


import time

RAW_DIR = HERE / "raw"


def fetch(url: str) -> str:
    # Cache raw files locally so reruns skip the network
    cache = RAW_DIR / url.split("just-laws/master/")[-1].replace("/", "__")
    if cache.exists():
        return cache.read_text(encoding="utf-8")
    RAW_DIR.mkdir(exist_ok=True)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kb-builder"})
            with urllib.request.urlopen(req, timeout=40) as r:
                txt = r.read().decode("utf-8")
            cache.write_text(txt, encoding="utf-8")
            return txt
        except Exception as e:  # noqa
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"fetch failed after retries: {url}: {last}")


# Start of an article: a bold "Article X" marker at line start; also chapter and section headings
ART_RE = re.compile(r"^\*\*第([一二三四五六七八九十百千零两]+)条\*\*[　\s]*(.*)$")
ZHANG_RE = re.compile(r"^##\s+(第[一二三四五六七八九十百千零两]+章[　\s]*.*)$")
JIE_RE = re.compile(r"^###\s+(第[一二三四五六七八九十百千零两]+节[　\s]*.*)$")


def parse_law(law_meta) -> list:
    chunks = []
    law_name = law_meta["name"]
    for src in law_meta["sources"]:
        url = BASE + src["file"]
        bian = src.get("bian", "")
        text = fetch(url)
        lines = text.split("\n")

        # Skip YAML frontmatter
        if lines and lines[0].strip() == "---":
            end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), 0)
            lines = lines[end + 1:]

        cur_zhang = ""
        cur = None  # article currently being accumulated

        def flush():
            nonlocal cur
            if cur is None:
                return
            body = "\n".join(cur["body"]).strip()
            full = f"{cur['article_cn']}　{body}" if body else cur["article_cn"]
            ctx = " ".join(x for x in [f"《{law_name}》", bian, cur_zhang] if x)
            # The id drops the common "People's Republic of China" prefix from the law name
            chunks.append({
                "id": f"{law_name.replace('中华人民共和国', '')}-{cur['no']}" + (f"-{bian.split()[0]}" if bian else ""),
                "law": law_name,
                "bian": bian,
                "zhang": cur_zhang,
                "article_no": cur["no"],
                "article_cn": cur["article_cn"],
                "flxz": law_meta["flxz"],
                "zdjg": law_meta["zdjg"],
                "xiaoli": law_meta["xiaoli"],
                "source": url,
                "text": full,
                "embed_text": f"{ctx} {cur['article_cn']} {body}".strip(),
            })
            cur = None

        for ln in lines:
            s = ln.rstrip()
            mz = ZHANG_RE.match(s)
            if mz:
                flush()
                cur_zhang = re.sub(r"\s+", " ", mz.group(1)).strip()
                continue
            if JIE_RE.match(s):
                flush()  # sections fold into the chapter context; not tracked separately
                continue
            ma = ART_RE.match(s)
            if ma:
                flush()
                no = cn2int(ma.group(1))
                cur = {"no": no, "article_cn": f"第{ma.group(1)}条", "body": []}
                if ma.group(2).strip():
                    cur["body"].append(ma.group(2).strip())
                continue
            if cur is not None:
                if s.strip():
                    cur["body"].append(s.strip())
        flush()
    return chunks


def main():
    all_chunks = []
    for law in LAWS["laws"]:
        cs = parse_law(law)
        print(f"  {law['name']}: {len(cs)} articles")
        all_chunks.extend(cs)
    out = HERE / "chunks.json"
    out.write_text(json.dumps(all_chunks, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nTotal {len(all_chunks)} articles -> {out}")
    # Sanity check
    bad = [c for c in all_chunks if c["article_no"] < 0]
    if bad:
        print(f"⚠️ {len(bad)} article numbers failed to parse:", [c['id'] for c in bad[:5]])


if __name__ == "__main__":
    main()
