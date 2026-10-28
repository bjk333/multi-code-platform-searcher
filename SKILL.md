---
name: "multi-code-platform-searcher"
license: MIT
compatibility: "**实测**：Windows（PowerShell 5.1 与 pwsh 7）、Linux（pwsh 7，容器实跑）；macOS 未实跑。运行时：Windows PowerShell 5.1 或 PowerShell 7+（pwsh）；可选 Node.js ≥18（node 引擎 / Node 门禁）；需可访问 GitHub、Gitee、GitLab、Codeberg 与研究信源公网 API；令牌经 .env 提供（GITHUB_TOKEN / GITLAB_TOKEN / DEEPSEEK_API_KEY 可选，前两个缺失时对应源记 blocked 不静默，DEEPSEEK_API_KEY 缺失时该付费源整体不进 Requested）"
description: "统一技术调研与代码仓库搜索：规划官方文档、论文、博客、论坛等来源的检索计划，并发现 GitHub、Gitee、GitLab 上的相似项目；代码证据用 GitHub 第一方 /search/code（主引擎）、GitLab /search?scope=blobs（复用 GITLAB_TOKEN）、grep.app、Stack Exchange 社区实现证据（SEExcerpts）、Sourcegraph（兜底）查找公开实现，-RepoScope 可在指定公开仓库内检索（searchcode）；另支持 Hugging Face Hub（models/datasets/spaces）、arXiv 论文、Stack Exchange 技术问答、Hacker News 社区讨论、**DeepSeek 网页搜索（DeepSeek 官方 Search API，2026-10-17 上线；需 DEEPSEEK_API_KEY，未配置时该源不进 Requested）** 与 npm/crates.io/Maven 包注册表（-ResearchSources 开关）作为 AI/学术/社区研究信源；-Auto 由 query-planner 自动分类并一次进程内跑多模式；另有 `-Package \"<生态>:<包名>\"` 精确包元数据（deps.dev 免 key：默认版本/许可证/发布时间/已知安全公告数）。"
metadata:
  version: "1.80.0"
---

# 技术调研与多代码平台搜索

两类能力：① **技术资料调研**（`query-planner.ps1` 规划官方文档/标准/论文/博客/论坛检索计划）；② **代码仓库搜索**（GitHub/Gitee/GitLab/Codeberg 仓库发现 + GitHub 第一方 /search/code、GitLab blobs、grep.app、SEExcerpts、Sourcegraph 代码证据 + `-ResearchSources` 研究信源：HF/arXiv/SE/包注册表）。

触发词：`全网搜索`、`技术调研`、`查官方文档`、`找论文`、`搜索博客和论坛`、`搜索开源项目`、`找类似项目`、`查找代码实现`。

边界：普通技术资料问题优先调研流程；涉及开源仓库、代码实现、下载源码或模块移植时，必须启用代码仓库搜索流程。两类结果不能互相替代。

## 适用边界（U-117）

| 问题 | 首选证据 | 本技能能做什么／不能做什么 |
|---|---|---|
| 概念定义、标准正文、API 是否废弃、现行规范 | **直接阅读发布方的官方原文**并记录版本/日期 | `query-planner.ps1` 可规划入口；`-ResearchSources` 并不读取官方规范，不可用包/论文/问答条目替代官方原文。 |
| 寻找可对照的开源项目、标杆实现或具体代码 | 结构化仓库发现 + 代码证据，随后回读源码/许可证/测试 | `-Platform All` 找候选、`-CodeEvidence` 查实现；只有 `coverage` 可用且逐项验证后，候选才可进入对照，不把 Stars 当质量证明。 |
| 论文、包版本、技术问答和社区反馈 | 研究源的候选记录，再回读原论文/官方包页/讨论上下文 | `-ResearchSources` 的来源约为**包注册表／论文／问答（兼社区）**；可补召回，不是概念或标准的权威结论。 |

**低置信度/0 命中不当否定证据**：先看 `coverage.Blocked/Degraded/Reasons`、token 与来源时效，再改查询并用官方原文交叉核查。端到端“标杆发现”用法见 `references/端到端范例.md`。

## 运行前

- **PowerShell 执行策略坑（2026-09-18 实测）**：本机默认禁止运行脚本，直接 `& .\multi-platform-searcher.ps1` 抛 `PSSecurityException: 在此系统上禁止运行脚本`，**且宿主 stdout
  完全无输出**——极易误判成"脚本跑了但没结果/引擎全挂"。开跑前先放开当前进程：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。（另注：本宿主 PowerShell 工具的 stdout 常被吞，诊断时把结果 `Out-File` 落盘再用 Read
  读回，别靠回显判断。）
- **代理可能在 localhost 且存活（U-156/U-155）**：2026-09-06 某沙箱确曾注入死代理，但不能据 `127.0.0.1` 字样删除当前机器**活**代理。默认 `-ProxyMode auto` 针对本次真实请求 URL 逐域 HEAD/必要时轻量 GET 短探活，按 `MCPS_PROXY` 白名单→进程代理→系统代理→直连选择；只有确认候选全部不可达才 `network-unavailable` skip（HTTP 4xx/5xx、TLS/超时不误判）。如宿主已确认只许直连，用 `-ProxyMode direct`，不要盲清代理环境变量。
- **★ 同目录 Python 驱动 `mcps.py`（2026-09-24 从 B 支线回港）**：`python mcps.py -<任意 ps1 参数> [--out <文件>] [--timeout <秒>]`
  —— 以 `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` 调起子进程（**只在子进程生效、不需管理员、不改机器/用户级策略**），
  并把 `<skill>/tools/bin` **前置**进子进程 PATH ⇒ 放进去的 `rg.exe` 可被 `-LocalCodeSearch` 发现（v1.37.1 起直接跑 ps1 也会探测 `tools/bin`）。
  `tools/bin/rg.exe` **不入库**；新机器用 `tools/fetch-ripgrep.ps1` 一条命令恢复（官方 ripgrep 15.2.0，双 sha256），说明见 `tools/bin/README.md`。
- **mcps.py `--out` 落盘编码坑（2026-10-03 本机实测）**：`python mcps.py ... --out <file>` 以宿主控制台代码页（本机 cp936）写盘；后续用 Python 默认 utf-8 `json.load` 会抛 `JSONDecodeError: Expecting value`。消费 `-AsJson` 结果时：用 Read 工具读回，或 `open(path, encoding='cp936')` 再解析；不要把该错误误判成脚本没跑。
- **本地代码检索前置条件（T5-1）**：`-LocalCodeSearch` 需要 rg/ugrep；Windows 新机器先按 `tools/bin/README.md` 恢复官方 `rg.exe` 到 `<skill>/tools/bin/`，
  再运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fetch-ripgrep.ps1 -Check`（rc=0）和 `python mcps.py -Doctor -AsJson`（`tools[].Present` 中 rg 为 true）。
  `bin/` 是兼容优先路径、PATH 为兜底；缺二进制时不要把本地 0 命中写成源码不存在。`tools/bin/README.md` 也链回本段。
- **数据外发与隐私（v1.53.21）**：本技能只把**检索词 / 过滤条件 / 仓库与包坐标**发给被你选中的公开源；**不上传**本地文件内容，**无遥测**、无自建上报端点。
  完整域名清单（从代码枚举）、令牌处理、缓存留存与 DeepSeek 计费归属见 `references/数据与隐私.md`。注意：`-Doctor` 会向各研究源发固定占位词 `__mcps_probe__` 的轻量探活；只加 `-LocalCodeSearch` **不等于零外发**（本地 0 命中会降级远程）。
- **★★ B/A 发布基线（v1.80.0，2026-10-28：同一份输入，两层判定相反）**：
  请求键白名单 v1.79.0 用大小写不敏感的 `-notcontains`：`{"op":"repo","keyword":"x","MinStars":5}` 在 `-Serve` 被放行（PS 属性读取也不敏感 ⇒ 值真被用上），mcps.py 却判 `unexpected arguments`；现改 `-cnotcontains` 逐字匹配（`op` 仍宽容），U-295-H3 让 26 个 (op,变体) 两层同判 + 全小写对照 + 退回必红。仓内指针见 `reports/gates/`，**A = B = v1.80.0**。
- **★★ B/A 上一基线（v1.79.0，2026-10-28：拼错的请求键不许静默忽略）**：
  schema 的 `additionalProperties:false` 只被 MCP 层执行，`-Serve` 按分支逐个取 `$req.<key>`、其余键**静默丢弃**：`{"op":"repo","keyword":"x","minStar":5}`（少一个 s）按默认 minStars=100 检索、返回 0 条且无告警（v1.74.0 的「拼错的开关」在 JSON 层重演）。
  现抽 `Get-ServeKeyPolicy`/`Get-ServeUnknownKeys` 在**分发前**拒并回显 allowed；U-295-H 与 `MCP_TOOL_OPS` 逐 op 两向对账 + 真起 `-Serve` 三行探针（拒+点名 / 合规必过 / 拼错键 ms<5000 未触网）+ 三变异。仓内指针见 `reports/gates/`，读数见 `_验收_全量_20261028/`，**A = B = v1.79.0**。
- **★★ B/A 上一基线（v1.78.0，2026-10-28：数值边界写了，两层都不看）**：
  `inputSchema` 的 `minimum`/`maximum`/`default` 此前既没被 `build_tool_request` 校验、`-Serve` 也只夹 `limit`/`maxResults`（`minStars=-1`、`activeWithin=40000` 原样穿过）；现统一 clamp（纯函数 `Get-ServeBoundedInt`，入口四处显式实参），U-295-G 两层真跑 + schema↔调用点严格相等。**A = B = v1.78.0**；读数见 `_验收_全量_20261028/`。
- **★★ B/A 上一基线（v1.77.0，2026-10-28：参数面的第四份拷贝 · 文档里那张「白名单」表）**：
  `references/参数速查.md` 的 MCP 工具表自称「多一个就 `-32602`」却从无门读过：v1.77.0 前漏 2 个工具与 6 个键，而 SKILL.md 同一张表是全的（两份文档各说一套）。
  现 U-295-F 把表读回来与 `MCP_TOOL_OPS` 比「工具 / op / 键」双向点名 + 四条文档变异；SKILL.md 只比工具名（该列自述"关键参数"，不越界）。另修 U-136：扫描面减去 `.gitignore` 宣告的运行期产物（缓存里出现公开 S3 密钥 id ⇒ 门随活网变红）。**A = B = v1.77.0**；读数见 `_验收_全量_20261028/`。
- **★★ B/A 上一基线（v1.76.0，2026-10-28：参数面的**第三份拷贝** · MCP 层）**：
  参数面其实有三份：入口 `param` 块、`参数速查.md` 表格、**MCP 包装层**（`MCP_TOOL_OPS` 白名单 / 各工具 `inputSchema.properties` / `build_tool_request` 三张类型表，对照 `-Serve` 的 `$req.<key>` 读取集）。
  最危险的一格：白名单加键、忘了加类型表 ⇒ 放行却进不了 `req`，**客户端传了等于没传且不报错**（F8 的静默丢弃在 MCP 层重演）。现 U-295 加 E 层：四向对齐 + 真跑 `build_tool_request`（13 键逐个必须进 `req`，三档类型错必须抛）+ 四个变异各红一层；读数见 `_验收_全量_20261028/`。**A = B = v1.76.0**。
- **★★ B/A 上一基线（v1.75.0，2026-10-28：参数面按集合比对 · 计数口径的盲区）**：
  9d 与 U-60 都量「个数」，而改名与对换不改个数（`-UseRegexp`→`-UseRegex`、删一行补一行照绿）。现 9d 走纯函数 `Compare-ParamSurface` 两向点名，U-295 五层覆盖集合 / 三条"计数相等但集合不等"的变异 / 死参数 / 接线自检 / **跨实现等价**。**A = B = v1.75.0**；读数见 `_验收_全量_20261028/`。
- **★★ B/A 上一基线（v1.74.0，2026-10-28：全量验收 F8 · 拼错的开关不再被静默忽略）**：
  简单 `param()` 块（无 `[CmdletBinding()]`）会把未声明的具名参数丢进 `$args` 后**静默丢弃**（`-CodeSearch`/`-Zzzz` 都 rc=0）；
  现声明 `[CmdletBinding(PositionalBinding = $false)]`，未知具名参数与裸位置参数在**绑定阶段**即失败（双运行时 FQID = `NamedParameterNotFound` / `PositionalParameterNotFound`），U-294 四层 + 反向控制守住。
  读数与未覆盖项见 `_验收_全量_20261028/`。**A = B = v1.74.0**。
- **★★ B/A 上一基线（v1.73.0，2026-10-28：验收收口 · 副本"多余文件"第一次有观测面）**：
  病灶是"只查一个方向"：U-138 只查「清单 → A」（发全了没），**没有门查「A → 清单」**，于是 `.github/workflows/*.yml`（从不在发货形态里）能留成两周前的旧版、`说明书.md` 能停在一个月前 —— 不报错、不影响哈希、不进任何报告。
  现 U-293 真遍历 A，断言「清单外文件 ⊆ 已声明白名单」；白名单四档逐项与发布器对账并各带负例，"遍历到的文件数 ≥ 清单条目数"当执行标记；另给 U-292 标 `gate-profile: installed`，让新判据在**安装副本**上也真的跑。读数见 `_验收_全量_20261028/`，**A = B = v1.73.0**。
- **★★ B/A 上一基线（v1.72.0，2026-10-28：全量验收整改 F2/F3 · 判据带上下文 + 根级退役）**：
  两处都是"判据与它要防的事不是一回事"：① `test-docs` 的字面转义判据原来全文查两个字符，分不清"文档在描述一条正则"（合法且必要）与"换行真被替换成字符"（损伤），v1.70.0 就带着这条误伤发布；
  现判据带上下文（围栏 / 行内 `代码段` 算示例，**正文**才算工件），抽成纯函数由 U-292 跑真值表 + 3 条可执行变异（拆豁免、拆检出面各自崩）。
  ② 发布器只 copy 不 delete 而 U-279 只碰受管目录 ⇒ 根级"有意不随发"的文件永远留着（A 的 `说明书.md` 停在 10-20）；现 `Remove-PublishResidue -NotShippedFiles` 按登记表退役、不看源仓是否存在，保护名单仍优先。
  两侧同表（U-292 A 真值表+变异 · B 接线 · C 用 U-248 真值表的合成目录真跑）。**A = B = v1.72.0**。读数与原始日志外置在工作区 `_验收_全量_20261028/`（`reports/` 棘轮无余量；仓内指针见 `reports/gates/`）。
- **★★ B/A 上一基线（v1.71.0，2026-10-28：全量验收整改 F1 · PS 套件进发布凭证）**：
  病灶是"凭证只盖了一半"：`test-docs` 判 `SKILL.md` 含字面反斜杠 n 工件的那条红从 10-26 起就存在，而 v1.70.0 照发 —— 因为发布器只读 `.gate-green.json`，那张凭证**只由 Node runner 写**。
  现在 `tests/run-tests.ps1` 落 `.ps-gate.json`（`mcps/ps-gate/1`：version/runtime/localOnly/passed/failed/skipped/exitCode/finishedAt），
  `publish-skill.ps1` 的 `Test-PsGate` 默认拒绝：缺文件 / `failed≠0` / `exitCode≠0` / `-LocalOnly` / 版本不符 / 超龄 24h；
  判据两侧同表（U-291 A JS 真值表 · B AST 抠出 PS 函数逐例比对 · C 接线 + 4 条变异负例）。
  前后读数、未覆盖项与原始日志见工作区 `_验收_全量_20261028/`（`reports/` 棘轮已无余量，本批不新增仓内证据）。
- **★★ B/A 上一基线（v1.70.0，2026-10-27：结构批 B3-17 · 三道静态门改跑产品）**：
  这一批没有改产品，改的是三张"证书"的**成色**：
  ① T2-8 规划器——原门只断言"源码里有 `技能/分发/CI` 这几个字"与"夹具文件里写着 `Expected = 'integrated_research_and_code'`"。
  词在词表里 ≠ 词生效（大小写、词边界、被 `Replace` 掉、被后面分支抢先都长得一样），夹具里写着 Expected ≠ 规划器真给那个值。
  现在每条臂真跑 `query-planner.ps1`，同时钉 `queryType` 与 `engineCandidates`（判词对、候选池错，用户侧就是"多跑一轮 + 结果混进仓库条目"）。
  ② T2-7 Gitee 相关度地板——原门**在 JS 里重写了一遍过滤规则**（拿 PS 里的 mock body 再算一次"应保留哪些"）。
  产品把 `-or` 改成 `-and`，门里那份 JS 不会跟着变 ⇒ 门绿着、产品已经错了。现在由产品自己算：三行输入两行输出，被剔的就是暗网门户；
  另加一条 `awesome-*` 臂（分数给到榜首也不行）证明它与地板是**两条**规则。
  ③ T1-5 源码优先/文档兜底——原门 grep 三段源码。现在跑整个 CLI（离线回放）三个臂：混合命中 ⇒ 只剩源码且告警说"过滤 2 条"；
  只有文档 ⇒ 全部保留但明说"兜底、不能当源码证据"；同一语料走 `-Auto` ⇒ 3 条全留、**不出现**这两条告警（闸只在纯代码模式生效）。
  第三条臂是前两条的**范围控制**：没有它，把闸改成"永远过滤"也能让第一条绿。
  同批还撞出发布器一处**静默空操作**：`-StampOnly` 配 `-RegenerateMirror` 会在算哈希前 `exit 0`，
  于是"一个戳都没盖"却输出三行绿字、退出码为零（实测：清单 version 还是旧的、新文件没登记）。现已 fail-closed 拒绝，
  门 U-249 加了一条判据与一个变异。
  **A = B = v1.70.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §20。
- **★★ B/A 上一基线（v1.69.0，2026-10-27：结构批 B3-16 · 两条"判词"级别的门改跑产品）**：
  U-120 以前读源码断言"`return 'none'` 写在 `return 'partial'` 前面"。顺序确实重要，但**用户看到的是 verdict 这个词**：
  两句一换位，行为就变成"一个都没查成，却告诉你部分成功"——这种错不报错，只骗人。现在三条臂各跑一次 CLI：
  Executed=0 + 有阻塞 ⇒ `none` 且进程退出码非零；有执行 + 有阻塞 ⇒ `partial` 且进程退出码为零；全禁用 ⇒ `no-engines`。
  后两条把"进程退出码只回答这次有没有结论"钉成了行为（partial 若也算失败，多源聚合下几乎每轮都非零，退出码成常量噪声）。
  U-175 以前 grep `AND 语义` / `不自动放宽` 三处正则，证明不了"只在 ≥3 词时附注"和"真的只发一次请求"。
  现在跑 SE/HN：3 词 ⇒ reason 写明 AND 与词数；2 词 ⇒ 不许附注；**两种都只许一次 HTTP**（放宽必然多打一次，
  而"多打一次"在结果集上与"只发一次"完全同形）。
  **A = B = v1.69.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §19。
- **★★ B/A 上一基线（v1.68.0，2026-10-27：结构批 B3-15 · 主流程首次有了行为门）**：
  U-182（零产出告警）与 U-115（缺凭据单列）此前只能 grep 源码：能证明"代码里写着 ≥3 这个门槛"，
  证明不了"3 个源时真的告警、2 个时不告警"。现在它们**跑整个 CLI**（离线回放）：夹具跑一遍引擎 →
  按夹具记录重建 `responses.jsonl` → `MCPS_REPLAY_DIR` 下整条主流程跑一遍 → 断言落在
  `warnings[]` / `coverage` / `execution.ledger` 上（那是调用方真正读到的字段）。
  做这件事时先修了**回放接缝自己**：录到的 500 曾被当成 200 返回 ⇒ 引擎拿到空正文后报
  "检索成功但 0 命中"，把"源挂了"说成"没有"（U-286，回退即红）。另外 POST 正文改 `[ordered]` ——
  PowerShell 哈希表枚举顺序逐进程不同，回放键取正文哈希，不固定就永远 miss。
  **A = B = v1.68.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §18。
- **★★ B/A 上一基线（v1.67.0，2026-10-27：结构批 B3-14 · 证据外置从手工变工具）**：
  `reports/` 被 `tests/reports-quota.json` 钉死，而每个版本必然 +1 张门日志、+1 份 Statement ⇒ 每次发版都要"挑两旧的外置"。
  这件事 2026-10-27 一天做了五次，全是手抄 python；其中一次**选中了还被 08-实施记录 引用的日志**，删完才想起 grep。
  现在它是一条命令：`scripts/archive-reports.ps1`（复制 → 校验哈希 → 追加 MANIFEST → 删源），并带四条安全边界：
  只收 `reports/` 下 · 保护名单拒绝 · **被任何文档引用即拒绝**（`-AllowCited` 才放行，且留痕）· `-DryRun` 预演。
  配套**保留策略**（U-285-G）：`reports/provenance/statement-*.json` 只许留最近 3 份且当前版本必须在 —— 没有这条，
  "更方便的删除命令"并不能阻止证据无限堆积。
  **A = B = v1.67.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §17。
- **★★ B/A 上一基线（v1.66.0，2026-10-27：结构批 B3-13 · GitLabBlobs 发现链 + 夹具自身的洞）**：
  补上最后一条没被覆盖的引擎路径：不给 `-RepoScope` 时的「全局 blobs（免费版恒 403）→ 项目搜索 → 逐项目 blobs（4 次预算截断）」。
  5 条臂分别钉：全局直接命中（1 次检索 + 补路径）、**403 回退后结果照给但 failure 必须留痕 forbidden**、
  **预算耗尽 = `budget-truncated`（我方主动放弃，不是 error）**、真·零命中（failure 为 null）、
  **项目搜索 401 必须上抛**（吞掉就变成"库里没有"的假结论）。
  这一批真正的发现不在产品，在**夹具**：传输接缝调了 `ConvertTo-FixtureUri`，而它不在 `Get-HttpLayerClosure` 里
  ⇒ 嵌套 runspace 里的 `Invoke-ApiWebOnce` 只剩 CommandNotFound，被产品的 `catch` 吞成 0 命中。
  于是整条"逐项目 blobs" fan-out **永远测不到**，而症状与"源没数据"同形。接缝改成自包含后同一批臂才真的跑到那条路。
  **A = B = v1.66.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §16。
- **★★ B/A 上一基线（v1.65.0，2026-10-27：结构批 B3-12 · 26 个引擎全部有行为臂）**：
  补上最后两个：HuggingFace（**三次顺序请求**：models/datasets/spaces，失败分"全挂 / 部分挂"两档 ——
  部分失败被"有结果"盖住，等于把不完整当完整）与 DeepSeek（唯一**计费**源：401/402/429/403 四档 + `filtered`，
  402 决定"去充值"、`filtered` 决定"调阈值"，两者都不是"源没结果"）。
  同时把上两批"看过但没验过"的两句话变成证据：DepsDev 的 404 **靠 StatusCode**（正文不含 "404" 也判 empty）、
  OpenAlex 的 429 **靠构造的字符串**（重试耗尽那条路与正文无关）。
  新增元门 U-274-H：从**产品侧**枚举 `function Search-*`，要求每个名字都在行为层被点名 ——
  覆盖率不再靠人报数（26/26）。**A = B = v1.65.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §15。
- **★★ B/A 上一基线（v1.64.0，2026-10-27：结构批 B3-11 · 封套类引擎的状态码分档）**：
  GitHub 与 GitLabBlobs 不返回结果数组，返回 `contract=engine/1` 的**封套** —— 所以它们套不进"数结果条数"那套执行器
  （`count` 恒为 1，"1 条结果"与"1 个封套"同形）。这 15 条臂拆封套，钉的是 `failure.reasonCode`：
  401 ⇒ `missing-credential`、403+配额 ⇒ `rate-limited`、403 ⇒ `forbidden`、500 ⇒ `error`、零命中 ⇒ **不带 failure**。
  其中两件事只有真跑才看得见：① GitHub 的**松弛链**（原查询 → 去语言 → OR 放宽）每一档都真发一次请求；
  ② GitLabBlobs 的 401 判据里，`"$_"` 在 PS 7 上是**响应正文**，线上正文恰好写着 "401 Unauthorized" 所以"碰巧"对
  —— 正文换个措辞（`{"message":"Bad credentials"}`）就退化成 `error`。已按"异常消息 + 正文"双源修，回退即红。
  **A = B = v1.64.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §14。
- **★★ B/A 上一基线（v1.63.0，2026-10-27：结构批 B3-10 · 最后三个"同形"引擎并不与谁同形）**：
  上一批把 GitHubCode / SearchCodeRepo / Sourcegraph 记成"普通 JSON，与已覆盖者同形，价值最低"。
  真跑后这句话被自己的夹具证伪：Sourcegraph 是 `event:` + `data:` 双字段的 SSE，且同一个 403 有**三种**
  结局（边缘防火墙 / 匿名 / 带令牌）；GitHubCode 是**多取 → 客户端重排（源码优先）→ 截断**，且"没令牌就
  一条请求都不发"；SearchCodeRepo 是 POST 仓库级，预览由 `context_before/after` **拼**出来、Url 用响应里的
  `commit_sha` 拼。这一批的产出不是"又多 21 条臂"，而是**两处真缺陷**：
  `"$_"` 在 PS 7 上取到的是 **ErrorDetails（响应正文）**，403 的状态码因此丢了（三档归因退化成通用 error）；
  401 的判定写成 `-is [System.Net.WebException]`，PS 7 下 `auth_missing` 变 `error`。两处都改成"异常消息 + 正文"
  双源判，回退任一写法，对应臂立即红（做过后向验证，不是"应该会红"）。
  同时修了尺子：只 import 执行器（不直接 import 探针）的入口曾被判成静态 —— `engines/engines2` 两个门归位。
  **A = B = v1.63.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §13。
- **★★ B/A 上一基线（v1.62.0，2026-10-27：结构批 B3-9 · 行为层补第四类传输）**：
  行为层从 15 个引擎扩到 **18**，挑的是**传输方式与前面都不同**的三个：GrepApp（MCP over JSON-RPC，
  问题在 POST 正文、响应是 SSE、限流时是 `HTTP 200 + result.isError`）、DepsDev（两请求串联，
  第二个 URL 由第一个的 `isDefault` 拼出）、StackExchange（`q` 是 AND 语义，长查询结构性零命中）。
  另加 LocalCode 五条 —— 它**没有网络**：`ok` / `empty` / `tool_missing` / `error` 四种结局必须分得开，
  夹具是一个会真收参数、真打印的**假 rg**。执行器同时补了两处：POST 臂必须断言正文、
  `$null` 不再被当成"一条结果"（`@($null).Count` 是 1，曾让零命中判据整片失效）。
  **A = B = v1.62.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §12。
- **★★ B/A 上一基线（v1.61.0，2026-10-27：结构批 B3-8 · 发布副本退役）**：
  发布不再只"复制 + 覆盖"：清单不再发货的文件会从安装副本里**撤下**。实测 A 副本
  `manifest=308 / actual=1200 ⇒ extra 892`（`reports/**` 880 + `tools/audit/*` 3），
  副本其实是历次发布的**并集** —— 那正是 `--profile=installed` 跑出另一套结果的原因。
  退役**三条同时成立**才删：受管目录内（清单顶层目录 + 声明的 `reports`）· 不在本轮清单 · 非保护名单；
  根级散文件一律不碰。`-WhatIf` 可预演，`-NoPrune` 一并关闭；U-279 用合成目录跑真值表。
  **A = B = v1.61.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §11。
- **★★ B/A 上一基线（v1.60.0，2026-10-27：结构批 B3-7 · 跨平台实跑）**：跨平台实跑：已验证 Windows、Linux
  （门数、红绿、环境事实都在 `reports/crossplat-2026-10-27-win32.json` 与 `-linux.json` 里，
  本处不重写读数；容器镜像 `tests/crossplat.dockerfile` 以 `SHIMS=0` 构建 —— 不靠别名换绿）。
  macOS **尚未实跑**：`crossplat.yml` 矩阵里有它，但没有绿记录 —— 本行不写 macOS。
- **★★ B/A 上一基线（v1.59.0，2026-10-27：结构批 B3-6 · 仓库瘦身）**：
  `_archive/`（163 MB / 3,199 文件，本就在 .gitignore）移出工作区 ⇒ 产品目录 242 MB → 80 MB。
  `reports/` 分档：**被门/文档按路径或文件名点名的证据 + 现行验收批**留在仓内（537 个），
  其余过程产物（2,071 个）移到外部归档并留 `MANIFEST.tsv`（size / sha256 / mtime）。
  产品目录 tracked **2,914 → 855**；证据索引新增 §2b「已外置规则」，门对它**反向**断言
  （登记为已外置就必须真的不在仓里）。**发布维持 301**：其中 227 是测试套件，随包是为了安装副本能自证。
  **A = B = v1.59.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §9。
- **★★ B/A 上一基线（v1.57.0，2026-10-27：结构批 B3-4 · 门的分层记账）**：`meta_red` 从 `product_red` 拆出（退出码 5，仍拦发布），
  只有 `tests/static-quota.json` 登记的门才可能是 meta；静态门冻结名单只降不升。详见同 §6。
- **★★ B/A 上一基线（v1.56.0，2026-10-26：结构批 B3-3b · 行为层扩面）**：行为层从 8 个引擎扩到 15/25（48 条臂 + 3 条形状臂），
  并抓到 4 个引擎的限流判据漏认产品自己的「限流等待过长」文案；**A = B = v1.56.0**，详见同 §5。

- **★★ B/A 上一基线（v1.54.0，2026-10-26：结构批 B3-2 · 模块拆分）**：
  入口只留「参数 → 路径解析 → 加载 lib/ → 主流程」，函数按领域进 `lib/` 的 8 个模块（config/core/net/http/quality/engines/doctor/serve）。
  **拆分的判据是行为等价，不是整洁**：4 份回放语料逐字节一致（除已声明的时序字段）才算过；
  静态门经 `tests/lib/source.mjs` 的 `sourceAll()` 按入口声明顺序把模块展开回加载点，
  所以「函数在哪个文件」不再是任何门的判据；**入口行数/版本锚点/模块地图**这类判据必须读入口原文（`readMain()`）。
  新门 U-273 守形状：入口 ≤1,500 行、模块各 ≤2,000 行、声明 ↔ 文件双向一致、模块顶层只许定义与 `$script:` 数据。
  **A = B = v1.54.0**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §3。
- **★★ B/A 上一基线（v1.53.39，2026-10-26：全量验收整改二）**：
  ① **两种运行面**：在**安装副本**上跑全量 Node 门会一片 ENOENT —— 缺的是 `reports/` 下的**仓库侧证据**，
  不是产品缺陷。副本/CI 冒烟用 `node tests/run-node-gates.mjs --profile=installed`（按"测试源码是否引用 reports/"自动分类）；
  仓库内仍用默认 `--profile=repo`，发布凭证只认它。② 文档门负例的正则只认 LF（JS 里 `.` 不含 `\r`），
  在 CRLF 的 SKILL.md 上恒不生效 ⇒ 改成正则 `\r?` 后接换行（即允许 CRLF）。**A = B = v1.53.39**，详见 `reports/验收-全量-2026-10-26/验收报告.md`。
- **★★ B/A 上一基线（v1.53.38，2026-10-26：全量验收整改 U-268 · 固定"现在"）**：
  全量验收跑门时抓到 `U-267-A[repo-gitee]` 的 `ScoreParts.recency` 与基线不一致 —— `recency = exp(−ageDays/365)`
  用的是真实时钟，隔几小时就会跨过三位小数的取整边界 ⇒ **golden 每天自己变红**，最后一定被"重录一下算了"绕过。
  修法：`MCPS_FIXED_NOW`（ISO8601）在 `Get-ScoreParts` 内生效，语料表钉死；门加 D 臂反向断言
  （换固定时钟 ⇒ recency 必须变，防"加了 env 没人读"）。**A = B = v1.53.38**，
  详见 `reports/验收-全量-2026-10-26/验收报告.md`。
- **★★ B/A 上一基线（v1.53.37，2026-10-26：结构批 B3-1 第二步 · 回放语料扩到 4 模式）**：**不动检索逻辑**，把"一份语料"
  变成"一张语料表"——`tests/fixtures/replay/corpora.json` 是单一事实源，录制器与门读同一份。四份语料：
  research（9 源 38 条）/ repo（Gitee 18 条）/ code（SEExcerpts 5 条）/ package（DepsDev 1 条）。
  本机录不全的源在表里 `MCPS_DISABLE` 显式排除——基线里**不放 `replay-miss` 这种夹具工件**。
  `-Auto` 与 `-LocalCodeSearch` 仍未覆盖（依赖已死的 code 源 / 本机磁盘），留到拆分后补。
  门 U-267（7 条：4 语料各两次回放对拍 + 声明表防腐 + 空语料 loud 失败 + 改语料必改输出，50s）。
  **A = B = v1.53.37**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §2。
- **★★ B/A 上一基线（v1.53.36，2026-10-26：结构批 B3-1 第一步 U-267 · 离线回放）**：**活网不可能有稳定基线**——
  实测同查询两次：`ReasonCodes.GitHub` 从 `error` 变 `deadline`、`Verdict` 从 `partial` 变 `degraded`、`Executed` 成员不同、
  crates 的 `Stars`（其实是实时下载量）差 ±50。⇒ B3-2 拆分前先要回放：`MCPS_RECORD_DIR` 录制、`MCPS_REPLAY_DIR` 回放，
  接缝在 `Invoke-ApiWebOnce`（2xx 唯一出口）；未命中一律 `replay-miss` 抛出，绝不悄悄打真网。
  门 U-267 三层（两次回放除已声明时序字段逐字节一致 + 对 baseline 一致 + 空语料必须 loud 失败 + 改语料必须改输出）。
  **A = B = v1.53.36**，详见 `reports/验收-全维度-2026-10-25/08-实施记录-B3.md` §1。
- **★★ B/A 早前基线（v1.53.35，2026-10-26：契约批收尾 U-266 · 输出通道纪律）**：**进度串不许进"值"的通道**。
  `Write-ColorOutput` 被重定向时原走 `Write-Output`（成功流）⇒ 在 runspace 池里就是 `Invoke()` 的返回集合，
  引擎返回封套后集合变成 `[string, 封套]` ⇒ `ConvertTo-EngineEnvelope` 见数组即判 `engine/0`（引擎成功却记成旧契约）。
  改为写 stderr；产物（用法横幅 / 结果表 / Doctor 报告）走 `Write-PayloadOutput` → 成功流，否则 `> out.txt` 会变空文件。
  ★当时三条夹具是把该函数**桩掉**绕过的 —— 桩掉等于换一条被测路径，绿的是夹具；本批撤掉 u205 的桩、用产品原函数重跑仍绿。
  门 U-266（静态 + 真 runspace 执行 + 变异）。**A = B = v1.53.35**，详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §12。
- **★★ B/A 早前基线（v1.53.34，2026-10-26：B2-1 第 4/4 · 四核迁移完成）**：**GitLabBlobs 迁 EngineContract v1**。
  它独有的两件事各自逼出一条规则：① **自设预算耗尽判 `empty`**（`budget-truncated`，不是 error —— 判 error 会让引擎
  从 coverage 的 executed 组掉出，Verdict 可能落 `none`）；② `requests` **从账本按 engine 聚合**（请求散在 4 个辅助函数
  + 嵌套池里，手写必有漏），封套 `attempted` 必须与账本行数逐臂相等。门 U-265（十臂 + 账本交叉核对 + 5 变异）。
  ★迁移时抓到两个**既有**真缺陷：`-not ($data -and $data.message)` 对 N≥2 数组恒真（成员枚举返回 `@($null,$null)`）
  ⇒ **2 条以上真实命中被整段丢弃**；401 判据只认 `WebException`（PS7 下恒 false）且被 Discover 吞成回退 ⇒ 缺凭据被报成 `zero-hit`。
  **A = B = v1.53.34**，详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §11。
- **★★ B/A 更早基线（v1.53.33，2026-10-26：B2-1 第 3/4）**：**DeepSeek 迁 EngineContract v1**（唯一会走 402 的付费源）。
  `quota.class='prepaid'`；401/402/429/403 由 `failure.reasonCode` 承载（`missing-credential`/`quota-exhausted`/`rate-limited`/`forbidden`）。
  ★三层落点：verdict `blocked`、legacy **`error`**（不是 unknown —— 否则会被记进 coverage 的 NotRun，谎称"没跑"）、
  ReasonCodes `quota-exhausted`（schema 枚举 12→13 值）。★新判定：`filtered`（全被质量门槛丢掉）判 `empty` 而非 `error`。
  ★无 key 报 `not-run`（可选源"没打算用"≠"配了但失效"）；**零请求**。门 U-264（八臂 + 规则表 + schema 枚举不变量 + 5 变异）。
  **A = B = v1.53.33**，详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §10。
- **★★ B/A 上一基线（v1.53.32，2026-10-26：B2-1 第 2/4）**：**GitHub 迁 EngineContract v1** —— 返回封套、不自报 status；
  逐引擎请求账 `{attempted,succeeded,failed}` 与 `quota.class` 随封套上报；401/403 限流/403 权限三类改由
  `failure.reasonCode` 承载（`missing-credential`/`rate-limited`/`forbidden`），判定归 L1。门 U-263（六臂 + 5 变异）。
  ★同批抓到 `Write-ColorOutput` 在**输出被重定向**时走 `Write-Output` ⇒ 引擎的进度串会混进池里的结果集
  （`-AsJson` 不受影响）；夹具必须桩掉它，否则量到的是夹具。**A = B = v1.53.32**，详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §9。
- **★★ B/A 上一基线（v1.53.31，2026-10-26：B2-6）**：**成本账本 v0** —— 每次线上尝试一行 JSONL
  `{runId, seq, ts, mode, engine, attempt, httpStatus, outcome, reasonCode, latencyMs, quotaClass}`。
  `-AsJson` 的 `execution.ledger` 给汇总 `{runId, rows, path, written, error}`，硬恒等式 **`rows == metrics.Requests`**；
  落盘开关 `MCPS_LEDGER=<path>`（未设则只收内存，零磁盘写入），落地后按 `(runId, seq)` 唯一。
  402/429/5xx/transport 的归因由纯函数 `Get-ApiLedgerVerdict` 决定（**402 ⇒ `quota-exhausted`，且不重试**）。
  ★实现纪律：HTTP 闭包 43 → **47** 项；引擎归属用**每 runspace 的 `$script:`**（探针实测零串台），
  不用 AppDomain 共享标量（会互相覆盖 ⇒ 指错人）。门 U-261（六臂 + 真值表 12 行 + 落盘 + 真跑 + 5 变异）。
  **A = B = v1.53.31**。详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §8。
- **★★ B/A 上一基线（v1.53.30，2026-10-26：B2-5）**：`-AsJson` 顶层新增 **`execution`** 块（RunEnvelope v2 §3.3）——
  `{budgetMs, spentMs, reserveMs, truncated, skipped[], pools[]}`：预算花在哪、哪些源压根没跑、哪个池早停。
  `budgetMs=0` = **未设预算**（不编默认值）；`skipped[]` 与 `coverage.ReasonCodes` 同一份事实；
  `sufficient` 只放逐池（放顶层会掩盖"repo 够了、code 不够"）。判定收进纯函数 `New-ExecutionBlock`，门 U-260。
  ★同批两处真缺陷：单平台直连 `& ("Search-$pf")` 绕过并发池且不认封套（改走 `Invoke-EngineSerial`）；
  `Skip-ModeByBudget` 把"没跑"记成 `error`（改判 `budget-truncated`）。**A = B = v1.53.30**。
  详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §7。
- **★★ B/A 上一基线（v1.53.29，2026-10-26：B2-4 第一步）**：`Needs` 改由 **AST 传递闭包校验**（门 U-259）——
  引擎（含传递闭包）引用到的本仓函数必须 ∈ 手写 `Needs` ∪ `Get-HttpLayerClosure`(43)，**漏登记即红**。
  这条专治 U-02/U-40 那类**静默**事故：Runspace 里调用未定义命令会被 catch 吞成"没结果"，看起来像零命中。
  反方向（手写但不可达 = 多余注入）做棘轮：≤8 项、明细冻结，只许收紧。实测 23 引擎闭包 41–47 项/引擎，
  主导项是 HTTP 层 43 项 ⇒ 全量派生收益很小、代价是启动期解析与一种新失败模式，故**运行时仍用手写 Needs**。
  ★实现踩坑：用 `Test-Path "function:X"` 判"本仓函数"会被**宿主同名 shim** 污染（本机 safe-delete 垫片把
  `Remove-Item` 变成函数 ⇒ 每引擎凭空多 8 个 `*-SafeDelete*` 依赖）；改为只从本仓文件的 AST 收集函数定义。
  **A = B = v1.53.29**。详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md` §6。
- **★★ B/A 上一基线（v1.53.28，2026-10-26：B2 契约批首批）**：`HF` 引擎改返回 **EngineContract v1 封套**
  `{contract='engine/1', engine, kind, results, partial, elapsedMs, requests, quota, failure}`，**引擎不自报 status**；
  判定由池侧 `Resolve-EngineVerdict` 派生（ok/empty/degraded/blocked/error）再映射回既有内部状态串（覆盖率三分类一字不动）。
  旧引擎返回数组时由 `ConvertTo-EngineEnvelope` 现包 `engine/0`，**不派生 verdict** ⇒ 未迁移引擎行为逐位不变。
  ★同时纠正一条写错的前提：源码曾称「引擎在 runspace 内的 `Set-EngineStatus` 写不进父作用域」，**实测不成立**
  （ConcurrentDictionary 经 `_injectVars` 按引用注入，父侧立即可见；并发 6400 键零丢失）。封套要治的是旁路状态、
  文案正则反推 reasonCode、以及 requests/quota 无逐引擎口径这三件事。门 U-257（校验器 `pattern`/长度关键字）与
  U-258（三臂 + 兼容层 + 混跑 + 4 变异）。**A = B = v1.53.28**。详见 `reports/验收-全维度-2026-10-25/07-实施记录-B2.md`。
- **★★ B/A 上一基线（v1.53.27，2026-10-26：B1 止血批收口）**：`-Doctor` 新增 **`proxyCoverage`** —— 逐引擎 host 的
  「实际路由链 / `MCPS_PROXY` 白名单覆盖 / 本机 hosts 劫持」三列；路由结论取自 `Get-NetworkCandidates`（与真实请求同一函数，不另写白名单解析）。
  判读：`Whitelist=excluded` = 该域被 `;` 后的白名单排除、代理根本没进候选；只有「已无其他代理、只剩直连」才印红；hosts 指到回环只提示不判红（`socks5h` 由远端解析）。门 U-244。
  成因与实测（`gitlab.com` 被排除 ⇒ 等满 12.1s/17.1s 截止）见 `reports/验收-全维度-2026-10-25/06-实施记录-B1.md` §10。**A 线 = v1.53.26**（2026-10-26 已发布，发布等式 241/241 匹配）。
  **同批 B1-5 前半（门禁 provenance，U-245）**：`runGates` 记录 `run_mode`；并行跑出现 product 红时，CLI 只把**失败的文件串行复核一次** —— 串行过记 `env:flaky-parallel`（rc 仍 3，不冒充绿），串行又红或复核没跑成一律保持 product（fail-closed）。
  **同批 B1-5 后半（测量互斥，U-246）**：`.audit-lock`（version+pid+startedAt）跑前写、跑完只删自己那把；发布器见活锁即拒（坏 JSON/缺 `startedAt` 当活；超龄或进程不在才可接管），紧急放行用 `-IgnoreAuditLock` 并留痕；证据记 `versionAtStart/End`，不一致该轮作废。
  **同批 B1-4 前半（带红不许发布，U-247）**：跑完落 `.gate-green.json`（**开跑即作废旧凭证**，崩掉不留下一次绿）；发布器默认要求「product 红为 0」、`run_mode` 为 `serial` 或 `parallel+serial-recheck`（并行绿不算绿）、版本四方一致、未超龄 24h；紧急放行用 `-SkipGateGreen` 并留痕。
  **同批 B1-4 后半（白名单式 `-Prune`，U-248）**：发布后只清 `reports/_*` / `_verify/*` / `**/.cache/*` / `search_*.json` / `*.bak-*`；**绝不按「目标目录 − 清单」反删** —— 实测那会删掉 `.env` 与 886 份 reports 证据。默认开启，`-NoPrune` 关闭。
  **同批 B1-6（请求入账，U-256）**：`metrics.Requests` 由"延迟袋条数"改为 **attempted**（每一次真正走到发送的请求，
  含重试与 node 兜底；预算早退/主机已死不算），新增 `RequestsSucceeded`（2xx）/ `RequestsFailed`
  （**派生** = attempted − succeeded，恒等式 `Requests = Succeeded + Failed`）；旧口径改名 `RequestsReturned` 保留一个版本。
  `failed` 刻意不单独计数 —— 少记一次 attempt 会变成**负值**，比悄悄少 1 更容易被发现。
  门 U-256：**真跑 `Invoke-ApiRequest`**、只桩传输层，三臂（成功 / 传输失败走 node 兜底 / HTTP 500）+ 2 条可执行变异；读数见 `reports/验收-全维度-2026-10-25/06-实施记录-B1.md` §19。
  **同批 U-255（真 A 上发现的收尾）**：`-Prune` 删完文件会**留下空目录壳**（实测 `reports/_smoke-u240/{,agents,raw}` 三层；旧代码只硬编码清 `_verify` 一个名字）。改为自底向上收「白名单命名下的空目录」、非空立即停，且**必须与"这次有没有删文件"解耦**（没有文件可删时只剩空壳，挂在 victims 上就永远清不掉），**目录规则必须与文件白名单同源**（漏过 `**/.cache`）。这三条都是被真 A 与 harness 的 dirs 快照接连打脸才补齐的。
  **同批 U-254（dry-run 抓到的真缺陷）**：白名单 `reports/_*` 曾在真 A 上匹配到 `reports/verify-保留策略.md`（当时叫 `_…`，是 SKILL.md 引用的裁决记录）⇒ 会删掉该留的文档。两道处置：① 加否决权「**源仓也存在 ⇒ 不删，只告警**」（判据顺序要求保护名单先判，否则 `.env` 会被"源仓也有"豁免掉）；② 该文件改成不带下划线的名字 —— 它自己的 M-14 就写着"落 `reports/` 的文件名不得以 `_` 开头"。
  **同批 B1-4 收口（`-StampOnly`，U-249）**：只算哈希 + 回写清单/镜像，**不碰目标目录**。它存在的唯一理由是解开 U-139 的结构性死锁（镜像只在发布时更新，而发布要求门禁绿，门禁里就有 U-139）；它刻意跳过 U-246 锁与 U-247 凭证判据，并在输出里无条件留痕。三步次序：`-StampOnly` → 全量门禁 → 真发布。
  **同批门禁可达性（U-251）**：**门禁可以红，但不许无限等**。① runner 加 `--test-force-exit`（用例跑完就退，不等 handle 释放）；② 整轮墙钟兜底（默认 20min，`U153_MAX_WALL_MS` 可覆盖）—— 超时 `taskkill /T /F` 杀整棵树，并**同时**记 `hung` 与 `voided`（结果不完整、不可引用），`product 红 +1`，绝不冒充绿；② 的那条红名为 `gate run hung`，`why` 里写明"不完整/不可引用"。**不重试**（重试会把偶发挂变成偶发绿）。
  **同批两个相反目标的冲突处置（U-253）**：`NpmDownloadPolicy = fast | full`（环境变量 `MCPS_NPM_DOWNLOAD_POLICY` 优先）。`fast`（默认）= 主结果优先，search 用掉过半预算就跳过下载量补全并留痕；`full` = **预算设成无穷**、总是补全（评测要完整 `downloads` 字段）。★关键是 `full` **没有删掉守卫**，只是让"还有没有余量"的答案变成"永远有" —— 所以「主结果优先」这条契约在两种模式下都存在，门也不用放宽。
- **上一发布（v1.53.25，2026-10-25：止血批 B1-7）**：包注册表由「一个引擎串行 npm→crates.io→Maven」拆成 **`Npm` / `Crates` / `Maven` 三个单一上游引擎**（一个引擎 = 一个上游），逐源截止按各自实测定值；npm 周下载量补全改短超时 + 「主结果优先」守卫。门 U-243。
  读数、红项归因、以及「为什么 Npm 截止取 13 而非 11」见 `reports/验收-全维度-2026-10-25/06-实施记录-B1.md` §9 与 `reports/gates/accept-2026-10-25/`。宿主按 **328 项清单**发布 A，A≡B。
- **上一发布（v1.53.24，2026-10-25：止血批 B1-1/B1-2）**：整轮总预算 `MCPS_TOTAL_BUDGET_SEC`（`-Auto` 默认 45s，池预算 = min(单池, 本轮剩余)，耗尽整段跳过并记账）+ 跨运行源健康记忆（`source-health.json`，冷源 `HealthProbeSec=6s` 半开探测而非跳过，TTL 600s 起翻倍至 1h；`-ResetHealth` / `MCPS_HEALTH=0` 可清/可关）。门 U-241/U-242。宿主按 **328 项清单**发布 A，A≡B。
  实测：repo 冷 14.1s → 热 6.6s（GitLab 12.4s → 1s 探测，结果数不变）；**Auto 无改善** —— 主因仍是 `Packages` 单引擎内部串行 npm→crates→Maven（20–26s），见 `reports/验收-全维度-2026-10-25/06-实施记录-B1.md`。
- **上一发布（v1.53.23，2026-10-25：多轮调研编排）**：新增 `research_rounds.py`（lane 工单 / 三轮 / 缺口 / 合并），检索仍走 `mcps.py`；不改主脚本检索行为。门 U-240。
- **上一发布（v1.53.22，2026-10-25：主题词路由）**：宿主按 **328 项清单**发布 A，A≡B。
  - 病灶：`-Auto "向量数据库"` / `"分布式锁"` / `"中文分词"` 全被判 `research_only` ⇒ **repo 池压根不跑**，而 `ZhTopicTermMap` 已能把它们映成 `vector database` / `distributed lock` —— 改写生效了却没用上。
  - 修：planner 增 `$topicTerms`（与主脚本词表**键集完全一致**，门 U-239 A 双向比对）+ 分支「命中主题词 ∧ 无研究信号（文档/论文/标准/最新/调研）∧ 非提问形状（什么是/如何/教程…）∧ 无否定 ⇒ `repository_only`」；主脚本追加 research ⇒ 实际 **repo+research**（不加 code 池）。
  - **刻意收窄**：`什么是向量数据库` / `如何设计限流` / `RAG 论文` / `今天天气怎么样` / 显式 `code` 语义都不改判 —— 真值表 + 负例在 U-239 B/D。
  - 门 U-239（词表双向一致 / 14 条分类真值表 / 分支顺序与守卫 / 模式映射 / 负例）。上批：v1.53.21 U-238 上架材料。
  **本行不写任何读数**（rc、通过/失败数、`product_red` 一律不写）——读数与红项归因查 `reports/gates/` 与当批 `reports/` 报告；基线唯一事实源 = `references/变更历史.md`「当前基线」行（U-59）。
  理由：用例/门数随批次增长，写死必漂（v1.45.2–v1.45.5 连续四批、v1.47.0 又漂一次）；**不要引用本行当门禁结论**。本条由文档门 G3 强制（`tests/test-r4-docs.test.mjs`）：写数字即红，删光 `reports/` 指针也红。
  TLS 兜底 POST 用 `-B <file>`；PS 7 的"传输异常伪装成响应"与"403 仅正文限流"均已修；**以上测试不等于其它机器上的系统级 TLS 验证**。
- **先跑 `-Doctor`**（v1.21.0）：校准能力边界——缺 `rg`/token/远程引擎健康一目了然，不再静默。
- 认证变量：`GITHUB_TOKEN`/`GITEE_TOKEN`/`GITLAB_TOKEN`（脚本仅读 env，不暴露）。
- **令牌可能已过期，而引擎不会主动告诉你（v1.36.0 实测）**：失效 token 曾使 GitHub 引擎对**任何关键词**都返回"0 命中"，且 `warnings=[]`、`Verdict=full`——**看似正常实则结论失真**。v1.36.0 起 401 会标 `auth_missing` 并进
  `Blocked`（`Verdict=partial`）＋写 `warnings[]`；**v1.36.1 起 `-Doctor` 会真正校验令牌有效性**（输出 `tokens[].Valid` / `Probe=HTTP <code>`，无效则进 `remoteBlocked` 并给出"请更新令牌"建议），不再只判断"是否设置"。**开跑前先
  `-Doctor`**；若结果稀疏再核对 `Verdict`/`Blocked`。本机用户级环境变量（如 `[Environment]::GetEnvironmentVariables('User')['GITHUB_TOKEN']`）里常有已配好的有效令牌，可直接写入 `.env`。
- **TLS 系统 CA 降级（v1.25.0）**：本机存在 HTTPS 拦截代理（如 Steamcommunity302 等，自签根仅装在 Windows 系统库）时，node/.NET 默认 CA 库不含系统根，`Invoke-WebRequest` 会 TLS 握手失败导致引擎集体降级。脚本现自动用 `node --use-system-ca`（读系统证书库）重试一次——`-Doctor` 里 `remoteEngines` 从不可达变可达即说明降级生效。无需手工配置。
- **★ 系统代理劫持 vs 本地接管（v1.36.2，2026-09-19 本机实测；这条最容易误诊）**：
  本机 WinINET 系统代理 = `127.0.0.1:10808`，而**该出口对境外站点超时**（`curl -x socks5h://127.0.0.1:10808 https://www.google.com` → 25s 无响应）；
  同时 `github.com` / `raw.githubusercontent.com` / `huggingface.co` 被 **Steamcommunity302** 的 hosts 接管到 `127.0.0.1:443`
  （其根证书在 **Windows 系统库**，.NET 走系统库 ⇒ **直连即可 200**：`curl -k https://api.github.com/rate_limit` 实测 200）。
  **而 PS 5.1 的 `Invoke-WebRequest` 默认吃系统代理、又没有 `-NoProxy` 参数** ⇒ 所有远程引擎被判 `unreachable`，
  `-Doctor` 会把它**误报成"GITHUB_TOKEN 无效/已撤销"**——`Valid=false / Probe=unreachable` 里的 `unreachable` 是**路不通**，不是令牌坏！（**v1.36.7 起**不可达记 `Valid=null`，remoteBlocked 写「不可达（无法判定有效性）」，只有 401/403 才判无效）
  ⇒ **历史** v1.36.2 曾在进程内默认置空系统代理以绕过那台机器的死代理；**U-156 起撤销全局绕过**，缺省 `auto` 保留系统代理候选，逐域对真实目标 URL 探活。仅明确有直连需求才用 `-ProxyMode direct`；显式 `MCPS_SYSTEM_PROXY=bypass` 只排除 auto 的系统代理候选，不改全局状态。
  ⇒ **判读口诀**：`Probe=unreachable` ⇒ 先查链路（别急着换令牌）；`Probe=HTTP 401` ⇒ 才是令牌问题。
  ⇒ 实测修复后：`GITHUB_TOKEN Valid=True / Probe=HTTP 200`；`-Keyword ... -AsJson` → `Verdict=full`、`Blocked=[]`、真实命中。
- **GitLab blobs 项目级回退（v1.26.0）**：GitLab.com 免费版禁用全局代码搜索（403），脚本自动回退

  「项目搜索 + 逐项目 blobs」——`-CodeEvidence` 里 GitLabBlobs 正常进 `Executed` 并返回命中；企业版/自托管实例
  仍走全局端点。无需手工配置。
 - **代码证据源的"实际产出源数"取决于凭据（U-109 定性，2026-09-27）**：`-CodeEvidence` 的 `coverage.Requested` 恒为 4 个 code 引擎，
  但缺 `GITLAB_TOKEN` 时 **GitLabBlobs 立即以 `auth_missing` 返回**（毫秒级、不发任何请求）并进 `coverage.Blocked` + `Reasons`；
  缺 `GITHUB_TOKEN` 时 GitHubCode 同样 `auth_missing`。⇒ **两 token 齐备 = 2 个产出源；只备 GitHub token = 实质 1 个源（GitHubCode）**：
  它一旦撞 `EngineDeadlineCodeSec` 截止，该轮就是 `coverage.Executed=[]`（U-120 起 verdict=`none`——零执行单列，不再借 `partial` 表达；之前是 `partial`，因为另一源 blocked）。
  这**不是"未接线"**，也不是静默失败——空轮原因可直接读 `coverage.Blocked` / `Degraded` / `Reasons` 三键（`measure-latency.ps1` 的
  `emptyReason` 粗分类：deadline / rate-limited / blocked / degraded / unclassified）。

- **Gitee 搜索换官方开源搜索 API（v1.28.0）**：`/api/v5/search/repositories` 已被 Gitee 服务端内容风控（任何 UA/IP/token 均返回空数组），现自动改用 Gitee 官方开源搜索站后端 `so.gitee.com/v1/search/widget/{widget}`（匿名可用、无风控；so 失败自动回退 v5）。
- v1.29.0：so API 结果客户端相关性重排（剔 awesome 噪音）；-NoCache 改为跳过读但照常写（刷新语义）。`Invoke-ApiRequest` 新增 `-NoProxy` 开关，so API 显式直连（比代理更稳）；PS5.1 响应中文乱码已修复（Latin-1→UTF-8 逆转）。
- **单技能 SOCKS5 代理（v1.27.0）**：.env 配 MCPS_PROXY=socks5://127.0.0.1:<端口>[;域名白名单]
  （如 ;gitee.com）即可让指定域名走本地代理（V2RayN/Clash），其余直连，不影响系统/DSH 全局。
  用途：Gitee（回国节点稳定详情/下载）、IP 信誉受限站点。注意 Gitee 搜索为接口级风控、grep.app 为 Vercel JS 挑战，代理均无效。
- **MCPS_DISABLE / MCPS_TIME_BUDGET_SEC（v1.33.0）**：`MCPS_DISABLE=grep.app,Sourcegraph`（逗号/分号分隔，匹配引擎名或显示名）显式跳过已知永久降级引擎——不进 `coverage.Requested`，写 `warnings[]` 可审计；`MCPS_TIME_BUDGET_SEC`（默认 120，0=不限）为单次运行总时长预算，超时引擎 Stop 并标 Degraded。**v1.53.4**：`-Auto` 执行前打印「N 个池 ⇒ 最坏 N×预算」—— 只告知，预算仍每池各计一次（跨池共享属行为变更）。
- **MCPRegistry 默认通路（D-2）**：官方注册表 `registry.modelcontextprotocol.io/v0/servers` 为默认源（匿名 200、无需 key）。
  Glama（需 `GLAMA_API_KEY`）评估后**不接入**当前链路；保留后续接入路径，不要把缺 key 当作 MCPRegistry 故障。
- **研究降噪用法**：宽概念关键词在 crates/npm 等源召回高频无关项时，加 `-FocusTerms "核心词1,核心词2"`（未命中 ×0.4 惩罚）
  或 `-NoiseFloor 0.3` 过滤低分项；结合输出 `MatchTerms`/`NoiseFlagged` 字段按平台分级采信，勿把被过滤的 0 命中写成不存在。

## 快速路径

受限策略机器首选：同目录 `python mcps.py` 在子进程绕过执行策略，并把 `tools/bin` 前置进 PATH（不修改系统环境）。

```powershell
python mcps.py -Doctor -AsJson --out C:/tmp/mcps/doctor.json
python mcps.py -Keyword "react modal component" -Platform All -MinStars 100 -Limit 5 --out C:/tmp/mcps/repo.json
python mcps.py -CodeEvidence -Keyword "jwt verify" -AsJson --out C:/tmp/mcps/code.json
python mcps.py -ResearchSources -Keyword "llama" -Limit 5 --out C:/tmp/mcps/research.json
```

已在当前 PowerShell 进程放开执行策略时，也可直接运行：

```powershell
.\multi-platform-searcher.ps1 -Keyword "react modal component" -Platform All -MinStars 100 -Limit 5   # 仓库发现
.\multi-platform-searcher.ps1 -Keyword "mcp server" -ExcludeArchived -ActiveWithin 180 -License "mit,apache-2.0"  # 仓库质量过滤（缺字段的源不剔除，见 warnings）
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "jwt verify" -AsJson -NoCache                     # 代码证据(JSON+coverage)
.\multi-platform-searcher.ps1 -ResearchSources -Keyword "jwt" -Limit 5                                # 研究信源(匿名)
.\multi-platform-searcher.ps1 -ResearchSources -Keyword "tool retrieval benchmark" -AsJson             # 同上；.env 配了 DEEPSEEK_API_KEY 时自动多一个 DeepSeek 网页源
.\multi-platform-searcher.ps1 -Auto -Keyword "jwt" -AsJson                                            # -Auto: planner 自动分类(integrated 类一次进程三模式)；★用短词——长中文句各源会结构性 0 命中
.\multi-platform-searcher.ps1 -Doctor -AsJson                                                          # 环境自检
```

## 多轮调研编排（v1.53.23：`research_rounds.py`）

单次检索只是"一轮"。跨轮要解决的是：候选核验、覆盖缺口、多个 agent 的工单与合并。编排器只做编排，检索仍走 `mcps.py`：

```bash
python research_rounds.py --brief "agent skill registry" --out reports/rr-2026-10-25          # 只生成 lane 工单（不联网）
python research_rounds.py --brief "..." --terms "agent skill registry" --out ... --execute    # 本机顺序跑 3 轮
python research_rounds.py --brief "..." --out ... --merge agents/                              # 合并多个 agent 的 *.result.json
python research_rounds.py --self-test                                                          # 离线自测
```

- 轮 1：lane（发现/实现/替代/生态）各出一条查询，结果按 `EntityKey` 去重。
- 轮 2：对 top 3 候选做 `-CodeEvidence -RepoScope`，把命中数与 verdict 写回候选。
- 轮 3：把缺口（缺 license、单平台、缺代码证据）变成补查；预算耗尽即停并记 `rc=125`。
- 置信：`Relaxed`（如 `drop-stars`）与 `NoiseFlagged` 会降权并在报告"置信"列标出；`NOASSERTION` 记"待核验"。
- 边界：不调用 LLM，不判断"哪个项目更好"；`--execute` 是单进程顺序执行，真并行请把 `agents/*.md` 分发给多个 agent 后 `--merge`。

## MCP 服务端（v1.44.0：`mcps.py --mcp`）

把本技能作为 **MCP 工具**接给 Agent（Claude Desktop / Cursor / 任何 MCP 客户端）：协议在 Python、性能在 PowerShell ——
`mcps.py --mcp` 说 JSON-RPC，内部只起一个常驻 `multi-platform-searcher.ps1 -Serve` 子进程（脚本只 parse 一次）。

```json
{
  "mcpServers": {
    "multi-code-platform-searcher": {
      "command": "python",
      "args": ["<技能目录>/mcps.py", "--mcp"]
    }
  }
}
```

工具（每个恰好映射到 `-Serve` 的一个 op）：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `search_repositories` | 仓库发现（GitHub/Gitee/GitLab/Codeberg） | `keyword`（必填）、`limit`、`maxResults`、`platforms`、`language`、`minStars`、`activeWithin`（v1.46.7：最近 N 天内有更新）、`excludeArchived`（v1.46.7）、`license`（v1.46.7：SPDX 逗号分隔）。后三者缺字段的源不剔除，见 `filterNotes` |
| `search_auto` | 自动分派（等价 `-Auto`）：planner 判 `queryType` 后跑 repo/code/research 并集 | `keyword`（必填）、`limit`、`maxResults`、`language`、`minStars`、`site`；响应带 `modes`/`queryType`/`planSource`/`counts` |
| `search_code` | 代码实现证据（GitHub/GitLab/grep.app/SE/Sourcegraph） | `keyword`（必填）、`limit`、`maxResults`、`language`（仅 GitHub/GrepApp/Sourcegraph 生效，其余源在 warnings 明说未应用）、`repoScope`（v1.46.6：git URL / `owner/repo`，只查该仓库并二次过滤；解析失败报参数错；v1.46.9 起 gitlab 仓库走项目级 blobs，需 GITLAB_TOKEN）、`pathFilter`（路径过滤，三源支持） |
| `research` | 研究信源（HF/npm/crates.io/Maven/arXiv/SE/HN/OpenAlex/MCPRegistry…） | `keyword`（必填）、`limit`、`maxResults`、`site` |
| `package_lookup` | 精确包元数据（deps.dev；默认版本/许可证/发布时间/公告数） | `packages`（必填，`生态:包名`，逗号分隔） |
| `ping` | 健康检查（版本 + 常驻 PID） | — |

四条口径（与 CLI 一致，别误读）：

1. **`limit` = 每源页大小**，不是最终条数（聚合型引擎会超出）；要截断用 `maxResults`（0 = 不截断）。
2. **结果是排名后的 `results[]`**（去重 + `Set-UnifiedScore`，字段 `Score/Relevance/Popularity`）——但**0 条 ≠ 不存在**：先看 `ping` 与 `-Doctor`（令牌/限流）。
3. **参数白名单**：工具只接受上表参数，未知参数直接 `-32602` 拒绝（不会透传成 ps1 参数）；`platforms` 里的未知名字同样报错，不静默返回 0 条。
4. **查询级缓存（v1.46.4，v1.46.6 含作用域）**：同一进程内相同 `op/keyword/limit/platforms/language/minStars/site`（`search_code` 另含 `repoScope/pathFilter`）的第 2 次调用会命中缓存（响应带 `cached=true`，通常 <1s）；空结果不缓存。`MCPS_SERVE_CACHE=0` 可关。

## 输出契约速览（Agent 消费 `-AsJson`）

- `coverage`（v1.21.0）：`Executed/Blocked/Degraded/Reasons/ReasonCodes/Verdict`（`ReasonCodes` v1.37.9 起：逐引擎机器码，含 `user-disabled`）+ `metrics.ExitCode`（0 正常/2 工具缺失/3 认证缺失/4 降级）——**Blocked/Degraded 时 0 命中不可信**。
- `warnings[]`（v1.23.0）：引擎降级/失败可审计（`[Engine] 消息 (from: X -> Y)`）。
- **代码证据质量闸（T1-5，本地夹具通过）**：纯 `-CodeEvidence` 模式源码与 `.md/.txt/.json` 等文档/数据同时命中时只保留源码；
  只有文档时保留作低可信兜底并写 `warnings[]`，不得标为源码证据；`-Auto` 多模式的混合排序暂不改变。
- `research`（v1.22.0，`-ExpandQuery` 且 0 命中）：`interpretation=no-match` + `lowConfidenceNegative` + `suggestedWiderQueries[]`——**0 命中≠不存在**，先 web 印证。

## 能力边界（U-95，2026-09-26 以用代验后声明）

- **本技能不做官方 API 文档 / 状态页 / changelog 检索**：11 个研究源是包注册表 / 论文 / 论坛 / 网页搜索（HF、Packages、RubyGems、NuGet、DockerHub、arXiv、OpenAlex、MCPRegistry、HackerNews、SE、DeepSeek 网页搜索）。
  "某 API 是否废弃 / 当前限流多少"这类问题**技能答不了**，请直接读官方文档并当日实测响应头（N-17 纪律；`-ObserveHeaders` 只是观察工具，不是答案）。
- **`coverage.Verdict` ≠ 有结果**：`Verdict=full` 只表示"请求的引擎都执行了"，`results` 仍可能为空（实测 repo 模式 0 结果而 `verdict=full`）。判断"有没有"看 `results.Count` 与 `metrics.ResultCount`。
- **三条使用建议（U-95，R41）**：
  1. **repo 用短关键词**（单词或连字符词，如 `mcp-registry`），不要把自然语言长句直接当仓库检索式。
  2. **research 需人工过滤**：用领域专属词，核对来源类别与原文；同名 DockerHub 镜像不等于目标技术方案。
  3. **0 命中 ≠ 没有**：先检查 coverage、令牌与网络，再缩短或改写关键词，并用官方资料或直接检索交叉验证。
- **`-Platform` 仅选择 repo 引擎**（注册表 `Kind='repo'` 的 Name + `All`）；`GitHubCode` 属于 code，仍由参数校验拒绝，不会进入检索路径。
  要检索代码请用 `-CodeEvidence -Keyword "..."`，不要用 `-Platform GitHubCode`。`ValidateSet` 保留兼容 PS5.1 的字面量，由 Node 门从注册表派生期望集合并核对，非运行时动态枚举。
- **请一律使用具名参数**（`-Keyword "..." -Platform All …`）：位置传参的语义随参数表顺序变化，不可依赖。
- **延迟预期（v1.48.0 起）**：单模式 repo 的逐源上限是 `EngineDeadlineRepoSec=29s`，
  v1.47.9 关掉单源硬上限后才**第一次真正生效** —— 一个不可达的 repo 源会让本轮等到十几秒
  （`-Platform All` 实测约 28s，`-Platform GitHub` 单源约 19.5s）。要压尾延迟：
  `MCPS_ENGINE_HARD_CAP_SEC=10`（恢复旧行为）或给特定源设 `MCPS_ENGINE_DEADLINE="GitHub=12"`；
  `-Auto` 走 `EngineHardCapMultiModeSec=25`，不受此项影响。

## 与直接调研配合（v1.24.0 固化）

1. **定全貌**：直接搜/web 读官方文档、标准、博客（web 5+3 路）；
2. **补召回与实证**：本技能做仓库/代码/论文结构化召回（先 `-Doctor`）；宽概念句加 `-FocusTerms`（如 `session,alert`）降噪；
3. **下判断**：回读源码/文档原文——技能只采证据、不代判断。

详见 `references/端到端范例.md`（r1–r4 的 0/空/噪音三类输出解读）。

## 可验证性（provenance · v1.42.0）

> 本技能**自带清单与哈希**，可在安装副本上自证"这份文件是不是发布者发的那份"。

**一条命令**

```bash
cd <本技能目录> && python mcps.py -Verify            # 0=PASS · 1=DRIFT/MISSING · 2=UNKNOWN（无法判定）
cd <本技能目录> && python mcps.py -Verify --json     # 机器可读：{total, ok, drift[], missing[], verdict}
```

**可信口径（必须按这个读，别把它当"安全认证"）**

| 维度 | 本技能提供 | 本技能**不**提供 |
|---|---|---|
| 完整性 | 逐文件 sha256 一致校验（改动/缺失**点名到文件**） | 不证明代码无漏洞 |
| 版本 | 清单 `version` 与脚本 `$VERSION` 同源（U-139 门守护） | 不证明与上游最新版一致 |
| 行为 | 变异测试/行为探针/降级披露门（仓内） | 不做运行时沙箱隔离 |

**权限面（运行前请知悉）**

- **凭据**：只读 `GITHUB_TOKEN` / `GITLAB_TOKEN` / `GITEE_TOKEN` / `SRC_TOKEN` / `SOURCEGRAPH_TOKEN` / `SE_KEY` / `DEEPSEEK_API_KEY` 等；**不写入、不回显**（U-55：环境旋钮表逐项登记）。
- **写盘**：默认只在 `--out` 指定处写；缓存写系统临时目录（`MCPS_ZERO_STREAK_FILE` 可改）。
- **网络域**：仅各源官方 API；**无自建中转**。

**降级怎么读（`Verdict` 四态 + `ReasonCodes`）**

| 值 | 含义 | 会让 `Verdict` 变差吗 |
|---|---|---|
| `full` | 请求的源全部执行成功 | — |
| `partial` / `degraded` | 有源阻塞/降级 | 是 |
| `none` | 请求了但零执行 | 是 |
| `zero-hit` | 检索成功但 0 命中（**真没有**） | 否 |
| **`forbidden`** | **能力被账号层级关闭**（如 GitLab 全局 blobs 403）—— 不是限流、不是预算 | 是 |
| **`filtered`** | **找到了但被质量门槛丢弃**（不等于"没有"） | 是 |
| `budget-truncated` | 自设预算截断（主动放弃） | 视情况 |
| `deadline` / `rate-limited` | 超时 / 429 | 是 |
| `missing-credential` / `user-disabled` / `not-run` | 缺 key / 用户禁用 / 未执行 | 视情况 |

> **设计原则**：**"没有可比对的东西"绝不判为"通过"** —— `-Verify` 在 0 个可比对文件时返回 `UNKNOWN`，不返回 `PASS`。

## 参考索引

| 主题 | 文件 |
|---|---|
| 全部 33 参数 + 示例（含 `-ProxyMode`） | `references/参数速查.md` |
| 引擎链/coverage/warnings/research 契约 | `references/引擎链.md` |
| 故障定位 + 回归 | `references/故障排查.md` |
| 版本谱系与历史 v1.5→当前（见谱系表「当前基线」行） | `references/变更历史.md` |
| 协同工作流 + 端到端范例 | `references/端到端范例.md` |
| 评测环（ground-truth 用例） | `evals/run-evals.ps1` |
| 回归测试（12 组断言；v1.36.3 新增 test-inject） | `tests/run-tests.ps1` |
| 历史兼容入口（非首选；校验器已随清单发布，旧 Gitee v5 可能陈旧） | `smart-project-searcher.ps1` |