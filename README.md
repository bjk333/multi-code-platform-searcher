# multi-code-platform-searcher

一次查询同时打 26 个源。跑不成的那个会点名，并告诉你为什么。

## 为什么会有这个东西

有次让 AI 帮我找一段现成实现，它回「没有找到相关代码」。我就按字面理解了，自己从头写。隔了两天才发现是 GitLab 的 token 过期，相关的那两个源压根没发出请求。

「确实没有」和「我没搜」返回的东西长得一模一样，都是一个空列表。要区分它们，工具得额外记一份状态。多数工具省了这一步，因为用户看不见差别，记了也不加分。

所以我写这个，主要就是让它在每次查询里把这份状态交出来：哪些源跑了、哪些没跑、没跑是因为缺令牌、被限流、连不上，还是我自己把它禁了。

具体长这样，字段都在最外层：

```jsonc
"coverage": {
  "Requested": 4,          // 这次打算跑几个
  "Executed": 3,           // 实际跑成几个
  "Blocked": ["GitLabBlobs"],
  "Verdict": "partial",    // 见下文五档
  "ReasonCodes": { "GitLabBlobs": "missing-credential" }
}
```

同一个关键词跑两次能说明问题：一次配了令牌，一次用 `-NoEnvFile` 故意不读，两次都返回 10 条结果，条数一模一样。区别在账本上——前一次 `Verdict=degraded`，后一次 `partial`，后者有 3 个源被拦，原因码是 `missing-credential` 和 `network-unavailable`。

只看条数，这两次查询没有区别。这就是我当初被坑的那个坑。

## 装

```powershell
git clone https://github.com/bjk333/multi-code-platform-searcher.git
cd multi-code-platform-searcher

# 放到 skills 目录（Claude Code / WorkBuddy 这类支持 Agent Skills 的宿主）
Copy-Item -Recurse . "$HOME\.workbuddy\skills\multi-code-platform-searcher"

# 想配令牌的话
Copy-Item .env.example .env
```

然后体检一下，看这台机器上哪些源是活的：

```powershell
.\multi-platform-searcher.ps1 -Doctor
```

不配令牌也能用，26 个源里 23 个是匿名可访问的。剩下 3 个（GitHub、GitLab、DeepSeek）缺令牌时不会假装搜过，会进 `Blocked` 并带上 `missing-credential`。

环境要求：Windows PowerShell 5.1 或 PowerShell 7+，可选 Node.js 18 以上。macOS 我没跑过，别问我行不行。

## 用

```powershell
# 让它自己判断该跑哪几条路
.\multi-platform-searcher.ps1 -Auto -Keyword "jwt verify" -AsJson

# 只要代码证据：给到文件行，不是丢一个仓库链接
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "jwt verify" -AsJson

# 查一个包能不能商用
.\multi-platform-searcher.ps1 -Package "npm:express" -AsJson

# 只在某个仓库里搜
.\multi-platform-searcher.ps1 -CodeEvidence -Keyword "parse" -RepoScope "gchq/CyberChef"
```

想挂进 Agent 的话走 MCP：

```powershell
python mcps.py --mcp
```

暴露 6 个工具，`search_repositories` / `search_auto` / `search_code` / `research` / `package_lookup` / `ping`，标准 JSON-RPC，Claude Code 和 Cursor 都能接。

## 26 个源都是谁

按类分开，每行个数加起来正好 26，你可以自己数一遍：

| 类别 | 引擎 | 个数 |
|---|---|---|
| 代码托管 | `github` · `github-code` · `gitlab-blobs` · `search-gitlab` · `gitee` · `codeberg` | 6 |
| 代码检索 | `grep-app` · `sourcegraph` · `searchcode-repo` | 3 |
| 包生态 | `npm-registry` · `crates-io` · `maven-central` · `nuget` · `packagist` · `search-rubygems` | 6 |
| 元数据 | `deps-dev` · `docker-hub` · `mcp-registry` | 3 |
| 学术与社区 | `arxiv` · `hugging-face` · `open-alex` · `se-excerpts` · `stack-exchange` · `hacker-news` · `deepseek-search` | 7 |
| 本地 | `local-code` | 1 |

另外有 42 个参数。`-Auto` 会让 query-planner 先分类，然后在同一个进程里跑完「发现 → 回填代码证据 → 补缺口」三轮。

## Verdict 有五档

| 值 | 什么情况 |
|---|---|
| `full` | 请求的源全部跑成 |
| `degraded` | 跑成了，但有源降级（限流、结果被截断），`Executed` 非空 |
| `partial` | 有源被拦，`Executed` 非空 |
| `none` | 请求了，但一个都没执行 |
| `no-engines` | 什么都没请求，相关源全被禁用 |

还有一套四态视图（`ok` / `partial` / `failed` / `empty`），是从 Verdict 机械派生的，不允许独立赋值，免得两处各说各话。

原因码目前这几个：`missing-credential`（缺令牌）、`forbidden`（有令牌但权限不够或被拒）、`network-unavailable`（连不上）、`rate-limited`（被限流）、`user-disabled`（主动禁用）、`tool-missing`（缺本地二进制，比如 ripgrep）、`quota-exhausted`（配额用尽）。

五档里任何一档，都不会让「结果为空」等于「世界上没有」。

## 测试比我预想的多

写的过程中大部分时间花在证明自己没骗自己上。现在产品代码一万三千行左右，测试代码两万七千行，比例差不多 2:1。门禁 168 道，用例一千上下。

发布前要过两张凭证，Node 门和 PowerShell 套件，缺一张或者任何一张有失败，发布脚本直接拒发。静态门有个棘轮，只许降不许升。

```powershell
node tests/run-node-gates.mjs --profile=repo
.\tests\run-tests.ps1
```

这些测试主要是防止我自己糊弄自己，不是保证你装上就能跑。真实跑过的环境是 Windows（PS 5.1 和 pwsh 7）和 Linux（pwsh 7，容器里）。

## 和 grep.app、Sourcegraph、Cursor 的关系

不冲突，用的场景不一样。

grep.app 和 Sourcegraph 单源检索质量比我高，这个我承认，我自己也在用。Cursor 改当前仓库也比这个顺手。它们的问题是只给你结果，不给你过程——搜不到的时候你不知道是没这个函数，还是索引没覆盖到。

我这个的价值在横向：一个方案除了 GitHub 还有谁做过、这个包能不能商用、某个方向学术界有没有人碰过。这种问题要跨好几个源问，且每次都要知道哪个源哑了。

所以典型用法是：改代码用 Cursor，选型和技术调研用这个。

## 缺点

说在前面，免得你踩了回来骂我。

**本地代码检索默认是坏的。** 这部分依赖 ripgrep 或 ugrep，我本机两个都没装，所以 `-Doctor` 会直接告诉你「本地代码检索不可用」。注意它说的是不可用，不是「本地 0 命中」——这两句差别很大，我有意让它分开。

**只有 3 个源要令牌，其余全走匿名。** 好处是装上就能跑，坏处是匿名请求的限额比带令牌低得多，全量并发时会更容易撞上 `rate-limited`。真要做长期调研，还是把令牌配上。

全量并发撞限流的话切串行，`U153_SERIAL=1`，慢一些但读数干净。

macOS 完全没跑过。Linux 只在容器里跑过 pwsh 7。

不是语义检索，是关键词加结构化检索。想找「类似这个思路的项目」，它帮不上忙。

## License

MPL-2.0，Copyright (c) 2026 bjk333。

能商用、能改、能和闭源代码一起打包卖。唯一的要求是：如果你改了其中某个源文件再分发，那个文件的改动要公开（MPL 2.0 §3.2）。只把它部署成服务、不分发代码，不触发这条。

想要「改了必须回流到上游、不许闭源」的效果，得用 AGPL-3.0，代价是企业用户基本不敢碰，我选了中间那个。
