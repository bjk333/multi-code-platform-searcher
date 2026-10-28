#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多轮调研编排器（research rounds orchestrator）—— 给 multi-code-platform-searcher 补"多轮"这一层。

为什么需要它：
  现有技能是"一次查询 → 多源并发"，没有"轮"的概念：
    · 第一轮找到的候选，不会在第二轮被逐个核验（license/最近提交/代码证据）；
    · 覆盖不足的轴（缺 license、只有 1 个平台、没有实现证据）不会自动生成补查；
    · 多智能体并行时，没有稳定的工单格式与合并规则。

本器只做三件事：
  1) 生成 N 条 lane 工单（每条 = 一个可独立执行的检索任务，含精确命令与输出契约）；
  2) 执行（或合并外部 agent 的结果），按 EntityKey 去重、保留每条的来源与证据；
  3) 计算覆盖缺口，生成下一轮查询；跑满轮次或预算后出 ledger + report。

不做什么：
  · 不替代主脚本的检索/评分；所有检索都调 mcps.py（或显式 --runner ps1）；
  · 不调用任何 LLM；lane 查询是确定性模板，避免"同一 brief 两次跑出不同计划"；
  · 不把 0 命中写成"不存在"——每轮都保留 verdict / blocked / degraded。

用法：
  python research_rounds.py --brief "agent skill registry" --out reports/rr-2026-10-25
  python research_rounds.py --brief "..." --out ... --execute --rounds 3 --budget-sec 240
  python research_rounds.py --self-test
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = "research-rounds/v1"


# ---------------------------------------------------------------- 纯函数（可单测）

def slugify(text: str, limit: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    if not s:
        s = "brief-" + hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:8]
    return s[:limit].strip("-")


def build_lanes(brief: str, lanes: int = 4, terms: str | None = None) -> list[dict]:
    """确定性 lane 模板。第 4 条起用 'similar' 变体，保证 lanes 可调且不重复。"""
    base = (terms or brief).strip()
    templates = [
        ("discover", "仓库发现", "{q}"),
        ("implement", "实现证据", "{q} implementation"),
        ("compare", "替代方案", "{q} alternatives"),
        ("ecosystem", "生态清单", "{q} awesome"),
    ]
    out = []
    for i in range(max(1, lanes)):
        kind, label, tpl = templates[i % len(templates)]
        suffix = "" if i < len(templates) else f" {i // len(templates) + 1}"
        out.append({
            "lane": i + 1,
            "kind": kind,
            "label": label,
            "query": tpl.format(q=base) + suffix,
            "platform": "All",
            "minStars": 50,
            "limit": 6,
        })
    return out


def candidate_key(item: dict) -> str:
    key = (item.get("EntityKey") or item.get("Name") or item.get("Url") or "").strip().lower()
    return re.sub(r"^https?://(www\.)?", "", key).rstrip("/")


def normalize_candidate(item: dict, lane: dict) -> dict:
    stars = item.get("Stars")
    try:
        stars = int(stars) if stars is not None else 0
    except (TypeError, ValueError):
        stars = 0
    return {
        "key": candidate_key(item),
        "name": item.get("Name") or item.get("EntityKey") or "",
        "url": item.get("Url") or "",
        "platform": item.get("Platform") or "",
        "stars": stars,
        "license": item.get("License") or None,
        "updated": item.get("Updated") or None,
        "archived": bool(item.get("Archived")),
        "relaxed": item.get("Relaxed") or None,
        "noise": bool(item.get("NoiseFlagged")),
        "matchTerms": list(item.get("MatchTerms") or []),
        "desc": (item.get("Desc") or "")[:300],
        "relevance": float(item.get("Relevance") or 0),
        "popularity": float(item.get("Popularity") or 0),
        "lanes": [lane["lane"]],
        "lane_labels": [lane["label"]],
        "sources": [item.get("Platform") or "unknown"],
    }


def merge_candidates(existing: dict, incoming: list[dict]) -> dict:
    """按 key 合并：星数取 max，license/updated 取首个非空，lanes/sources 去重。"""
    for c in incoming:
        k = c["key"]
        if not k:
            continue
        if k not in existing:
            existing[k] = dict(c)
            continue
        cur = existing[k]
        cur["stars"] = max(cur.get("stars", 0), c.get("stars", 0))
        cur["relevance"] = max(cur.get("relevance", 0), c.get("relevance", 0))
        cur["popularity"] = max(cur.get("popularity", 0), c.get("popularity", 0))
        for f in ("license", "updated", "url", "desc"):
            if not cur.get(f) and c.get(f):
                cur[f] = c[f]
        cur["archived"] = bool(cur.get("archived")) and bool(c.get("archived"))
        if cur.get("relaxed") and not c.get("relaxed"):
            cur["relaxed"] = None
        cur["noise"] = bool(cur.get("noise")) and bool(c.get("noise"))
        for f in ("lanes", "lane_labels", "sources"):
            for v in c.get(f, []):
                if v not in cur[f]:
                    cur[f].append(v)
    return existing


def rank_candidates(cands: dict, limit: int = 15) -> list[dict]:
    vals = list(cands.values())
    max_stars = max([c.get("stars", 0) for c in vals] or [0]) or 1

    def score(c):
        base = 0.65 * c.get("relevance", 0) + 0.35 * (c.get("stars", 0) / max_stars)
        # 置信惩罚：放宽过滤（drop-stars 等）说明该条不满足原门槛；噪声标记同理。
        # 这不是"排序偏好"，是把主脚本已经标注的降级如实反映到排序里。
        if c.get("relaxed"):
            base *= 0.5
        if c.get("noise"):
            base *= 0.4
        if not c.get("relevance"):
            base *= 0.5
        return base

    vals.sort(key=lambda c: (score(c), c.get("stars", 0)), reverse=True)
    for i, c in enumerate(vals):
        c["rank"] = i + 1
        c["score"] = round(score(c), 4)
    return vals[:limit]


def license_ok(c: dict) -> bool:
    lic = (c.get("license") or "").strip().upper()
    return lic not in ("", "NOASSERTION", "UNKNOWN", "OTHER", "NONE")


def gap_axes(candidates: list[dict], coverage: dict) -> list[dict]:
    """缺口 = 事实，不是猜测。每条带证据。"""
    gaps = []
    top = candidates[:10]
    no_license = [c["name"] for c in top if not license_ok(c)]
    if no_license:
        gaps.append({"axis": "license", "reason": "前 10 候选缺可判定 license", "items": no_license[:5],
                     "query": "", "severity": "high"})
    platforms = sorted({c.get("platform") for c in candidates if c.get("platform")})
    if len(platforms) < 2:
        gaps.append({"axis": "platform", "reason": f"仅 {len(platforms)} 个平台产出", "items": platforms,
                     "query": "similar projects github gitee gitlab", "severity": "high"})
    no_code = [c["name"] for c in top if not c.get("codeEvidence")]
    if no_code:
        gaps.append({"axis": "code_evidence", "reason": "前 10 候选缺代码证据", "items": no_code[:5],
                     "query": "implementation", "severity": "medium"})
    relaxed = [c["name"] for c in candidates if c.get("relaxed")]
    if relaxed:
        gaps.append({"axis": "confidence", "reason": "结果被放宽过滤（低于 MinStars 门槛）",
                     "items": relaxed[:5], "query": "", "severity": "high"})
    blocked = coverage.get("blocked") or []
    if blocked:
        gaps.append({"axis": "blocked_sources", "reason": "部分源被阻断", "items": blocked[:5],
                     "query": "mirror alternative", "severity": "medium"})
    return gaps


def merge_coverage(runs: list[dict]) -> dict:
    req, exe, blocked, degraded, reasons = [], [], [], [], []
    verdicts = []
    for r in runs:
        cov = (r.get("json") or {}).get("coverage") or {}
        for x in cov.get("Requested") or []:
            if x not in req:
                req.append(x)
        for x in cov.get("Executed") or []:
            if x not in exe:
                exe.append(x)
        for x in cov.get("Blocked") or []:
            if x not in blocked:
                blocked.append(x)
        for x in cov.get("Degraded") or []:
            if x not in degraded:
                degraded.append(x)
        for x in cov.get("Reasons") or []:
            if x not in reasons:
                reasons.append(x)
        if cov.get("Verdict"):
            verdicts.append(cov["Verdict"])
    verdict = "full" if verdicts and all(v == "full" for v in verdicts) else (
        "none" if (not verdicts or all(v == "none" for v in verdicts)) else "partial")
    return {"requested": req, "executed": exe, "blocked": blocked,
            "degraded": degraded, "reasons": reasons, "verdict": verdict}


def render_report(meta: dict, lanes: list[dict], runs: list[dict], candidates: list[dict],
                  coverage: dict, gaps: list[dict]) -> str:
    L = []
    L.append(f"# 多轮调研报告：{meta['brief']}")
    L.append("")
    L.append(f"> 生成：{meta['generatedAt']} ｜ 轮次：{meta.get('roundsExecuted', meta['rounds'])}/{meta['rounds']} ｜ "
             f"lane：{len(lanes)} ｜ 预算：{meta['budgetSec']}s ｜ 实际：{meta['elapsedSec']}s ｜ "
             f"判定：{coverage['verdict']}")
    L.append("")
    L.append("## 1. 候选（按相关性×星数排序）")
    L.append("")
    L.append("| # | 仓库 | 平台 | ★ | 最近提交 | License | 置信 | 代码证据 | 命中 lane |")
    L.append("|---:|---|---|---:|---|---|---|---|---|")
    for c in candidates:
        ce = c.get("codeEvidence")
        ce_txt = f"{ce['count']}/{ce['verdict']}" if ce else "-"
        conf = "噪声" if c.get("noise") else ("放宽星数" if c.get("relaxed") else "正常")
        lic = c.get("license") or ""
        lic_txt = lic if license_ok(c) else f"{lic or '缺'}（待核验）"
        L.append("| {rank} | [{name}]({url}) | {platform} | {stars} | {updated} | {license} | {conf} | {ce} | {lanes} |".format(
            rank=c.get("rank", ""), name=c.get("name", ""), url=c.get("url", ""),
            platform=c.get("platform", ""), stars=c.get("stars", 0),
            updated=(c.get("updated") or "")[:10], license=lic_txt,
            conf=conf, ce=ce_txt,
            lanes=",".join(str(x) for x in c.get("lane_labels", []))))
    L.append("")
    L.append("## 2. 每 lane 产出")
    L.append("")
    L.append("| lane | 查询 | rc | 耗时 | 结果数 | verdict | 失败原因 |")
    L.append("|---:|---|---:|---:|---:|---|---|")
    for r in runs:
        cov = (r.get("json") or {}).get("coverage") or {}
        who = (f"code:{r.get('repo')}" if r.get("kind") == "code_evidence"
               else str(r["lane"]))
        L.append("| {lane} | `{q}` | {rc} | {ms}ms | {n} | {v} | {why} |".format(
            lane=who, q=r["query"], rc=r["rc"], ms=r["elapsedMs"], n=r.get("count", 0),
            v=cov.get("Verdict") or ("timeout" if r["rc"] == 124 else ("error" if r["rc"] else "-")),
            why="; ".join(cov.get("Reasons") or [])[:120] or (r.get("error") or "-")[:120]))
    L.append("")
    L.append("## 3. 覆盖与缺口")
    L.append("")
    L.append(f"- Requested：{', '.join(coverage['requested']) or '无'}")
    L.append(f"- Executed：{', '.join(coverage['executed']) or '无'}")
    L.append(f"- Blocked：{', '.join(coverage['blocked']) or '无'}")
    L.append(f"- Degraded：{', '.join(coverage['degraded']) or '无'}")
    L.append("")
    if gaps:
        L.append("| 缺口 | 证据 | 下一轮查询 | 级别 |")
        L.append("|---|---|---|---|")
        for g in gaps:
            L.append(f"| {g['axis']} | {g['reason']}：{', '.join(g['items'])} | `{g['query']}` | {g['severity']} |")
    else:
        L.append("无结构性缺口（仅代表本轮覆盖，不代表事实完备）。")
    L.append("")
    L.append("## 4. 复现")
    L.append("")
    L.append("```bash")
    L.append(f"python research_rounds.py --brief \"{meta['brief']}\" --out <dir> --execute "
             f"--rounds {meta['rounds']} --budget-sec {meta['budgetSec']}")
    L.append("```")
    L.append("")
    L.append("> 本报告只汇总检索结果；license/活跃度来自上游 API，未做二次人工核验。"
             "0 命中不等于不存在——先看 Blocked/Degraded 与 verdict。")
    return "\n".join(L) + "\n"


def render_agent_work_order(lane: dict, brief: str) -> str:
    cmd = (f'python mcps.py -Keyword "{lane["query"]}" -Platform {lane["platform"]} '
           f'-MinStars {lane["minStars"]} -Limit {lane["limit"]} -AsJson --out lane-{lane["lane"]}.json')
    return f"""# Lane {lane['lane']}：{lane['label']}

- brief：{brief}
- 查询：`{lane['query']}`
- 目标：{lane['label']}（kind={lane['kind']}）

## 执行

```bash
{cmd}
```

## 返回契约

把 `lane-{lane['lane']}.json` 原样保留，并在同目录写 `lane-{lane['lane']}.result.json`：

```json
{{
  "lane": {lane['lane']},
  "query": "{lane['query']}",
  "rc": 0,
  "elapsedMs": 0,
  "json": {{ "results": [], "coverage": {{ "Requested": [], "Executed": [], "Blocked": [], "Reasons": [], "Verdict": "none" }} }}
}}
```

不要改写 results；不要补造字段。合并由 `python research_rounds.py --merge <dir>` 完成。
"""


# ---------------------------------------------------------------- 执行层

def _decode_json(path: str):
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            with io.open(path, encoding=enc) as f:
                return json.load(f)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise ValueError(f"无法解析 JSON：{path}")


def run_lane(lane: dict, out_dir: str, budget_left: float) -> dict:
    tmp = os.path.join(out_dir, "raw")
    os.makedirs(tmp, exist_ok=True)
    out_file = os.path.join(tmp, f"lane-{lane['lane']}.json")
    cmd = [sys.executable, os.path.join(HERE, "mcps.py"),
           "-Keyword", lane["query"], "-Platform", lane["platform"],
           "-MinStars", str(lane["minStars"]), "-Limit", str(lane["limit"]),
           "-AsJson", "--out", out_file]
    started = time.time()
    status = {"lane": lane["lane"], "query": lane["query"], "rc": None,
              "elapsedMs": 0, "count": 0, "json": None, "error": None}
    timeout = max(5.0, min(budget_left, 120.0))
    try:
        p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        status["rc"] = p.returncode
        if p.returncode != 0:
            status["error"] = (p.stderr or p.stdout or "")[-500:]
    except subprocess.TimeoutExpired:
        status["rc"] = 124
        status["error"] = f"lane 超时（{timeout:.0f}s）"
    status["elapsedMs"] = int((time.time() - started) * 1000)
    if status["rc"] == 0 and os.path.exists(out_file):
        try:
            status["json"] = _decode_json(out_file)
            status["count"] = len((status["json"] or {}).get("results") or [])
        except ValueError as e:
            status["error"] = str(e)
    return status


def collect(status: dict, cands: dict) -> None:
    results = ((status.get("json") or {}).get("results") or [])
    lane = {"lane": status["lane"], "label": status.get("label", ""),
            "kind": status.get("kind", "")}
    normalized = [normalize_candidate(x, lane) for x in results]
    merge_candidates(cands, normalized)


def run_code_evidence(cand: dict, terms: str, out_dir: str, budget_left: float) -> dict:
    """第 2 轮：对单个候选做仓库内代码证据检索。"""
    tmp = os.path.join(out_dir, "raw")
    os.makedirs(tmp, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", cand.get("name") or "repo")
    out_file = os.path.join(tmp, f"code-{safe}.json")
    cmd = [sys.executable, os.path.join(HERE, "mcps.py"),
           "-CodeEvidence", "-RepoScope", cand.get("name") or "",
           "-Keyword", terms, "-Limit", "5", "-AsJson", "--out", out_file]
    started = time.time()
    st = {"round": 2, "lane": 0, "kind": "code_evidence", "repo": cand.get("name"),
          "query": terms, "rc": None, "elapsedMs": 0, "count": 0, "json": None, "error": None}
    timeout = max(5.0, min(budget_left, 90.0))
    try:
        p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        st["rc"] = p.returncode
        if p.returncode != 0:
            st["error"] = (p.stderr or p.stdout or "")[-400:]
    except subprocess.TimeoutExpired:
        st["rc"] = 124
        st["error"] = f"代码证据超时（{timeout:.0f}s）"
    st["elapsedMs"] = int((time.time() - started) * 1000)
    if st["rc"] == 0 and os.path.exists(out_file):
        try:
            st["json"] = _decode_json(out_file)
            st["count"] = len((st["json"] or {}).get("results") or [])
        except ValueError as e:
            st["error"] = str(e)
    cov = (st.get("json") or {}).get("coverage") or {}
    if st["rc"] == 124:
        verdict = "timeout"
    elif st["rc"] != 0:
        verdict = "error"
    else:
        verdict = cov.get("Verdict") or "none"
    cand["codeEvidence"] = {"repo": cand.get("name"), "count": st.get("count", 0),
                            "verdict": verdict,
                            "reason": "; ".join(cov.get("Reasons") or [])[:200] or None}
    return st


def run_gap_query(gap: dict, args, out_dir: str, budget_left: float) -> dict:
    """第 3 轮：把缺口变成一条仓库检索，而不是只写在报告里。"""
    lane = {"lane": 90 + len(gap.get("axis", "")) % 9, "label": f"补查:{gap['axis']}",
            "kind": "gap", "query": f"{args.terms or args.brief} {gap['query']}",
            "platform": args.platform, "minStars": max(0, args.min_stars // 2),
            "limit": args.limit}
    st = run_lane(lane, out_dir, budget_left)
    st["round"] = 3
    st["kind"] = "gap"
    st["label"] = lane["label"]
    return st


# ---------------------------------------------------------------- 自测

def self_test() -> int:
    failures = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" :: {detail}"))
        if not cond:
            failures.append(name)

    lanes = build_lanes("agent skill registry", 4)
    check("lane 数量", len(lanes) == 4)
    check("lane 唯一", len({l["query"] for l in lanes}) == 4)
    check("lane 稳定", build_lanes("agent skill registry", 4) == lanes)

    a = normalize_candidate({"EntityKey": "a/b", "Name": "a/b", "Stars": 10, "License": "MIT"}, lanes[0])
    b = normalize_candidate({"EntityKey": "A/B", "Name": "A/B", "Stars": 20, "Updated": "2026-10-01"}, lanes[1])
    cands = merge_candidates({}, [a])
    merge_candidates(cands, [b])
    merged = cands["a/b"]
    check("去重保留最大星数", merged["stars"] == 20, merged)
    check("license 取首个非空", merged["license"] == "MIT", merged)
    check("lanes 合并", merged["lanes"] == [1, 2], merged)
    check("key 大小写归一", candidate_key({"EntityKey": "A/B"}) == "a/b")

    ranked = rank_candidates(cands, 15)
    check("rank 赋值", ranked[0]["rank"] == 1)

    low = normalize_candidate({"EntityKey": "low/x", "Stars": 5000, "Relevance": 1,
                               "Relaxed": "drop-stars"}, lanes[0])
    good = normalize_candidate({"EntityKey": "good/x", "Stars": 5000, "Relevance": 0.6}, lanes[0])
    ranked2 = rank_candidates(merge_candidates({}, [low, good]), 15)
    check("放宽过滤被降权", ranked2[0]["name"] == "good/x" or ranked2[0]["key"] == "good/x", ranked2[0])

    gaps = gap_axes([{"name": "x", "license": None, "platform": "GitHub"}], {"blocked": []})
    axes = {g["axis"] for g in gaps}
    check("缺 license 被发现", "license" in axes, axes)
    check("单平台被发现", "platform" in axes, axes)
    check("缺代码证据被发现", "code_evidence" in axes, axes)

    cov = merge_coverage([
        {"json": {"coverage": {"Requested": ["GitHub"], "Executed": ["GitHub"], "Blocked": [], "Reasons": [], "Verdict": "full"}}},
        {"json": {"coverage": {"Requested": ["GitHub", "Gitee"], "Executed": ["GitHub"], "Blocked": ["Gitee"], "Reasons": ["blocked"], "Verdict": "partial"}}},
    ])
    check("coverage 并集", cov["requested"] == ["GitHub", "Gitee"], cov)
    check("coverage partial", cov["verdict"] == "partial", cov)

    md = render_report({"brief": "x", "generatedAt": "t", "rounds": 1, "budgetSec": 1,
                        "elapsedSec": 0}, lanes, [], [], cov, gaps)
    check("报告非空", len(md) > 200 and "复现" in md)
    check("报告不泄漏 token 字样", "GITHUB_TOKEN=" not in md)

    print(f"\n{'SELFTEST PASS' if not failures else 'SELFTEST FAIL'} ({len(failures)} 失败)")
    return 0 if not failures else 3


# ---------------------------------------------------------------- 主流程

def main() -> int:
    ap = argparse.ArgumentParser(description="多轮调研编排器")
    ap.add_argument("--brief", help="调研主题")
    ap.add_argument("--terms", default=None, help="检索词（缺省用 brief；中文建议给英文短词）")
    ap.add_argument("--out", help="输出目录")
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--lanes", type=int, default=4)
    ap.add_argument("--limit", type=int, default=6)
    ap.add_argument("--min-stars", type=int, default=50)
    ap.add_argument("--platform", default="All")
    ap.add_argument("--budget-sec", type=int, default=240)
    ap.add_argument("--execute", action="store_true", help="执行 lane（缺省只生成工单）")
    ap.add_argument("--merge", default=None, help="合并目录下 agents/*.result.json")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    if not args.brief:
        ap.error("--brief 必填（或用 --self-test）")
    if not args.out:
        ap.error("--out 必填")

    out_dir = args.out if os.path.isabs(args.out) else os.path.join(HERE, args.out)
    os.makedirs(out_dir, exist_ok=True)
    started = time.time()
    lanes = build_lanes(args.brief, args.lanes, args.terms)
    for lane in lanes:
        lane["platform"] = args.platform
        lane["minStars"] = args.min_stars
        lane["limit"] = args.limit

    meta = {"schema": SCHEMA, "brief": args.brief, "terms": args.terms,
            "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "rounds": args.rounds, "roundsRequested": args.rounds, "roundsExecuted": 0,
            "budgetSec": args.budget_sec,
            "lanes": len(lanes), "execute": bool(args.execute), "elapsedSec": 0}
    io.open(os.path.join(out_dir, "plan.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"meta": meta, "lanes": lanes}, ensure_ascii=False, indent=2) + "\n")

    agents_dir = os.path.join(out_dir, "agents")
    os.makedirs(agents_dir, exist_ok=True)
    for lane in lanes:
        io.open(os.path.join(agents_dir, f"lane-{lane['lane']}.md"), "w", encoding="utf-8", newline="\n").write(
            render_agent_work_order(lane, args.brief))

    runs, cands = [], {}

    if args.execute:
        for lane in lanes:
            left = args.budget_sec - (time.time() - started)
            if left <= 3:
                runs.append({"lane": lane["lane"], "query": lane["query"], "rc": 125,
                             "elapsedMs": 0, "count": 0, "json": None,
                             "error": "总预算耗尽，未执行"})
                continue
            st = run_lane(lane, out_dir, left)
            st["label"] = lane["label"]
            st["kind"] = lane["kind"]
            st["round"] = 1
            runs.append(st)
            collect(st, cands)
            print(f"[lane {lane['lane']}] rc={st['rc']} {st['elapsedMs']}ms count={st['count']}")

        meta["roundsExecuted"] = 1
        terms = args.terms or args.brief

        # 第 2 轮：对 top 候选逐个做仓库内代码证据检索
        if args.rounds >= 2 and cands:
            top = [c for c in rank_candidates(cands, 10) if "/" in (c.get("name") or "")][:3]
            for c in top:
                left = args.budget_sec - (time.time() - started)
                if left <= 6:
                    runs.append({"round": 2, "lane": 0, "kind": "code_evidence",
                                 "repo": c.get("name"), "query": terms, "rc": 125,
                                 "elapsedMs": 0, "count": 0, "json": None,
                                 "error": "总预算耗尽，未执行"})
                    continue
                st = run_code_evidence(c, terms, out_dir, left)
                runs.append(st)
                print(f"[round2] {c.get('name')} rc={st['rc']} {st['elapsedMs']}ms "
                      f"count={st['count']}")
            if top:
                meta["roundsExecuted"] = 2

        # 第 3 轮：把缺口变成补查（最多 2 条），仍然受总预算约束
        if args.rounds >= 3:
            gaps_now = gap_axes(rank_candidates(cands, 15), merge_coverage(runs))
            for g in [x for x in gaps_now if x.get("query")][:2]:
                left = args.budget_sec - (time.time() - started)
                if left <= 6:
                    break
                st = run_gap_query(g, args, out_dir, left)
                runs.append(st)
                collect(st, cands)
                print(f"[round3:{g['axis']}] rc={st['rc']} {st['elapsedMs']}ms "
                      f"count={st['count']}")
                meta["roundsExecuted"] = 3

    if args.merge:
        merge_dir = args.merge if os.path.isabs(args.merge) else os.path.join(HERE, args.merge)
        for name in sorted(os.listdir(merge_dir)):
            if not name.endswith(".result.json"):
                continue
            try:
                st = _decode_json(os.path.join(merge_dir, name))
            except ValueError as e:
                print(f"[merge] skip {name}: {e}", file=sys.stderr)
                continue
            st.setdefault("lane", 0)
            st.setdefault("elapsedMs", 0)
            runs.append(st)
            collect(st, cands)
            print(f"[merge] {name} count={st.get('count', len((st.get('json') or {}).get('results') or []))}")

    candidates = rank_candidates(cands, 15)
    coverage = merge_coverage(runs)
    gaps = gap_axes(candidates, coverage)
    meta["elapsedSec"] = round(time.time() - started, 1)

    io.open(os.path.join(out_dir, "candidates.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"meta": meta, "coverage": coverage, "gaps": gaps,
                    "candidates": candidates}, ensure_ascii=False, indent=2) + "\n")
    io.open(os.path.join(out_dir, "ledger.json"), "w", encoding="utf-8", newline="\n").write(
        json.dumps({"meta": meta, "runs": runs, "totals": {
            "lanes": len(runs),
            "ok": sum(1 for r in runs if r.get("rc") == 0),
            "failed": sum(1 for r in runs if r.get("rc") not in (0, None)),
            "results": sum(int(r.get("count") or 0) for r in runs),
            "candidates": len(candidates),
        }}, ensure_ascii=False, indent=2) + "\n")
    io.open(os.path.join(out_dir, "report.md"), "w", encoding="utf-8", newline="\n").write(
        render_report(meta, lanes, runs, candidates, coverage, gaps))
    if gaps:
        io.open(os.path.join(out_dir, "next-round.json"), "w", encoding="utf-8", newline="\n").write(
            json.dumps({"meta": meta, "gaps": gaps,
                        "queries": [{"query": g["query"], "axis": g["axis"]} for g in gaps]},
                       ensure_ascii=False, indent=2) + "\n")

    print(f"\n输出：{out_dir}")
    print(f"候选 {len(candidates)} 条 / lane {len(runs)} 条 / 缺口 {len(gaps)} 个 / "
          f"{meta['elapsedSec']}s / verdict={coverage['verdict']}")
    if not args.execute and not args.merge:
        print("当前只生成工单；加 --execute 执行，或把 agents 分发给多个 agent 后用 --merge 合并。")
    return 0 if candidates or not (args.execute or args.merge) else 3


if __name__ == "__main__":
    raise SystemExit(main())
