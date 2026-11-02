#!/usr/bin/env python3
"""Measure Spinner docs against the house subset of ASD-STE100.

Usage:
  python3 tools/doc-metrics.py                 # summary for README, docs/, examples/
  python3 tools/doc-metrics.py docs/ROADMAP.md # one file, with every long sentence listed
  python3 tools/doc-metrics.py --fail          # exit 1 if a procedure breaks the 20-word rule
  python3 tools/doc-metrics.py --fail --strict # also fail descriptions over 25 words

Procedures (BRIEF.md, RUN.md, WRITING.md): 20 words per sentence.
Descriptions (everything else): 25 words per sentence, 6 sentences per paragraph.
Heuristics only. The tool finds candidates; a person decides.
"""
import collections
import os
import re
import sys

PROCEDURAL_NAMES = {"BRIEF.md", "RUN.md", "WRITING.md"}
UNAPPROVED = {
    "should": "must / can", "may": "can / is permitted", "shall": "must",
    "ensure": "make sure", "utilize": "use", "prior to": "before",
    "in order to": "to", "leverage": "use", "via": "through / with",
    "whether": "if", "as well as": "and", "e.g.": "for example",
    "i.e.": "that is", "etc.": "(list the items)", "and/or": "(say which)",
    "simply": "(delete)", "basically": "(delete)", "therefore": "so",
    "however": "but", "upon": "on", "whilst": "while",
}
IRREGULAR = (
    "built made done kept written sent run set put read given taken seen known "
    "shown chosen driven held left found told won begun led met spent lost bound "
    "fed hit cut split brought thought caught understood meant paid said sold "
    "sought worn hidden drawn grown thrown gone rebuilt rerun reread overwritten"
).split()
ING_OK = set(
    "thing something nothing anything everything during string bring ring spring "
    "ping morning evening king sing wing building setting pending missing existing "
    "following remaining underlying ongoing incoming".split()
)


def strip_markdown(text):
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", "CODE", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*|__", "", text)
    return text


def blocks(text):
    """Yield (kind, text) for paragraphs, list items, and table cells."""
    para = []
    for line in text.split("\n"):
        s = line.strip()
        if not s or s.startswith("#"):
            if para:
                yield "para", " ".join(para)
                para = []
            continue
        if s.startswith("|"):
            if para:
                yield "para", " ".join(para)
                para = []
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r":?-+:?", c) for c in cells if c):
                continue
            for c in cells:
                if c:
                    yield "cell", c
            continue
        if re.match(r"^(-|\*|\d+\.)\s", s):
            if para:
                yield "para", " ".join(para)
                para = []
            yield "item", re.sub(r"^(-|\*|\d+\.)\s+", "", s)
            continue
        para.append(s.lstrip("> ").strip())
    if para:
        yield "para", " ".join(para)


def sentences(text):
    text = re.sub(r"\s+", " ", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'(])", text)
    return [p.strip() for p in parts if len(p.split()) >= 3]


def words(s):
    return re.findall(r"[A-Za-z][A-Za-z'\-]*", s)


def analyse(path):
    text = strip_markdown(open(path, encoding="utf-8").read())
    procedural = os.path.basename(path) in PROCEDURAL_NAMES
    limit = 20 if procedural else 25
    r = {
        "procedural": procedural, "limit": limit, "sentences": 0, "long": [],
        "passive": [], "ing": collections.Counter(),
        "unapproved": collections.Counter(), "long_paras": 0, "max": 0,
    }
    passive_re = re.compile(
        r"\b(is|are|was|were|be|been|being|gets?|got)\s+(\w+ly\s+)?(\w+ed|"
        + "|".join(IRREGULAR) + r")\b"
    )
    for kind, b in blocks(text):
        ss = [b] if kind == "cell" else sentences(b)
        if kind == "para" and len(ss) > 6:
            r["long_paras"] += 1
        for s in ss:
            n = len(words(s))
            if kind == "cell" and n < 3:
                continue
            r["sentences"] += 1
            r["max"] = max(r["max"], n)
            if n > limit:
                r["long"].append((n, s))
            low = s.lower()
            r["passive"].extend(m.group(0) for m in passive_re.finditer(low))
            for m in re.finditer(r"\b([a-z]+ing)\b", low):
                if m.group(1) not in ING_OK:
                    r["ing"][m.group(1)] += 1
            for k in UNAPPROVED:
                if re.search(r"\b" + re.escape(k) + r"(?![\w-])", low):
                    r["unapproved"][k] += 1
    return r


# EGM design docs under docs/designs/ follow EGM's document standards, not WRITING.md, so the
# checker skips that directory (docs/designs/README.md says why).
DESIGNS_DIR = os.path.join("docs", "designs")


def collect(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                if root.startswith(DESIGNS_DIR):
                    continue
                for f in sorted(files):
                    if f.endswith(".md"):
                        yield os.path.join(root, f)
        elif p.endswith(".md"):
            yield p


def main(argv):
    fail = "--fail" in argv
    strict = "--strict" in argv
    paths = [a for a in argv if not a.startswith("--")] or ["README.md", "docs", "examples"]
    files = list(collect(paths))
    verbose = len(files) == 1
    bad = 0
    total = long_total = 0
    print(f"{'file':<58} {'type':<4} {'sent':>5} {'over':>5} {'max':>4} {'pass':>5} {'-ing':>5}")
    for f in files:
        r = analyse(f)
        total += r["sentences"]
        long_total += len(r["long"])
        kind = "proc" if r["procedural"] else "desc"
        print(f"{f:<58} {kind:<4} {r['sentences']:>5} {len(r['long']):>5} {r['max']:>4} "
              f"{len(r['passive']):>5} {sum(r['ing'].values()):>5}")
        if r["long"] and (r["procedural"] or strict):
            bad += len(r["long"])
        if verbose:
            for n, s in sorted(r["long"], reverse=True):
                print(f"   {n:>3}w  {s}")
            if r["unapproved"]:
                print("   unapproved:", ", ".join(f"{k} ({v}) -> {UNAPPROVED[k]}" for k, v in r["unapproved"].most_common()))
            if r["ing"]:
                print("   -ing:", ", ".join(f"{k} ({v})" for k, v in r["ing"].most_common(10)))
            if r["passive"]:
                print("   passive:", "; ".join(r["passive"][:12]))
    pct = 100 * long_total / total if total else 0
    print(f"\n{total} sentences, {long_total} over limit ({pct:.0f}%).")
    if fail and bad:
        print(f"FAIL: {bad} sentence(s) over the limit in {'all files' if strict else 'procedures'}.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
