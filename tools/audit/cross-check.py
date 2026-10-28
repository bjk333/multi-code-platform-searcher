"""0-6 同源门 · 比对侧（双向）。

门的两条腿：
  ① **同源**：Python audit-analyze.norm()/whole_hit()/cjk_bigrams()  必须 ==  PS 侧 fixture 的实测输出。
  ② **未漂移**：PS 现行输出必须 == 基线 fixture（`fixtures/norm-baseline.json`）。
     若产品侧 Normalize-MatchText 语义被改动而没人更新 analyzer（或反之），② 或 ① 必红。

用法:
  python cross-check.py --ps <ps-fixture.json> [--baseline <baseline.json>] [--skill <skillDir>]
退出码: 0 = 全绿；1 = 有分歧
"""
import argparse
import importlib.util
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_analyzer(skill_dir):
    p = os.path.join(skill_dir, "tools", "audit", "audit-analyze.py")
    if not os.path.isfile(p):
        p = os.path.join(HERE, "audit-analyze.py")
    spec = importlib.util.spec_from_file_location("aa", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _rd(p):
    with io.open(p, encoding="utf-8-sig") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description="0-6 parity check (same-source + no-drift)")
    ap.add_argument("--ps", required=True, help="PS 侧导出的 fixture JSON")
    ap.add_argument("--baseline", default="", help="基线 fixture（未漂移腿）")
    ap.add_argument("--skill", default=os.path.dirname(os.path.dirname(HERE)), help="skill 根目录")
    a = ap.parse_args()

    aa = load_analyzer(a.skill)
    fx = _rd(a.ps)
    bad = []

    print("=" * 100)
    print("0-6 同源门   PS=%s  fixture=%s" % (fx.get("ps"), os.path.basename(a.ps)))
    print("=" * 100)

    # ── 腿①：Python ↔ PS 现行 ──
    print("[腿①·同源] norm()")
    print("%-32s %-30s %-30s" % ("input", "PS norm", "PY norm"))
    print("-" * 100)
    for row in fx["norm"]:
        pn, yn = row["norm"], aa.norm(row["input"])
        ok = pn == yn
        if not ok:
            bad.append(("same-source norm", row["input"], pn, yn))
        print("%-32s %-30s %-30s %s" % (repr(row["input"])[:32], repr(pn)[:30], repr(yn)[:30],
                                        "" if ok else "<<< DIFF"))

    print("\n[腿①·同源] cjk_bigrams()（仅列含 CJK 的样本）")
    for row in fx["norm"]:
        s = row["input"]
        if not any("\u3000" <= c <= "\u9fff" or "\uac00" <= c <= "\ud7af" for c in s):
            continue
        pb, yb = list(row.get("bigrams") or []), aa.cjk_bigrams(s)
        ok = pb == yb
        if not ok:
            bad.append(("same-source bigrams", s, pb, yb))
        print("  %-30s PS=%-34s PY=%-34s %s" % (repr(s)[:30], repr(pb)[:34], repr(yb)[:34],
                                                "" if ok else "<<< DIFF"))

    print("\n[腿①·同源] whole_hit()")
    print("%-24s %-22s %-8s %-8s" % ("hay", "term", "PS", "PY"))
    print("-" * 100)
    for row in fx["whole"]:
        ph = bool(row["hit"])
        yh = aa.whole_hit(aa.norm(row["hay"]), aa.norm(row["term"]))
        ok = ph == yh
        if not ok:
            bad.append(("same-source whole", (row["hay"], row["term"]), ph, yh))
        print("%-24s %-22s %-8s %-8s %s" % (repr(row["hay"])[:24], repr(row["term"])[:22],
                                            ph, yh, "" if ok else "<<< DIFF"))

    # ── 腿①b：期望断言（批次3 补，2026-10-09）──
    #   ★为何必须单独一条腿：腿① 只验「PS 与 Python 一致」，腿② 只验「与基线比没漂移」。
    #   这两条腿**都无法发现"两侧一起错"**——样本集里写的 expect 从前根本没被读过
    #   （export 侧在构造 fixture 时就把 expect 丢掉了）。本腿用**独立于两侧实现的人的期望**断言。
    n_exp = 0
    print("\n[腿①b·期望] norm() expect 断言")
    for row in fx["norm"]:
        if row.get("expect") is None:
            continue
        n_exp += 1
        ok = row["norm"] == row["expect"]
        if not ok:
            bad.append(("expect norm", row["input"], row["expect"], row["norm"]))
        print("  %-24s expect=%-22s got=%-22s %s" % (repr(row["input"])[:24], repr(row["expect"])[:22],
                                                     repr(row["norm"])[:22], "" if ok else "<<< MISMATCH"))
    print("[腿①b·期望] whole_hit() expect 断言")
    for row in fx["whole"]:
        if row.get("expect") is None:
            continue
        n_exp += 1
        ok = bool(row["hit"]) == bool(row["expect"])
        if not ok:
            bad.append(("expect whole", (row["hay"], row["term"]), row["expect"], row["hit"]))
        print("  %-22s %-20s expect=%-6s got=%-6s %s" % (repr(row["hay"])[:22], repr(row["term"])[:20],
                                                          bool(row["expect"]), bool(row["hit"]),
                                                          "" if ok else "<<< MISMATCH  " + str(row.get("why") or "")))
    print("[腿①b] 共断言 %d 条带 expect 的样本" % n_exp)

    # ── 腿②：PS 现行 ↔ PS 基线（未漂移）──
    if a.baseline and os.path.isfile(a.baseline):
        bl = _rd(a.baseline)
        drift = []
        bn = {r["input"]: r["norm"] for r in bl.get("norm", [])}
        for row in fx["norm"]:
            if row["input"] in bn and bn[row["input"]] != row["norm"]:
                drift.append(("norm", row["input"], bn[row["input"]], row["norm"]))
        bw = {(r["hay"], r["term"]): bool(r["hit"]) for r in bl.get("whole", [])}
        for row in fx["whole"]:
            k = (row["hay"], row["term"])
            if k in bw and bw[k] != bool(row["hit"]):
                drift.append(("whole", k, bw[k], bool(row["hit"])))
        print("\n[腿②·未漂移] PS 现行 ↔ 基线：%s" % ("PASS（0 处漂移）" if not drift else "FAIL（%d 处漂移）" % len(drift)))
        for d in drift:
            print("  [%s] %r  基线=%r  现行=%r" % d)
        bad += [("drift " + d[0], d[1], d[2], d[3]) for d in drift]
    elif a.baseline:
        print("\n[腿②·未漂移] 基线缺失（%s）⇒ 跳过；用 --baseline 提供基线以启用" % a.baseline)

    print("\n" + "=" * 100)
    if bad:
        print("RESULT: FAIL  %d 处分歧（门红）" % len(bad))
        for b in bad:
            print("  [%s] %r  left=%r  right=%r" % b)
        return 1
    print("RESULT: PASS  norm=%d / bigrams / whole=%d" % (len(fx["norm"]), len(fx["whole"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
