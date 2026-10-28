[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Query,
    [ValidateSet('auto', 'research_only', 'repository_only', 'code_evidence_only', 'integrated_research_and_code')]
    [string]$QueryType = 'auto',
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
function U([string]$value) { ConvertFrom-Json ('"' + $value + '"') }
function Has-Term([string]$text, [string[]]$terms) {
    foreach ($term in $terms) {
        if ($text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}
function Get-Terms([string]$text, [string[]]$terms) {
    @($terms | Where-Object { $text.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -Unique)
}
# v1.2.0：ASCII 词按词边界匹配（避免 'ci' 命中 'precision'、'go' 命中 'google'）；非 ASCII（中文）仍按子串
function Has-Word([string]$text, [string[]]$terms) {
    foreach ($term in $terms) {
        if ($term -match '^[\x20-\x7E]+$') {
            if ($text -match ('(?i)(?<![A-Za-z0-9])' + [regex]::Escape($term) + '(?![A-Za-z0-9])')) { return $true }
        } elseif ($text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
}

$researchTerms = @((U '\u5b98\u65b9\u6587\u6863'), (U '\u6587\u6863'), (U '\u8bba\u6587'), (U '\u535a\u5ba2'), (U '\u8bba\u575b'), (U '\u6807\u51c6'), (U '\u6700\u4f73\u5b9e\u8df5'), (U '\u6280\u672f\u65b9\u6848'), (U '\u89e3\u51b3\u65b9\u6848'), (U '\u6700\u65b0'), (U '\u8c03\u7814'), 'documentation', 'paper', 'blog', 'forum', 'official', 'best practice', 'latest')
$repositoryTerms = @((U '\u5f00\u6e90\u9879\u76ee'), (U '\u4ed3\u5e93'), (U '\u4ee3\u7801\u4ed3\u5e93'), (U '\u76f8\u4f3c\u9879\u76ee'), 'github', 'gitee', 'gitlab', 'repo', 'repository', (U '\u4e0b\u8f7d\u6e90\u7801'), (U '\u6e90\u7801'), (U '\u9879\u76ee'))
$codeTerms = @((U '\u4ee3\u7801\u5b9e\u73b0'), (U '\u51fd\u6570'), (U '\u7c7b'), (U '\u6a21\u5757'), (U '\u5b9e\u73b0'), (U '\u6e90\u7801'), 'grep.app', 'sourcegraph', 'function', 'class', 'module', 'implementation', 'implement', 'implementing', 'code')
$negativeTerms = @((U '\u4e0d\u8981'), (U '\u4e0d\u9700\u8981'), (U '\u7981\u6b62'), (U '\u6392\u9664'), (U '\u53ea\u8981'), 'without', 'exclude', 'do not', 'only')
# v1.2.0（P1-9）：工程/工具链信号词——"调研 + 工程对象"（技能/CI/分发/插件/SDK…）应走 integrated，而非只查资料
# 中文：技能 流水线 持续集成 分发 发布 打包 插件 脚本 工具链 依赖 库 框架 集成 部署 构建
$engineeringTerms = @((U '\u6280\u80fd'), (U '\u6d41\u6c34\u7ebf'), (U '\u6301\u7eed\u96c6\u6210'), (U '\u5206\u53d1'), (U '\u53d1\u5e03'), (U '\u6253\u5305'), (U '\u63d2\u4ef6'), (U '\u811a\u672c'), (U '\u5de5\u5177\u94fe'), (U '\u4f9d\u8d56'), (U '\u5e93'), (U '\u6846\u67b6'), (U '\u96c6\u6210'), (U '\u90e8\u7f72'), (U '\u6784\u5efa'), 'CI', 'CD', 'CI/CD', 'pipeline', 'workflow', 'github actions', 'plugin', 'extension', 'sdk', 'library', 'package', 'cli', 'script', 'toolchain', 'build', 'deploy', 'release')
# v1.4.0（v1.53.15，2026-10-23）：**选型/对比类信号词** —— 实测「调研 rust 生态的异步运行时选型」
#   「rust async runtime comparison」「tokio vs async-std」全部落到 research_only ⇒ repo 池压根不跑，
#   而选型最需要星数/活跃度（tokio/async-std/smol 都在 GitHub）。这些词单独成类，命中即走 repo+research。
#   中文：选型 对比 比较 替代 哪个好 选一个 选哪个；英文：vs comparison compare alternative(s) tradeoff trade-off
$selectionTerms = @((U '\u9009\u578b'), (U '\u5bf9\u6bd4'), (U '\u6bd4\u8f83'), (U '\u66ff\u4ee3'), (U '\u54ea\u4e2a\u597d'), (U '\u9009\u4e00\u4e2a'), (U '\u9009\u54ea\u4e2a'), 'vs', 'comparison', 'compare', 'alternative', 'alternatives', 'tradeoff', 'trade-off')
# v1.5.0（v1.53.22，2026-10-25）：**已知技术主题 + 无研究信号 ⇒ 补 repo 池**。
#   实测（v1.53.16 记录，v1.53.21 复现）：`-Auto "向量数据库"` / "分布式锁" / "中文分词" 全部落到 research_only
#   ⇒ repo 池压根不跑，而主脚本的 ZhTopicTermMap 明明已能把它们映成 vector database / distributed lock。
#   判据刻意收窄（三条同时成立才改判）：
#     ① **命中已知主题词** —— 用词表，不猜中文切词（"什么是 CAP 定理"不在表内，行为不变）；
#     ② **无研究专用信号** —— 文档/论文/标准/最新/调研…（"RAG 论文"仍 research_only）；
#     ③ **无否定词**（"不要找项目"不扩张）；
#     ④ **不是提问/教程形状** —— "什么是向量数据库" / "如何设计限流" 仍 research_only（问的是解释，不是项目）。
#        ★这条是**保守闸**：只在 topic 分支上生效，不会把任何原本 repo/code/selection 的查询改成 research。
#   改判结果 = repository_only ⇒ 主脚本 Add-AutoResearchMode 追加 research ⇒ 实际 repo+research（**不跑 code 池**）。
#   ★主题词表必须与主脚本 `$script:ZhTopicTermMap` 的**键集完全一致**（门 U-239 A 双向比对）—— 两边各自加词会漂。
$questionTerms = @((U '\u4ec0\u4e48\u662f'), (U '\u662f\u4ec0\u4e48'), (U '\u4f55\u4e3a'), (U '\u4e3a\u4ec0\u4e48'), (U '\u4e3a\u4f55'), (U '\u600e\u4e48'), (U '\u5982\u4f55'), (U '\u600e\u6837'), (U '\u539f\u7406'), (U '\u5165\u95e8'), (U '\u6559\u7a0b'), (U '\u6307\u5357'), (U '\u5b66\u4e60'), (U '\u4ecb\u7ecd'), (U '\u6982\u8ff0'), 'what is', 'how to', 'why', 'tutorial', 'guide', 'introduction', 'overview', 'learn')
$topicTerms = @(
    (U '\u5f02\u6b65\u8fd0\u884c\u65f6'), (U '\u534f\u7a0b'), (U '\u7ebf\u7a0b\u6c60'), (U '\u8fde\u63a5\u6c60'), (U '\u5185\u5b58\u6c60'), (U '\u65e0\u9501'),
    (U '\u96f6\u62f7\u8d1d'), (U '\u5783\u573e\u56de\u6536'), (U '\u5185\u5b58\u6cc4\u6f0f'), (U '\u5411\u91cf\u6570\u636e\u5e93'), (U '\u5411\u91cf\u68c0\u7d22'), (U '\u56fe\u6570\u636e\u5e93'),
    (U '\u65f6\u5e8f\u6570\u636e\u5e93'), (U '\u5173\u7cfb\u578b\u6570\u636e\u5e93'), (U '\u952e\u503c\u5b58\u50a8'), (U '\u5bf9\u8c61\u5b58\u50a8'), (U '\u5168\u6587\u68c0\u7d22'), (U '\u5012\u6392\u7d22\u5f15'),
    (U '\u6570\u636e\u6e56'), (U '\u6570\u636e\u4ed3\u5e93'), (U '\u6d41\u5904\u7406'), (U '\u6570\u636e\u5e93\u8fc1\u79fb'), (U '\u5206\u5e93\u5206\u8868'), (U '\u5206\u5e03\u5f0f\u4e8b\u52a1'),
    (U '\u5171\u8bc6\u7b97\u6cd5'), (U '\u4e00\u81f4\u6027\u54c8\u5e0c'), (U '\u6d88\u606f\u961f\u5217'), (U '\u53d1\u5e03\u8ba2\u9605'), (U '\u4e8b\u4ef6\u9a71\u52a8'), (U '\u670d\u52a1\u7f51\u683c'),
    (U '\u5fae\u670d\u52a1'), (U '\u670d\u52a1\u53d1\u73b0'), (U '\u914d\u7f6e\u4e2d\u5fc3'), (U '\u7f51\u5173'), (U '\u53cd\u5411\u4ee3\u7406'), (U '\u8d1f\u8f7d\u5747\u8861'),
    (U '\u9650\u6d41'), (U '\u7194\u65ad'), (U '\u5e42\u7b49'), (U '\u5206\u5e03\u5f0f\u9501'), (U '\u5206\u5e03\u5f0f\u8ffd\u8e2a'), (U '\u94fe\u8def\u8ffd\u8e2a'),
    (U '\u53ef\u89c2\u6d4b\u6027'), (U '\u65e5\u5fd7\u805a\u5408'), (U '\u7070\u5ea6\u53d1\u5e03'), (U '\u8ba4\u8bc1\u6388\u6743'), (U '\u5355\u70b9\u767b\u5f55'), (U '\u6743\u9650\u63a7\u5236'),
    (U '\u96f6\u4fe1\u4efb'), (U '\u5355\u5143\u6d4b\u8bd5'), (U '\u7aef\u5230\u7aef\u6d4b\u8bd5'), (U '\u6a21\u7cca\u6d4b\u8bd5'), (U '\u538b\u529b\u6d4b\u8bd5'), (U '\u57fa\u51c6\u6d4b\u8bd5'),
    (U '\u9759\u6001\u5206\u6790'), (U '\u6027\u80fd\u5206\u6790'), (U '\u706b\u7130\u56fe'), (U '\u5927\u6a21\u578b'), (U '\u63d0\u793a\u8bcd'), (U '\u667a\u80fd\u4f53'),
    (U '\u68c0\u7d22\u589e\u5f3a'), (U '\u5fae\u8c03'), (U '\u6a21\u578b\u91cf\u5316'), (U '\u6a21\u578b\u63a8\u7406'), (U '\u5411\u91cf\u5d4c\u5165'), (U '\u591a\u6a21\u6001'),
    (U '\u4e2d\u6587\u5206\u8bcd'), (U '\u5206\u8bcd'), (U '\u6b63\u5219\u8868\u8fbe\u5f0f'), (U '\u6a21\u677f\u5f15\u64ce'), (U '\u89e3\u6790\u5668'), (U '\u7f16\u8bd1\u5668'),
    (U '\u865a\u62df\u673a'), (U '\u524d\u7aef\u6846\u67b6'), (U '\u72b6\u6001\u7ba1\u7406'), (U '\u670d\u52a1\u7aef\u6e32\u67d3'), (U '\u9759\u6001\u7ad9\u70b9'), (U '\u7ec4\u4ef6\u5e93'),
    (U '\u6784\u5efa\u5de5\u5177'), (U '\u6301\u7eed\u96c6\u6210'), (U '\u6301\u7eed\u90e8\u7f72'), (U '\u5bb9\u5668\u7f16\u6392'), (U '\u5b9a\u65f6\u4efb\u52a1'), (U '\u4efb\u52a1\u8c03\u5ea6'),
    (U '\u5de5\u4f5c\u6d41\u5f15\u64ce'), (U '\u89c4\u5219\u5f15\u64ce'), (U '\u72b6\u6001\u673a'), (U '\u63d2\u4ef6\u7cfb\u7edf'), (U '\u70ed\u66f4\u65b0')
)
# T2-9：planner 是独立进程，无法直接读取主脚本注册表；此映射用 tests/test-t2-9-planner-parity.test.mjs 与 19 个 _engineRegistry ID 保序核对。
# v1.39.0（A 线归并批）：code 类 +SEExcerpts（社区实现证据）；searchcode/-RepoScope 为条件通道，不进候选清单（同 LocalCode 口径）。
$repoEngineCandidates = @('GitHub', 'Gitee', 'GitLab', 'Codeberg')
$codeEngineCandidates = @('GitHubCode', 'GitLabBlobs', 'GrepApp', 'SEExcerpts', 'Sourcegraph')
$researchEngineCandidates = @('HF', 'Npm', 'Crates', 'Maven', 'RubyGems', 'NuGet', 'Packagist', 'DockerHub', 'arXiv', 'OpenAlex', 'MCPRegistry', 'HackerNews', 'SE', 'DeepSeek')
$frameworks = @('react','vue','angular','next.js','nextjs','node.js','nodejs','python','typescript','javascript','java','go','rust','django','fastapi','spring','docker','kubernetes','redis','postgresql','qdrant','meilisearch')
$versions = [regex]::Matches($Query, '(?i)(?:v|version\s*)?\d+(?:\.\d+){1,2}') | ForEach-Object Value | Select-Object -Unique
$detectedFrameworks = @($frameworks | Where-Object { Has-Word $Query @($_) } | Select-Object -Unique)
$negations = Get-Terms $Query $negativeTerms
$hasResearch = Has-Term $Query $researchTerms
$hasRepository = Has-Term $Query $repositoryTerms
# v1.2.0：code 词表含单字"类"(class)，会误中"类似/同类"⇒"找类似项目"被误判 integrated；匹配前先剔除这两个词
$hasCode = Has-Term ($Query.Replace((U '\u7c7b\u4f3c'), '').Replace((U '\u540c\u7c7b'), '')) $codeTerms
$hasEngineering = Has-Word $Query $engineeringTerms
# 「VS Code」（编辑器）/「vscode」不是对比语义 —— 判 'vs' 前先剔除这两种写法
$queryForSelection = ($Query -replace '(?i)vs\s*code', '') -replace '(?i)vscode', ''
$hasSelection = Has-Word $queryForSelection $selectionTerms
# v1.5.0：已知技术主题（词表命中）—— 只用作「补 repo」的依据，不改写查询、不猜切词
$hasTopic = Has-Term $Query $topicTerms
# v1.5.0：提问/教程形状 —— 只用于**阻止** topic 分支扩张，不参与其它判定
$hasQuestion = Has-Term $Query $questionTerms
if ($negations.Count -gt 0 -and $hasRepository) { $hasRepository = $false }
$confidence = 0.55

if ($QueryType -eq 'auto') {
    if ($negations.Count -gt 0 -and $hasRepository -and -not $hasCode -and -not $hasResearch) { $QueryType = 'research_only' }
    elseif ($hasRepository -and ($hasResearch -or $hasCode)) { $QueryType = 'integrated_research_and_code' }
    # v1.2.0（P1-9）：调研 + 工程对象（且未显式否定仓库）⇒ integrated；多信号即集成
    elseif ($hasResearch -and ($hasEngineering -or $hasCode) -and $negations.Count -eq 0) { $QueryType = 'integrated_research_and_code' }
    elseif ($hasCode) { $QueryType = 'code_evidence_only' }
    # v1.4.0：选型/对比 ⇒ repository_only（repo 是主需求）；research 由 Add-AutoResearchMode 自动追加
    #   ⇒ 实际模式 = repo+research（不跑 code 池：选型不需要代码片段，省一轮池开销）。
    #   ★放在 hasCode 之后：显式说「实现」时仍走 code_evidence_only（不抢既有语义）。
    elseif ($hasSelection -and $negations.Count -eq 0) { $QueryType = 'repository_only' }
    # v1.5.0：已知技术主题 + **无研究信号 + 不是提问形状** + 无否定 ⇒ repository_only
    #   （research 由主脚本 Add-AutoResearchMode 追加 ⇒ 实际 repo+research；不跑 code 池）
    elseif ($hasTopic -and -not $hasResearch -and -not $hasQuestion -and $negations.Count -eq 0) { $QueryType = 'repository_only' }
    elseif ($hasRepository) { $QueryType = 'repository_only' }
    else { $QueryType = 'research_only' }
}
if ($hasResearch) { $confidence += 0.1 }
if ($hasRepository) { $confidence += 0.1 }
if ($hasCode) { $confidence += 0.1 }
if ($hasEngineering) { $confidence += 0.05 }
if ($hasSelection) { $confidence += 0.05 }
if ($hasTopic) { $confidence += 0.05 }
if ($detectedFrameworks.Count -gt 0) { $confidence += 0.05 }
if ($versions.Count -gt 0) { $confidence += 0.05 }
$confidence = [Math]::Min(0.99, $confidence)

$plan = [ordered]@{
    schemaVersion = 1
    plannerVersion = '1.5.0'
    query = $Query
    normalizedQuery = (($Query -replace '\s+', ' ').Trim())
    queryType = $QueryType
    confidence = [Math]::Round($confidence, 2)
    entities = [ordered]@{ frameworks = $detectedFrameworks; versions = @($versions); negations = $negations }
    sources = @()
    repositories = @()
    engineCandidates = @()
    reuseCandidates = @()
    compatibilityRisks = @()
    verificationPlan = @()
}

switch ($QueryType) {
    'research_only' {
        $plan.sources = @('official-documentation', 'standards', 'papers', 'blogs', 'forums')
        $plan.engineCandidates = @($researchEngineCandidates)
        $plan.verificationPlan = @('verify official sources first', 'record source date, version and scope', 'cross-check conflicting conclusions')
    }
    'repository_only' {
        # v1.2.0（P1-10）：与主脚本引擎注册表对齐（repo 类 4 家）
        $plan.repositories = @('GitHub', 'Gitee', 'GitLab', 'Codeberg')
        $plan.engineCandidates = @($repoEngineCandidates)
        $plan.verificationPlan = @('verify default branch and repository status', 'record license, update time and maintenance status', 'deduplicate and rank by relevance and fit')
    }
    'code_evidence_only' {
        # v1.2.0（P1-10）：与主脚本引擎注册表对齐（code 类 5 家，GitHubCode 为主引擎；v1.39.0 +SEExcerpts）
        $plan.repositories = @('GitHubCode', 'GitLabBlobs', 'grep.app', 'SEExcerpts', 'Sourcegraph')
        $plan.engineCandidates = @($codeEngineCandidates)
        $plan.verificationPlan = @('verify code context and version', 'confirm license permits reuse', 'run a minimal reproducible check')
    }
    'integrated_research_and_code' {
        $plan.sources = @('official-documentation', 'standards', 'papers', 'blogs', 'forums')
        $plan.repositories = @('GitHub', 'Gitee', 'GitLab', 'Codeberg', 'GitHubCode', 'GitLabBlobs', 'grep.app', 'SEExcerpts', 'Sourcegraph')
        $plan.engineCandidates = @($repoEngineCandidates) + @($codeEngineCandidates) + @($researchEngineCandidates)
        $plan.reuseCandidates = @('core modules', 'interface implementations', 'test strategies', 'build configuration')
        $plan.compatibilityRisks = @('runtime and dependency version differences', 'license and provenance constraints', 'interface, data format and security boundary differences')
        $plan.verificationPlan = @('verify technical sources and constraints first', 'then search repositories and code evidence', 'record version, license, update time and verification result', 'output migration tests and rollback recommendations')
    }
}

$json = $plan | ConvertTo-Json -Depth 8
# PowerShell 5.1 serializes empty arrays as null; normalize known array fields
foreach ($name in @('sources', 'repositories', 'engineCandidates', 'reuseCandidates', 'compatibilityRisks', 'verificationPlan', 'frameworks', 'versions', 'negations')) {
    $json = $json -replace ('"\{0}":\s*null' -f $name), ('"{0}": []' -f $name)
}
if ($OutputPath) { $json | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
$json
