#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mcps.py — multi-code-platform-searcher 的 Python 驱动（绕开 PowerShell 执行策略）
====================================================================================
背景（2026-09-14 实测）：
  直接调用 `multi-platform-searcher.ps1` 在受限策略机器上抛 `PSSecurityException`
  （"在此系统上禁止运行脚本"）——**不是技能损坏，是 PowerShell execution policy**。
  Agent/沙箱内又通常无法改机器级策略（需管理员）。

本驱动做三件事，使技能在受限环境下开箱可用：
  ① 以子进程 `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <ps1>`
     调起 —— **仅对本次子进程生效**，不改机器/用户级策略、不需管理员；
  ② 把 `<skill>/tools/bin` **前置**进子进程 PATH —— 放进去的 `rg.exe`/`ast-grep.exe` 等
     无需修改系统 PATH 即可被脚本的 `Get-Command` 发现（恢复 -LocalCodeSearch）；
  ③ 统一编码：`PYTHONUTF8=1`/`PYTHONIOENCODING=utf-8` 给子进程；**stdout 解码走自动级联**
     （UTF-8 严格 → 本机 locale 代码页 → cp936 → cp1252 → latin-1），因为 Windows PowerShell 5.1
     的 stdout 是**控制台输出代码页**（zh-CN=GBK）而非 UTF-8——按 UTF-8 硬解会得乱码（C2 族缺陷）。

用法（其余参数原样透传给 ps1）：
  python mcps.py -Doctor -AsJson --out C:/tmp/mcps/doctor.json
  python mcps.py -Keyword "redis lock" -AsJson --out C:/tmp/mcps/repo.json
  python mcps.py -CodeEvidence -Keyword "jwt verify" -Limit 6 --out C:/tmp/mcps/code.json
  python mcps.py -ResearchSources -Keyword "llama" -Limit 5 --out C:/tmp/mcps/research.json
  python mcps.py -Doctor                       # 不落盘，直接打印到 stdout

返回：ps1 的退出码。v1.47.2 起语义 = **本轮有没有拿到结论**：
  0 = 至少一个引擎执行过（含真实 0 命中；partial/degraded 也算 0）
  2 = 一个都没查成，且原因是工具缺失（tool_missing）
  3 = 一个都没查成，且原因是认证缺失（auth_missing）
  4 = 一个都没查成，其它原因（全阻断 / 全被截止）
  要"为什么不是全绿"的逐源归因，读 JSON 的 metrics.ExitCode（仍是 0/2/3/4 旧语义）。
"""
import argparse
import json
import hashlib
import locale
import os
import shutil
import subprocess
import sys

SKILL_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PS1 = os.path.join(SKILL_DIR, "multi-platform-searcher.ps1")
LOCAL_BIN = os.path.join(SKILL_DIR, "tools", "bin")


def _find_powershell():
    for name in ("powershell", "powershell.exe", "pwsh", "pwsh.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _decode(raw):
    """子进程 stdout 解码（C2 族级防线）。

    Windows PowerShell 5.1 的 stdout 走**控制台输出代码页**（zh-CN 为 cp936/GBK），
    并非 UTF-8——直接按 UTF-8 解码会得到乱码（典型症状："字节" → "瀛楄妭"）。
    故：先按 UTF-8 严格试解（pwsh 7 / 已显式设 UTF-8 时成立），失败再退到本机
    locale 代码页，最后兜底 cp936 / cp1252 / latin-1，保证不丢数据。
    """
    for enc in ("utf-8",):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            pass
    for enc in (locale.getpreferredencoding(False), "cp936", "cp1252"):
        if not enc:
            continue
        try:
            return raw.decode(enc), enc
        except (UnicodeDecodeError, LookupError):
            pass
    # v1.41.0 修复（R-1「不静默」）：**移除 latin-1 的静默兜底**。
    #   旧实现把 latin-1 放进正常级联，而 latin-1 **永不失败** —— 任何解不出的字节都会被
    #   "成功"吐成乱码，调用方看到 enc=latin-1 也无从判断是否可信。
    #   实测后果（2026-10-07）：中文查询下 PS1 stdout 是 GBK/UTF-8 混合流，
    #   三级解码全失败 ⇒ 落到 latin-1 ⇒ **整个 JSON 变乱码且反斜杠转义被破坏**，
    #   下游 json.loads 抛 `Invalid \escape`，**是"静默产出坏数据"**。
    #   现在：仍然返回（保 Recall，不中断调用方），但 enc 标为 DEGRADED 并在 stderr 显式告警。
    print("[mcps] WARNING: stdout 三级解码（utf-8/locale/cp936/cp1252）全部失败 —— "
          "疑似 PS1 输出为**混合编码**。已用 latin-1 兜底，**内容可能整体乱码**；"
          "请检查 multi-platform-searcher.ps1 是否设置了 "
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8（v1.41.0 起已默认设置）。",
          file=sys.stderr)
    return raw.decode("latin-1", errors="replace"), "latin-1-DEGRADED"


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _manifest_score(path):
    """返回 (键数, 非空 hash 数)；不可读返回 (-1, -1)。"""
    try:
        with open(path, encoding='utf-8-sig') as f:
            j = json.load(f)
        fh = ((j.get('assets') or [{}])[0]).get('fileHashes') or {}
        return (len(fh), sum(1 for v in fh.values() if v))
    except Exception:
        return (-1, -1)


def _resolve_manifest(explicit, skill_dir):
    """按"非空 hash 数"择优 —— 技能目录里可能存在**全空 hash 的空壳清单**（实测 2026-10-18：44 键全空），
    若盲目取第一个会得到 files=0 的**假 PASS**。"""
    cands = []
    if explicit:
        cands.append(explicit)
    cands.append(os.path.join(skill_dir, 'skill-assets.json'))
    cands.append(os.path.join(os.path.dirname(skill_dir), 'skill-assets.json'))
    cands.append(os.path.join(skill_dir, 'reports', '_skill-assets.root.json'))
    best, best_n = None, -1
    for c in cands:
        if not c or not os.path.isfile(c):
            continue
        keys, nonempty = _manifest_score(c)
        if nonempty > best_n:
            best, best_n = c, nonempty
    if best and best_n == 0:
        print('[verify] WARN: 找到的清单全是空 hash（%s）——无法校验' % best, file=sys.stderr)
    return best


def verify_manifest(explicit_manifest, skill_dir, as_json=False, show_all=False):
    """按清单逐文件校验 sha256（P1-1）。退出码：0 全 OK / 1 有 DRIFT 或 MISSING / 2 用法错误。"""
    man = _resolve_manifest(explicit_manifest, skill_dir)
    if not man:
        print('[verify] ERROR: 找不到清单（用 -Manifest 指定 skill-assets.json）', file=sys.stderr)
        return 2
    try:
        with open(man, encoding='utf-8-sig') as f:
            j = json.load(f)
    except Exception as e:
        print('[verify] ERROR: 清单不可读: %s' % e, file=sys.stderr)
        return 2
    assets = (j.get('assets') or [{}])[0]
    fh = assets.get('fileHashes') or {}
    ok, drift, missing = [], [], []
    for rel, want in fh.items():
        if not want:
            continue
        p = os.path.join(skill_dir, rel.replace('/', os.sep))
        if not os.path.isfile(p):
            missing.append(rel)
        elif _sha256_file(p) == str(want).lower():
            ok.append(rel)
        else:
            drift.append(rel)
    total = len(ok) + len(drift) + len(missing)
    # ★2026-10-19：**0 个可比对文件时必须 UNKNOWN**，绝不能 PASS ——
    #   实测发布副本上有个 1.38.0 的空壳清单（0 hash），首版直接报了 PASS（假绿，与 budget-truncated/forbidden/filtered 同型）。
    if total == 0:
        verdict = 'UNKNOWN'
    else:
        verdict = 'PASS' if (not drift and not missing) else 'FAIL'
    if as_json:
        print(json.dumps({'manifest': man, 'version': assets.get('version'), 'total': total,
                          'ok': len(ok), 'drift': drift, 'missing': missing, 'verdict': verdict},
                         ensure_ascii=False, indent=2))
    else:
        print('[verify] manifest = %s' % man)
        print('[verify] version  = %s' % assets.get('version'))
        print('[verify] files    = %d  (ok %d / drift %d / missing %d)' % (total, len(ok), len(drift), len(missing)))
        for rel in drift:
            print('[verify] DRIFT   %s' % rel)
        for rel in missing:
            print('[verify] MISSING %s' % rel)
        if show_all:
            for rel in ok:
                print('[verify] ok      %s' % rel)
        if verdict == 'UNKNOWN':
            print('[verify] ERROR: 清单里没有可比对的 hash（0 文件）——拒绝判定 PASS')
        print('[verify] RESULT: %s' % verdict)
    return 0 if verdict == 'PASS' else (2 if verdict == 'UNKNOWN' else 1)


# =====================================================================================
# MCP（Model Context Protocol）stdio 服务端 —— v1.43.0（2026-10-19，P1 第二项）
# -------------------------------------------------------------------------------------
# 分层：**协议在 Python，性能在 PowerShell**。
#   - PowerShell 侧 `-Serve` 常驻：脚本只 parse 一次，逐行 JSON 请求/响应（实测首行 1.0s、预热后 7–9s）；
#   - Python 侧（本模块）：MCP 的 JSON-RPC 2.0 帧、tools/list、tools/call 映射，以及**进程生命周期**。
#   ⇒ 两边都不需要理解对方的世界：ps1 不知道 MCP，Python 不知道 PowerShell 参数表。
#
# 传输（MCP stdio）：**每行一个 JSON-RPC 消息**（不是 LSP 的 Content-Length 帧）。三条硬约束：
#   ① stdout 只能有协议行 —— 任何人类可读日志一律 stderr（否则客户端 parse 失败）；
#   ② 子进程 stdout 是 UTF-8（-Serve 已显式设置），本模块全程按字节读写，避免 Windows 代码页二次编码；
#   ③ 子进程死掉/超时必须**重启并回错误**，不能把"空等"传给客户端（否则客户端永久挂起）。
# =====================================================================================

MCP_PROTOCOL_VERSION = "2024-11-05"
MCP_SERVER_NAME = "multi-code-platform-searcher"


def _log(msg):
    """诊断一律走 stderr：stdout 是协议流。"""
    try:
        sys.stderr.write("[mcps-mcp] %s\n" % msg)
        sys.stderr.flush()
    except Exception:
        pass


def _read_ps_version(ps1_path):
    """从主脚本读 $VERSION —— 版本号只允许有一个事实源（U-59 同一纪律）。"""
    try:
        import re
        with open(ps1_path, encoding="utf-8-sig") as f:
            m = re.search(r'^\$VERSION\s*=\s*"([0-9.]+)"', f.read(), re.M)
        return m.group(1) if m else "unknown"
    except Exception:
        return "unknown"


def load_output_schemas(skill_dir=None):
    """读 `schema/mcp-output.schema.json`，返回 {工具名: 可直接下发的 outputSchema}。

    v1.50.0：tools/list 此前只有 name/description/inputSchema，tools/call 只有 content+isError
    ⇒ 客户端拿不到机器可校验的响应契约（v1.48.2 报告 §5 一直挂着）。现在：
      · outputSchema = {"type":"object", "$defs": <共享定义>, ...x-tools[工具名]}
        （$defs 必须随每份 schema 一起下发，否则 `#/$defs/...` 无处解析）；
      · 文件缺失/不是合法 JSON ⇒ **不静默**：stderr 记 WARN，且不声明 outputSchema
        （宁可不承诺，也不下发一份假契约）；门 U-219 要求 6 个工具全都有，缺失即红。
    """
    path = os.path.join(skill_dir or SKILL_DIR, "schema", "mcp-output.schema.json")
    try:
        with open(path, encoding="utf-8-sig") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        _log("WARN: MCP output schema unavailable (%s): %s" % (path, e))
        return {}
    defs = doc.get("$defs") or {}
    out = {}
    for name, schema in (doc.get("x-tools") or {}).items():
        merged = {"type": "object", "$defs": defs}
        merged.update(schema)
        out[name] = merged
    return out


def mcp_tools(output_schemas=None):
    """工具清单（纯数据，可离线断言）。每个工具恰好映射到一个 `-Serve` op。

    v1.50.0：每个工具带 `outputSchema`（来源见 load_output_schemas）；缺 schema 的工具有意**不带**
    该键 —— 声明了就得保证 structuredContent 合规，拿不准就不要承诺。
    """
    schemas = load_output_schemas() if output_schemas is None else output_schemas
    common_out = {
        "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 5,
                  "description": "每源页大小（与 CLI 的 -Limit 同义，不是最终条数：聚合型引擎会超出）。超出 1–50 会被夹紧到边界，不报错。"},
        "maxResults": {"type": "integer", "minimum": 0, "default": 0,
                       "description": "返回条数上限（按相关性截断）；0 = 不截断，与 CLI 一致。负值按 0 处理。"},
    }
    kw = {"type": "string", "minLength": 1, "description": "检索关键词（必填）。"}
    tools = [
        {
            "name": "search_repositories",
            "description": ("发现相似/相关开源仓库（GitHub / Gitee / GitLab / Codeberg）。"
                            "返回按统一相关性分排序的 results[]（含 Score/Stars/Url）。"
                            "注意：0 条 ≠ 不存在 —— 可能是令牌缺失/限流，见 warnings 与 -Doctor。"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": kw,
                    "limit": common_out["limit"],
                    "maxResults": common_out["maxResults"],
                    "platforms": {"type": "string",
                                  "description": "逗号分隔的平台名（GitHub,Gitee,GitLab,Codeberg）；缺省 = 全部启用源。未知名字会被拒绝（不会静默返回 0 条）。"},
                    "language": {"type": "string", "description": "语言过滤（客户端侧，如 Python/TypeScript）。"},
                    "minStars": {"type": "integer", "minimum": 0, "default": 100,
                                 "description": "最小 star 阈值（默认 100，与 CLI 一致；0 = 不过滤）。负值按 0 处理。"},
                    "activeWithin": {"type": "integer", "minimum": 0, "maximum": 36500, "default": 0,
                                     "description": "只保留最近 N 天内更新过的仓库（0 = 不过滤）。缺更新时间的源不剔除，见 filterNotes。超出 0–36500 会被夹紧。"},
                    "excludeArchived": {"type": "boolean", "default": False,
                                        "description": "剔除归档仓库。GitHub/Codeberg 返回 archived；GitLab/Gitee 不返回 ⇒ 不剔除并在 filterNotes 明说。"},
                    "license": {"type": "string",
                                "description": "逗号分隔的 SPDX id（如 mit,apache-2.0），大小写不敏感；无 license 信息的条目会被剔除并单独计数。"},
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
        },
        {
            "name": "search_auto",
            "description": ("自动分派（等价 CLI `-Auto`）：planner 先判定 queryType，再跑 repo / code / research 的并集，"
                            "返回合并排序后的 results[] 以及 modes / queryType / counts。"
                            "不确定该用哪个工具时先调它 —— 模式猜错会整轮空跑。"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": kw,
                    "limit": common_out["limit"],
                    "maxResults": common_out["maxResults"],
                    "language": {"type": "string", "description": "语言过滤（只作用于 repo/code；research 不看语言）。"},
                    "minStars": {"type": "integer", "minimum": 0, "default": 100,
                                 "description": "最小 star 阈值（只作用于 repo；0 = 不过滤）。负值按 0 处理。"},
                    "site": {"type": "string", "default": "stackoverflow",
                             "description": "Stack Exchange 站点（只作用于 research）。"},
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
        },
        {
            "name": "search_code",
            "description": ("检索公开代码实现证据（GitHub 第一方 / GitLab blobs / grep.app / "
                            "Stack Exchange 社区实现 / Sourcegraph 兜底）。返回 results[] 含 File/Line/Preview。"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": kw,
                    "limit": common_out["limit"],
                    "maxResults": common_out["maxResults"],
                    "language": {"type": "string",
                                 "description": "语言过滤（如 Python/Go）。仅 GitHub/GrepApp/Sourcegraph 支持；其余源会在 warnings 明说未应用。"},
                    "repoScope": {"type": "string",
                                  "description": "仓库作用域（v1.46.6）：git URL 或 owner/repo。给出后只检索该仓库"
                                                 "（GitHub repo: / grep.app repo / Sourcegraph repo: / searchcode 仓库 API），"
                                                 "并按仓库身份二次过滤；解析失败直接报参数错误，不会悄悄退回全局检索。"},
                    "pathFilter": {"type": "string",
                                   "description": "路径过滤（v1.46.6）：GitHub path: / grep.app path / Sourcegraph path:；其余源不支持。"},
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
        },
        {
            "name": "research",
            "description": ("研究信源检索（Hugging Face / npm / crates.io / Maven / arXiv / "
                            "Stack Exchange / Hacker News / OpenAlex / MCP Registry 等）。"
                            "可选付费源 DeepSeek 仅在配置 DEEPSEEK_API_KEY 时参与。"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "keyword": kw,
                    "limit": common_out["limit"],
                    "maxResults": common_out["maxResults"],
                    "site": {"type": "string", "default": "stackoverflow",
                             "description": "Stack Exchange 站点（默认 stackoverflow；如 superuser/serverfault）。"},
                },
                "required": ["keyword"],
                "additionalProperties": False,
            },
        },
        {
            "name": "package_lookup",
            "description": ("精确包元数据（deps.dev 免 key）：默认版本 / 许可证 / 发布时间 / 已知安全公告数。"
                            "packages 为逗号分隔的 `生态:包名`（npm / pypi / cargo / go / maven / nuget），"
                            "例如 `npm:express,pypi:requests`。这是精确查询，不是关键词搜索。"),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "packages": {"type": "string", "minLength": 1,
                                 "description": "逗号/分号分隔的 `生态:包名`；单个也可。"},
                },
                "required": ["packages"],
                "additionalProperties": False,
            },
        },
        {
            "name": "ping",
            "description": "健康检查：返回版本与常驻进程 PID（用于确认 MCP 层与 -Serve 子进程都活着）。",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    ]
    # v1.50.0：把 outputSchema 挂上去（纯数据，不改上面每个工具的字面量 —— 减少 diff 面）
    for t in tools:
        sc = schemas.get(t["name"])
        if sc:
            t["outputSchema"] = sc
    # v1.53.12（T2-7 残余）：每个工具带 title + annotations（MCP 2025-06-18 Tool 描述符）。
    #   readOnlyHint 与"实现到没到"无关 —— 6 个工具全是只读查询，不改任何状态。
    #   idempotentHint：ping=true（重复同效）；搜索类=false（结果随外部数据变化）。
    #   openWorldHint：搜索类=true（交互外部 API）；ping=false（纯本地健康检查）。
    _ann_search = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True}
    _ann_ping = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}
    _titles = {
        "search_repositories": "Search Repositories",
        "search_auto": "Auto Search",
        "search_code": "Search Code",
        "research": "Research Sources",
        "package_lookup": "Package Lookup",
        "ping": "Health Check",
    }
    for t in tools:
        t["title"] = _titles.get(t["name"], t["name"])
        t["annotations"] = _ann_ping if t["name"] == "ping" else dict(_ann_search)
    return tools


# 工具名 → (-Serve op, 允许的实参)。**白名单**：MCP 客户端不能借工具参数塞进任意 ps1 参数。
MCP_TOOL_OPS = {
    "search_repositories": ("repo", {"keyword", "limit", "maxResults", "platforms", "language", "minStars",
                                     "activeWithin", "excludeArchived", "license"}),
    "search_auto": ("auto", {"keyword", "limit", "maxResults", "language", "minStars", "site"}),
    "search_code": ("code", {"keyword", "limit", "maxResults", "language", "repoScope", "pathFilter"}),
    "research": ("research", {"keyword", "limit", "maxResults", "site"}),
    "package_lookup": ("package", {"packages"}),
    "ping": ("ping", set()),
}


_RANGE_CACHE = {}


def _numeric_ranges(tool_name):
    """从该工具的 inputSchema 现读数值边界 → {键: (minimum, maximum)}。

    v1.78.0：此前 schema 声明了 `minimum`/`maximum`，但 `build_tool_request` 只校验**类型**、
    `-Serve` 只对 limit/maxResults 夹紧 —— 于是 `minStars=-1`、`activeWithin=40000` 原样穿过两层。
    声明与生效行为不一致的边界等于没有边界：客户端看 schema 以为会被拒，实际是"随便传"。
    单源：这里**不另存一张硬编码表**，直接读 `mcp_tools()` 的 properties（`output_schemas={}`
    避免为几个整数边界去读盘）。
    """
    if tool_name in _RANGE_CACHE:
        return _RANGE_CACHE[tool_name]
    out = {}
    try:
        props = {}
        for t in mcp_tools(output_schemas={}):
            if t.get("name") == tool_name:
                props = (t.get("inputSchema") or {}).get("properties") or {}
                break
        for k, spec in props.items():
            if spec.get("type") == "integer":
                lo, hi = spec.get("minimum"), spec.get("maximum")
                if lo is not None or hi is not None:
                    out[k] = (lo, hi)
    except Exception:                                    # schema 结构变了不该让调用直接炸；范围退化为不夹紧
        out = {}
    _RANGE_CACHE[tool_name] = out
    return out


def build_tool_request(tool_name, arguments):
    """纯函数：把 MCP tools/call 变成 -Serve 的一行请求。可离线单测（含负例）。"""
    if tool_name not in MCP_TOOL_OPS:
        raise ValueError("unknown tool: %s" % tool_name)
    op, allowed = MCP_TOOL_OPS[tool_name]
    args = arguments or {}
    if not isinstance(args, dict):
        raise ValueError("arguments must be an object")
    extra = set(args) - allowed
    if extra:
        raise ValueError("unexpected arguments for %s: %s" % (tool_name, ",".join(sorted(extra))))
    req = {"op": op}
    if op == "ping":
        return req
    if op == "package":
        # U-196：精确包查询没有 keyword —— 必填 packages；仍走白名单（多余参数一律拒绝）
        pkgs = args.get("packages")
        if not isinstance(pkgs, str) or not pkgs.strip():
            raise ValueError("packages is required (non-empty string)")
        req["packages"] = pkgs.strip()
        return req
    kw = args.get("keyword")
    if not isinstance(kw, str) or not kw.strip():
        raise ValueError("keyword is required (non-empty string)")
    req["keyword"] = kw
    ranges = _numeric_ranges(tool_name)
    for k in ("limit", "maxResults", "minStars", "activeWithin"):
        if k in args and args[k] is not None:
            v = args[k]
            if not isinstance(v, int) or isinstance(v, bool):
                raise ValueError("%s must be an integer" % k)
            # v1.78.0：越界时夹紧到 schema 区间，**不报错** —— 与 -Serve 对 limit/maxResults 的语义同构
            #  （那两处一直是 clamp）。夹紧是等价的：minStars -1 与 0 在下游 `-ge` 里都是"不过滤"，
            #  activeWithin 36500 天（100 年）与 40000 天对任何真实仓库都是"全通过"。
            lo, hi = ranges.get(k, (None, None))
            if lo is not None and v < lo:
                v = lo
            if hi is not None and v > hi:
                v = hi
            req[k] = v
    for k in ("platforms", "language", "site", "repoScope", "pathFilter", "license"):
        if k in args and args[k] is not None:
            if not isinstance(args[k], str):
                raise ValueError("%s must be a string" % k)
            req[k] = args[k]
    # v1.46.7：布尔必须真的是布尔（"true"/1 一律拒绝 —— 静默转换会让 false 变成 True）
    if "excludeArchived" in args and args["excludeArchived"] is not None:
        if not isinstance(args["excludeArchived"], bool):
            raise ValueError("excludeArchived must be a boolean")
        req["excludeArchived"] = args["excludeArchived"]
    return req


class ServeClient:
    """常驻 `-Serve` 子进程的一次往返封装（线程读 + 队列超时；子进程死了就重启并报错）。"""

    def __init__(self, powershell, ps1_path, default_timeout=180):
        self.powershell = powershell
        self.ps1_path = ps1_path
        self.default_timeout = default_timeout
        self.proc = None
        self._queue = None
        self._reader = None
        self.starts = 0

    def _spawn(self):
        import queue
        import threading
        cmd = [self.powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
               "-File", self.ps1_path, "-Serve"]
        env = dict(os.environ)
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if os.path.isdir(LOCAL_BIN):
            env["PATH"] = LOCAL_BIN + os.pathsep + env.get("PATH", "")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=SKILL_DIR, env=env)
        self._queue = queue.Queue()
        q = self._queue

        def _pump(stream):
            try:
                for raw in iter(stream.readline, b""):
                    q.put(raw)
            except Exception:
                pass
            finally:
                q.put(None)   # 进程结束哨兵

        def _drain(stream):
            try:
                for raw in iter(stream.readline, b""):
                    txt = raw.decode("utf-8", "replace").rstrip()
                    if txt:
                        _log("serve stderr: " + txt)
            except Exception:
                pass

        self._reader = threading.Thread(target=_pump, args=(self.proc.stdout,), daemon=True)
        threading.Thread(target=_drain, args=(self.proc.stderr,), daemon=True).start()
        self._reader.start()
        self.starts += 1
        _log("serve started pid=%s (start #%d)" % (self.proc.pid, self.starts))

    def _kill(self):
        p = self.proc
        self.proc = None
        if p is None:
            return
        try:
            if p.poll() is None:
                try:
                    p.stdin.write(b"__EXIT__\n")
                    p.stdin.flush()
                except Exception:
                    pass
                try:
                    p.wait(timeout=5)
                except Exception:
                    p.kill()
        except Exception:
            pass

    def restart(self):
        self._kill()
        self._spawn()

    def request(self, payload, timeout=None):
        """发一行、收一行。返回解析后的 dict；失败抛 RuntimeError（调用方转 isError）。"""
        import queue
        if self.proc is None or self.proc.poll() is not None:
            self._spawn()
        timeout = timeout or self.default_timeout
        line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        try:
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
        except Exception as e:
            self.restart()
            raise RuntimeError("serve stdin closed (%s); restarted" % e)
        try:
            raw = self._queue.get(timeout=timeout)
        except queue.Empty:
            self.restart()
            raise RuntimeError("serve timeout after %ss; restarted" % timeout)
        if raw is None:
            self.restart()
            raise RuntimeError("serve exited; restarted")
        text = raw.decode("utf-8", "replace").strip()
        try:
            return json.loads(text)
        except Exception:
            raise RuntimeError("serve returned non-JSON: %s" % text[:200])

    def close(self):
        self._kill()


def _mcp_response(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    return out


def _write_mcp(msg):
    """协议行 = 单行 JSON（UTF-8 字节直写；不经过 text 层，避免代码页二次编码）。"""
    data = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def handle_mcp_message(msg, client, version):
    """纯路由：返回 (response|None, should_exit)。不读 stdin、不写 stdout（便于单测直接调）。"""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _mcp_response(msg.get("id") if isinstance(msg, dict) else None,
                             error={"code": -32600, "message": "Invalid Request"}), False
    method = msg.get("method")
    msg_id = msg.get("id")
    is_notification = "id" not in msg
    if method == "initialize":
        params = msg.get("params") or {}
        asked = params.get("protocolVersion")
        # 回客户端的版本（我们只实现了 2024-11-05 的工具子集；字段协商失败客户端会自己降级）。
        ver = asked if isinstance(asked, str) and asked else MCP_PROTOCOL_VERSION
        return _mcp_response(msg_id, {
            "protocolVersion": ver,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": MCP_SERVER_NAME, "version": version},
        }), False
    if method in ("notifications/initialized", "notifications/cancelled"):
        return None, False
    if method == "ping":
        return _mcp_response(msg_id, {}), False
    if method == "tools/list":
        return _mcp_response(msg_id, {"tools": mcp_tools()}), False
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        args = params.get("arguments")
        try:
            req = build_tool_request(name, args)
        except ValueError as e:
            return _mcp_response(msg_id, error={"code": -32602, "message": str(e)}), False
        try:
            res = client.request(req)
        except RuntimeError as e:
            return _mcp_response(msg_id, {
                "content": [{"type": "text", "text": json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)}],
                "isError": True,
            }), False
        ok = bool(res.get("ok"))
        payload = {k: v for k, v in res.items() if k != "ok"}
        result = {
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
            "isError": not ok,
        }
        # v1.50.0：成功时同时给 structuredContent（与 content[0].text 是同一份对象）。
        #   规范：declared outputSchema ⇒ structuredContent MUST conform；isError=true 的结果不承诺合规，
        #   所以只在 ok 且是对象时添加。老客户端只读 content[0].text，行为逐位不变。
        if ok and isinstance(payload, dict):
            result["structuredContent"] = payload
        return _mcp_response(msg_id, result), False
    if is_notification:
        return None, False
    return _mcp_response(msg_id, error={"code": -32601, "message": "Method not found: %s" % method}), False


def run_mcp_server(ps1_path, timeout=180):
    """stdio 主循环。返回进程退出码（0 = 收到 EOF）。"""
    ps = _find_powershell()
    if not ps:
        _log("ERROR: powershell/pwsh not found")
        return 2
    if not os.path.isfile(ps1_path):
        _log("ERROR: script not found: %s" % ps1_path)
        return 2
    version = _read_ps_version(ps1_path)
    client = ServeClient(ps, ps1_path, default_timeout=timeout)
    try:
        client._spawn()
    except Exception as e:
        _log("ERROR: cannot start -Serve: %s" % e)
        return 2
    _log("ready (version=%s, tools=%d)" % (version, len(mcp_tools())))
    try:
        for raw in iter(sys.stdin.buffer.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as e:
                _write_mcp(_mcp_response(None, error={"code": -32700, "message": "Parse error: %s" % e}))
                continue
            # 批量请求（JSON 数组）：MCP 允许，但客户端极少用；逐条处理并回数组。
            if isinstance(msg, list):
                outs = []
                for one in msg:
                    resp, _ = handle_mcp_message(one, client, version)
                    if resp is not None:
                        outs.append(resp)
                if outs:
                    _write_mcp(outs)
                continue
            resp, should_exit = handle_mcp_message(msg, client, version)
            if resp is not None:
                _write_mcp(resp)
            if should_exit:
                break
    finally:
        client.close()
    return 0


def main():
    ap = argparse.ArgumentParser(add_help=True,
                                 description="multi-code-platform-searcher Python 驱动")
    ap.add_argument("--out", default=None, help="把 ps1 的 stdout 落盘到该文件（JSON 推荐）")
    ap.add_argument("--ps1", default=DEFAULT_PS1, help="ps1 脚本路径（默认同目录）")
    ap.add_argument("--timeout", type=int, default=900, help="子进程超时秒（默认 900）")
    ap.add_argument("--encoding", default=None,
                    help="强制指定子进程 stdout 解码编码（默认自动：utf-8 → 本机 locale 代码页）")
    ap.add_argument("--verify", action="store_true",
                    help="按清单逐文件校验 sha256（不调用 ps1）；也可写 -Verify")
    ap.add_argument("--mcp", action="store_true",
                    help="以 MCP stdio 服务端运行（JSON-RPC 2.0，逐行 JSON；工具映射到 ps1 -Serve 的 repo/code/research/ping）")
    ap.add_argument("--mcp-timeout", type=int, default=180,
                    help="MCP 单次工具调用超时秒（默认 180；超时后重启 -Serve 并回 isError）")
    ap.add_argument("--manifest", default=None, help="清单路径（默认自动找 skill-assets.json）")
    ap.add_argument("--all", action="store_true", help="-Verify 时列出全部 OK 文件")
    ap.add_argument("--root", default=None, help="-Verify 时以该目录为根（默认 mcps.py 所在目录；用于校验安装副本/临时树）")
    ap.add_argument("--json", action="store_true", help="-Verify 时输出 JSON")
    # 兼容 ps1 风格：把 -Verify / -Manifest <p> 归一成 argparse 形式
    _argv = list(sys.argv)
    for i, a in enumerate(_argv):
        if a == '-Verify':
            _argv[i] = '--verify'
        elif a in ('-Mcp', '-MCP'):
            _argv[i] = '--mcp'
        elif a == '-Manifest' and i + 1 < len(_argv):
            _argv[i] = '--manifest'
        elif a == '-Root' and i + 1 < len(_argv):
            _argv[i] = '--root'
    args, passthrough = ap.parse_known_args(_argv[1:])

    if args.mcp:
        if passthrough:
            _log("WARN: --mcp 忽略其余参数: %s" % " ".join(passthrough))
        return run_mcp_server(args.ps1, timeout=max(1, args.mcp_timeout))

    if args.verify:
        return verify_manifest(args.manifest, args.root or SKILL_DIR, as_json=args.json, show_all=args.all)

    ps = _find_powershell()
    if not ps:
        print("[mcps] ERROR: powershell/pwsh not found", file=sys.stderr)
        return 2
    if not os.path.isfile(args.ps1):
        print("[mcps] ERROR: script not found: %s" % args.ps1, file=sys.stderr)
        return 2

    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if os.path.isdir(LOCAL_BIN):
        env["PATH"] = LOCAL_BIN + os.pathsep + env.get("PATH", "")

    cmd = [ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", args.ps1] + passthrough

    try:
        p = subprocess.run(cmd, capture_output=True, env=env, cwd=SKILL_DIR,
                           timeout=args.timeout)
    except subprocess.TimeoutExpired:
        print("[mcps] ERROR: timeout %ds (use --timeout to raise)" % args.timeout,
              file=sys.stderr)
        return 4

    if args.encoding:
        try:
            text = p.stdout.decode(args.encoding)
            used = args.encoding
        except (UnicodeDecodeError, LookupError):
            text, used = _decode(p.stdout)
    else:
        text, used = _decode(p.stdout)

    if args.out:
        out_dir = os.path.dirname(os.path.abspath(args.out))
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        # 状态行保持 ASCII，避免在 GBK 控制台下再次产生乱码（C2 教训）
        print("[mcps] rc=%d stdout=%d bytes enc=%s -> %s"
              % (p.returncode, len(p.stdout), used, args.out))
    else:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
        sys.stdout.write(text)

    if p.returncode != 0 and p.stderr:
        try:
            sys.stderr.write(p.stderr.decode("utf-8", errors="replace")[-2000:])
        except Exception:
            pass
    return p.returncode


if __name__ == "__main__":
    sys.exit(main())
