# multi-code-platform-searcher

> 一次查询，同时打向 26 个引擎；**没跑到的那个，它会点名并给理由**。

一个面向 AI Agent 的技术调研与代码检索技能。支持 PowerShell 5.1 / 7+ 与 MCP 两种接入方式，
覆盖 4 个代码托管平台、6 个包生态、7 个学术与社区信源，共 26 个引擎。

---

## 它解决的问题

AI 助手告诉你「没有找到相关实现」的时候，有两种完全不同的真相：

- 世界上确实没有
- **它压根没搜**（缺令牌、被限流、源被禁用、网络不通）

这两种情况在结果上长得一模一样：一个空列表。多数工具不区分，因为区分需要额外记录状态。

本项目的做法是**把账本摊开**：每次查询都返回 `coverage`，写明哪些引擎执行了、哪些被拦、
各自的原因码。宁可告诉你「这个源我没跑」，也不假装搜过了。

### 一次实测

同一个关键词跑两次，**结果条数完全相同**：

| | 有令牌 | 无令牌（`-NoEnvFile`） |
|---|---|---|
| 结果条数 | 10 | 10 |
| `coverage.Verdict` | `degraded` | `partial` |
| `coverage.Blocked` | 空 | 3 个引擎 |
| `ReasonCodes` | `forbidden` / `user-disabled` | `missing-credential` × 2 · `network-unavailable` |

结果一样多，可信度不一样。**如果你只看条数，这两次查询没有区别。**

---

## 覆盖范围

26 个引擎，按类分（每行个数相加 = 26，可直接对账）：

| 类别 | 引擎 | 个数 |
|---|---|---|
| 代码托管 | `github` · `github-code` · `gitlab-blobs` · `search-gitlab` · `gitee` · `codeberg` | 6 |
| 代码检索 | `grep-app` · `sourcegraph` · `searchcode-repo` | 3 |
| 包生态 | `npm-registry` · `crates-io` · `maven-central` · `nuget` · `packagist` · `search-rubygems` | 6 |
| 元数据 | `deps-dev`（许可证 / 安全公告） · `docker-hub` · `mcp-registry` | 3 |
| 学术 / 社区 | `arxiv` · `hugging-face` · `open-alex` · `se-excerpts` · `stack-exchange` · `hacker-news` · `deepseek-search` | 7 |
| 本地 | `local-code`（当前工作区正则检索） | 1 |
| | **合计** | **26** |

42 个参数、6 个 MCP 工具。`-Auto` 由 query-planner 自动分类，一次进程内跑
「发现 → 回填代码证据 → 补缺口」三轮。

---

## 30 秒体验

```powershell
git clone https://github.com/bjk333/multi-code-platform-searcher.git
cd multi-code-platform-searcher

# 1) 先体检：这台机器哪些源可用、哪些缺令牌、哪些被封
.\multi-platform-searcher.ps1 -Doctor

# 2) 真跑一次：找 jwt verify 的实现，要的是代码证据（定位到文件行）
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "jwt verify" -AsJson
```

不用配任何令牌就能跑起来 —— 26 个引擎里有 20 个免令牌。缺令牌的那 6 个会在
`coverage.Blocked` 里被点名并给出原因码，不会假装搜过。

---

## 安装

```powershell
# 1) 放进 skills 目录（Claude Code / WorkBuddy 等支持 Agent Skills 的宿主）
git clone https://github.com/bjk333/multi-code-platform-searcher.git
Copy-Item -Recurse multi-code-platform-searcher "$HOME\.workbuddy\skills\"

# 2) 配置令牌（可选但强烈建议，缺了对应源会记 blocked 而不是静默失败）
Copy-Item .env.example .env
# 编辑 .env，填 GITHUB_TOKEN / GITLAB_TOKEN / DEEPSEEK_API_KEY

# 3) 体检
.\multi-platform-searcher.ps1 -Doctor
```

**环境要求**：Windows PowerShell 5.1 或 PowerShell 7+；可选 Node.js ≥ 18（node 侧引擎与门禁）；
需要能访问各平台公网 API。macOS 尚未实跑（见「限制」）。

---

## 用法

```powershell
# 自动选路：一句话同时跑仓库发现 + 代码证据 + 研究信源
.\multi-platform-searcher.ps1 -Auto -Keyword "jwt verify" -AsJson

# 只要代码证据：定位到文件行，不是给一个仓库
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "jwt verify" -AsJson

# 包元数据：默认版本 / 许可证 / 发布时间 / 已知安全公告数
.\multi-platform-searcher.ps1 -Package "npm:express" -AsJson

# 只在指定公开仓库内检索
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "parse" -RepoScope "gchq/CyberChef"
```

### 作为 MCP 服务接入 Agent

```powershell
python mcps.py --mcp
```

暴露 6 个工具：`search_repositories` / `search_auto` / `search_code` / `research` /
`package_lookup` / `ping`。走标准 JSON-RPC，可挂进 Claude Code、Cursor 等支持 MCP 的客户端。

---

## 输出契约

所有模式共用同一套结果结构，方便程序消费：

```jsonc
{
  "coverage": {
    "Requested": 4,          // 本次打算跑几个引擎
    "Executed": 3,           // 实际跑成几个
    "Blocked": ["GitLabBlobs"],
    "Verdict": "partial",    // full | degraded | partial | none | no-engines
    "ReasonCodes": { "GitLabBlobs": "missing-credential" }
  },
  "results": [ /* 统一字段：Engine / Repo / File / Line / Preview / Url */ ],
  "warnings": []
}
```

### Verdict 五档

| 值 | 含义 |
|---|---|
| `full` | 请求的引擎全部跑成 |
| `degraded` | 跑成了，但有源降级（被限流、结果被截断等），`Executed` 非空 |
| `partial` | 有源被拦，`Executed` 非空 |
| `none` | 请求了引擎，但一个都没执行（全 blocked / degraded） |
| `no-engines` | 什么都没请求（相关源全被禁用） |

对外还有一个四态视图（`ok` / `partial` / `failed` / `empty`），**由 `Verdict` 机械派生，不得独立赋值**：

```
full→ok | partial→partial | degraded→partial | none→failed | no-engines→empty
```

同一条事实只在一个地方说，避免 `results` 和 `ReasonCodes` 各说各话。

**任何一档都不会让「结果为空」等价于「世界上没有」。**

### 常见 ReasonCodes

| 码 | 意思 |
|---|---|
| `missing-credential` | 缺令牌 |
| `forbidden` | 有令牌但权限不够或被拒 |
| `network-unavailable` | 连不上 |
| `rate-limited` | 被限流 |
| `user-disabled` | 主动禁用 |
| `tool-missing` | 缺本地二进制（如 ripgrep） |
| `quota-exhausted` | 配额用尽 |

---

## 工程状态（诚实版）

这个项目把大部分工程量花在「证明自己没骗自己」上：

| 项 | 数字 |
|---|---|
| 产品代码 | 约 13,100 行（PowerShell + Python） |
| 测试代码 | 约 27,400 行（测试 : 产品 ≈ 2.1 : 1） |
| 门禁 | 168 道门 / 约 1,000 个用例 |
| 发布校验 | 双凭证（Node 门 + PowerShell 套件），任一不过即拒绝发布 |
| 静态门棘轮 | 只降不升，防止新增债务 |

```powershell
node tests/run-node-gates.mjs --profile=repo   # Node 侧全量门
.\tests\run-tests.ps1                          # PowerShell 侧套件
```

---

## 和 grep.app / Sourcegraph / Cursor 内置搜索什么关系

**它不取代它们，它补它们的盲区。**

| | 它们 | 这个 |
|---|---|---|
| 强项 | 单源检索质量、自有大仓索引、IDE 内即时反馈 | 多源汇总 + 每次查询都带状态账本 |
| 覆盖面 | 通常 1 个源 | 26 个引擎：4 个代码托管 + 6 个包生态 + 7 个学术社区 |
| 搜不到时 | 给你一个空列表 | 空列表 + **哪个源没跑、为什么** |
| 擅长的问题 | 「这个函数在哪」 | 「这个方案除了 GitHub 还有人做过吗」「这个包能不能商用」 |

典型分工：用 Cursor 的内置检索改当前仓库，用本项目做**跨平台技术调研**和**选型前的事实核查**。

---

## 限制

写在前面，省得你踩：

1. **令牌不全**。GitHub / GitLab / DeepSeek 三个源需要令牌，缺失时对应引擎记 `blocked` 并给原因码，不会静默跳过。其余 20 个引擎免令牌。
2. **macOS 未实跑**。Windows（PS 5.1 与 pwsh 7）与 Linux（pwsh 7，容器内）有实跑记录。
3. **速率上限受各平台约束**。全量并发会触发限流，串行模式更稳（`U153_SERIAL=1`）。
4. **它不替代专业代码搜索**。定位是「多源汇总 + 状态可核」，不是取代 grep.app 或 Sourcegraph。

---

## License

MIT
