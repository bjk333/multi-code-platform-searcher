# 质量基线（v1.53.19 / U-236）：把"准不准"从口号变成可复算的数字。
#   背景：付费上架需要一句可承诺的话，而现在的答案是"取决于你怎么写查询"（见 reports/调研能力验收-准确性效率归因-2026-10-23.md）。
#   做法：60 个**典型调研查询**（main / zh / long 三组）× 每个 3–5 个公认正确仓库（弱标注，见下），跑 repo 池，算 Hit@3 / Hit@5 / MRR@5。
#   口径（不许含糊）：
#     · 期望集是**弱标注**：由作者按生态共识（如 rust http client ⇒ reqwest/hyper/ureq）编写，**不是人工金标**；
#       它只能证明"主流答案有没有进前 K"，不能证明"第 1 名一定最合适"。
#     · 匹配只看 repo 名（`owner/repo` 取 `/` 后一段，小写比较）；同生态多仓（hyper/h2）按独立项算。
#     · 只用 GitHub 单源 + `-Limit K`，不叠加研究源 —— 这样读数只反映"检索式 + 排序"，不混入资料源噪声。
#   输出：控制台表 + `reports/quality-baseline-<date>.md` + 同名 `.json`（原始 Top-K，供复核）。
#   用法：pwsh -NoProfile -File evals/quality-baseline.ps1 [-Limit 5] [-Set all|main|zh|long] [-QueryTimeoutSec 120]
param(
    [int]$Limit = 5,
    [string]$OutDir = '',
    # 2026-10-25 P0-1：分组单跑。all=60 条；main=主流 20；zh=中文主题词 20；long=长句 20。
    [ValidateSet('all', 'main', 'zh', 'long')]
    [string]$Set = 'all',
    # 2026-10-25 P0-1 收尾：**单条查询的外部硬超时（秒）**。
    #   病灶：第三次全量跑在单条查询上挂死 27 分钟（脚本内 deadline 只约束网络等待，
    #   不约束进程本身：DNS 卡住、子进程死锁、退出时 flush 卡住都不受它管）。
    #   处置：改成"显式起进程 + WaitForExit(ms)"，超时杀进程树（cmd 的子进程是孙子进程，
    #   只杀 cmd 会留孤儿继续占着 out 文件）。超时不是 miss，单列 timeout，不进分母。
    [int]$QueryTimeoutSec = 120,
    # 2026-10-25 P0-2：**固定语料**。给了路径就只采集候选池（不写报告、不算分），
    #   采集完的语料由 `evals/quality-replay.mjs` 离线复算，排序改动只在语料上跑。
    [string]$Snapshot = '',
    # 快照每条查询抓多少候选（默认 50）。live 基线是 5，快照必须更宽才能评测"排到第 20 名"的改动。
    [int]$SnapshotLimit = 50
)

$ErrorActionPreference = 'Continue'
$evalDir = $PSScriptRoot
$root = Split-Path -Parent $evalDir
$main = Join-Path $root 'multi-platform-searcher.ps1'
$hostExe = (Get-Process -Id $PID).Path
$isWin = ($null -ne $IsWindows -and $IsWindows) -or ($PSVersionTable.PSEdition -eq 'Desktop')
$tmp = [System.IO.Path]::GetTempPath()
if (-not $OutDir) { $OutDir = Join-Path $root 'reports' }
# 2026-10-25：`-OutDir` 指到不存在的目录时，写文件抛的是**非终止**异常 —— 脚本会打印
#   "报告: <path>" 并 exit 0，实际一个字节都没落。这里先建目录，末尾再自检。
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# 弱标注查询集：只收"生态里有公认主流答案"的主题，避免主观题。
# 2026-10-25 P0-1（n=12 → 60）：分三组，各自可单跑（-Set main|zh|long）。
#   动机：旧口径只在脚注里写"长句、中文主题词弱"，但**没有读数**；分组后这两个边界变成可复现数字。
#   组内仍守同一纪律：期望集是生态共识（弱标注），不是人工金标；匹配只看 repo 名后一段。
$caseGroups = [ordered]@{
    main = @(
        @{ q = 'rust http client';          want = @('reqwest', 'hyper', 'ureq', 'isahc', 'surf') }
        @{ q = 'rust async runtime';        want = @('tokio', 'async-std', 'smol', 'monoio', 'compio') }
        @{ q = 'vector database';           want = @('milvus', 'qdrant', 'weaviate', 'chroma', 'pgvector') }
        @{ q = 'distributed lock';          want = @('redsync', 'redisson', 'shedlock', 'etcd', 'curator') }
        @{ q = 'message queue';             want = @('kafka', 'rabbitmq-server', 'nats-server', 'pulsar', 'rocketmq') }
        @{ q = 'react state management';    want = @('redux', 'zustand', 'jotai', 'mobx', 'recoil') }
        @{ q = 'python web framework';      want = @('django', 'flask', 'fastapi', 'tornado', 'sanic') }
        @{ q = 'container orchestration';   want = @('kubernetes', 'nomad', 'swarmkit', 'k3s', 'rancher') }
        @{ q = 'regex engine';              want = @('re2', 'hyperscan', 'pcre2', 'oniguruma', 'regex') }
        @{ q = 'graph database';            want = @('neo4j', 'dgraph', 'nebula', 'janusgraph', 'age') }
        @{ q = 'http client library';       want = @('requests', 'axios', 'okhttp', 'reqwest', 'got') }
        @{ q = 'sql migration tool';        want = @('flyway', 'liquibase', 'alembic', 'golang-migrate', 'dbmate') }
        @{ q = 'graphql server';            want = @('graphql-yoga', 'apollo-server', 'hasura', 'gqlgen', 'juniper') }
        @{ q = 'task queue';                want = @('celery', 'sidekiq', 'bullmq', 'rq', 'arq') }
        @{ q = 'cli framework';             want = @('cobra', 'clap', 'click', 'commander', 'typer') }
        @{ q = 'orm';                       want = @('hibernate', 'sqlalchemy', 'prisma', 'gorm', 'sequelize') }
        @{ q = 'websocket library';         want = @('socket.io', 'ws', 'websockets', 'tungstenite', 'sockjs-client') }
        @{ q = 'rate limiter';              want = @('bucket4j', 'flask-limiter', 'governor', 'ratelimit', 'slowapi') }
        @{ q = 'feature flag';              want = @('unleash', 'flagsmith', 'growthbook', 'flipper', 'posthog') }
        @{ q = 'observability platform';    want = @('prometheus', 'grafana', 'jaeger', 'opentelemetry-collector', 'signoz') }
    )
    zh = @(
        @{ q = '向量数据库';                want = @('milvus', 'qdrant', 'weaviate', 'chroma', 'pgvector') }
        @{ q = '消息队列';                  want = @('kafka', 'rabbitmq-server', 'nats-server', 'pulsar', 'rocketmq') }
        @{ q = '分布式锁';                  want = @('redsync', 'redisson', 'shedlock', 'etcd', 'curator') }
        @{ q = 'API 网关';                  want = @('kong', 'apisix', 'traefik', 'envoy', 'tyk') }
        @{ q = '前端组件库';                want = @('ant-design', 'element-plus', 'material-ui', 'chakra-ui', 'mantine') }
        @{ q = '状态管理';                  want = @('redux', 'zustand', 'jotai', 'mobx', 'pinia') }
        @{ q = '任务调度';                  want = @('airflow', 'xxl-job', 'quartz', 'celery', 'dagster') }
        @{ q = '日志采集';                  want = @('beats', 'fluentd', 'vector', 'logstash', 'loki') }
        @{ q = '服务网格';                  want = @('istio', 'linkerd2', 'cilium', 'consul', 'kuma') }
        @{ q = '规则引擎';                  want = @('drools', 'easy-rules', 'json-logic-js', 'cel-go', 'grule-rule-engine') }
        @{ q = '工作流引擎';                want = @('activiti', 'flowable-engine', 'camunda-bpm-platform', 'temporal', 'camunda') }
        @{ q = '低代码平台';                want = @('appsmith', 'tooljet', 'budibase', 'lowcode-engine', 'amis') }
        @{ q = '爬虫框架';                  want = @('scrapy', 'crawlee', 'colly', 'playwright', 'puppeteer') }
        @{ q = '时序数据库';                want = @('influxdb', 'timescaledb', 'victoriametrics', 'questdb', 'tdengine') }
        @{ q = '权限系统';                  want = @('casbin', 'keycloak', 'kratos', 'spring-security', 'oso') }
        @{ q = '表单引擎';                  want = @('formily', 'react-hook-form', 'formik', 'jsonforms', 'formio') }
        @{ q = '监控告警';                  want = @('prometheus', 'alertmanager', 'grafana', 'zabbix', 'nightingale') }
        @{ q = '容器编排';                  want = @('kubernetes', 'k3s', 'nomad', 'rancher', 'compose') }
        @{ q = '代码生成器';                want = @('openapi-generator', 'generator-jhipster', 'cookiecutter', 'plop', 'hygen') }
        @{ q = '分布式事务';                want = @('seata', 'dtm', 'narayana', 'temporal', 'eventuate-tram-core') }
    )
    long = @(
        @{ q = 'rust http client with connection pooling and http2 support'; want = @('reqwest', 'hyper', 'isahc', 'surf', 'ureq') }
        @{ q = 'python async task queue with retries and dead letter';      want = @('celery', 'arq', 'dramatiq', 'rq', 'taskiq') }
        @{ q = 'typescript react component library with accessibility and theming'; want = @('mantine', 'chakra-ui', 'headlessui', 'ant-design', 'material-ui') }
        @{ q = 'go microservice framework with grpc and service discovery'; want = @('go-micro', 'kratos', 'go-zero', 'grpc-go', 'micro') }
        @{ q = 'java distributed tracing with opentelemetry support';       want = @('opentelemetry-java', 'jaeger', 'zipkin', 'spring-cloud-sleuth', 'micrometer') }
        @{ q = 'self hosted alternative to google analytics with privacy';  want = @('goatcounter', 'umami', 'matomo', 'posthog', 'fathom') }
        @{ q = 'kubernetes ingress controller with automatic tls';          want = @('ingress-nginx', 'cert-manager', 'traefik', 'contour', 'emissary') }
        @{ q = 'lightweight embedded key value store for go';               want = @('bbolt', 'badger', 'pebble', 'leveldb', 'nutsdb') }
        @{ q = 'react table with virtual scrolling and sorting';            want = @('ag-grid', 'react-virtualized', 'glide-data-grid', 'mui-x', 'react-window') }
        @{ q = 'python library for parsing and validating json schema';     want = @('jsonschema', 'pydantic', 'marshmallow', 'cerberus', 'python-fastjsonschema') }
        @{ q = 'distributed consensus algorithm implementation in go';      want = @('raft', 'etcd', 'dragonboat', 'braft', 'openraft') }
        @{ q = 'build system for monorepo with caching';                    want = @('bazel', 'nx', 'turborepo', 'pants', 'buck2') }
        @{ q = 'open source alternative to notion with self hosting';       want = @('appflowy', 'outline', 'affine', 'memos', 'siyuan') }
        @{ q = 'message queue with exactly once delivery and ordering';     want = @('kafka', 'pulsar', 'rocketmq', 'nats-server', 'redpanda') }
        @{ q = 'static site generator with markdown and themes';            want = @('hugo', 'jekyll', 'gatsby', 'astro', 'eleventy') }
        @{ q = 'feature flag service with gradual rollout';                 want = @('unleash', 'flagsmith', 'growthbook', 'flipper', 'posthog') }
        @{ q = 'sql query builder for typescript with type safety';         want = @('kysely', 'drizzle-orm', 'prisma', 'typeorm', 'slonik') }
        @{ q = 'container image scanner for vulnerabilities';               want = @('trivy', 'grype', 'clair', 'anchore-engine', 'syft') }
        @{ q = 'workflow orchestration for data pipelines';                 want = @('airflow', 'dagster', 'prefect', 'temporal', 'argo-workflows') }
        @{ q = 'realtime collaborative editing library';                    want = @('yjs', 'automerge', 'sharedb', 'prosemirror', 'tiptap') }
    )
}
$cases = @()
foreach ($g in @($caseGroups.Keys)) {
    if ($Set -eq 'all' -or $Set -eq $g) {
        foreach ($c in $caseGroups[$g]) { $cases += [PSCustomObject]@{ q = $c.q; want = $c.want; set = $g } }
    }
}
if ($cases.Count -eq 0) {
    Write-Host ("[quality] -Set {0} 没有匹配用例（可选 all/main/zh/long）" -f $Set)
    exit 2
}

# 平台 shell 重定向取 CLI 的 JSON（不能用 PowerShell 的 `>`：按宿主编码写，中文必坏；
#   也不能用 .NET ReadToEnd：主脚本末尾 exit 会丢输出成 0 字节）。与 tests/crossplat-smoke.ps1 同源。
function Invoke-CliJson([string]$keyword, [int]$limit = 0) {
    if ($limit -le 0) { $limit = $Limit }
    $outPath = Join-Path $tmp ('qb-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
    $errPath = $outPath + '.err'
    # P0-1（2026-10-25 实测补）：**必须隔离跨查询的运行时状态**。
    #   病灶：60 条连续跑时，健康记忆把 GitHub 打成 `deadline`（fails=4，冷冻 60min），
    #   后续查询的等待预算被砍到 1s ⇒ **0 结果雪崩**：实测 60 条里 10 条 TopK 为空，
    #   而同样参数单跑 `websocket library` 返回 5 条。若不隔离，扩样测到的是"健康记忆的副作用"，
    #   不是检索质量。与门禁 U-166/U-242 同源：测量期状态写临时文件，且**每条前重置**。
    $healthPath = Join-Path $tmp ('qb-health-' + $PID + '.json')
    Remove-Item -LiteralPath $healthPath -Force -ErrorAction SilentlyContinue
    $env:MCPS_HEALTH_FILE = $healthPath
    if (-not $env:MCPS_CACHE_FILE) { $env:MCPS_CACHE_FILE = Join-Path $tmp ('qb-cache-' + $PID + '.json') }
    $cli = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $main, '-Keyword', $keyword, '-Platform', 'GitHub', '-Limit', "$limit", '-NoCache', '-AsJson')
    $quoted = ($cli | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    # 调用状态：超时/退出码/stderr 尾巴。上层据此区分"查不到"与"没跑成"。
    $script:lastCli = [PSCustomObject]@{ TimedOut = $false; Killed = $false; Rc = $null; Seconds = 0.0; ErrTail = '' }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    if ($isWin) {
        $cmd = 'chcp 65001 >nul && "' + $hostExe + '" ' + $quoted + ' > "' + $outPath + '" 2> "' + $errPath + '"'
        $proc = $null
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $env:ComSpec
            # 与原 `& $env:ComSpec /c (...)` 逐字同一条命令行：只是换成显式进程，才拿得到可超时的句柄。
            $psi.Arguments = '/c ' + $cmd
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $proc = [System.Diagnostics.Process]::Start($psi)
        } catch { }
        if ($proc) {
            try {
                if (-not $proc.WaitForExit($QueryTimeoutSec * 1000)) {
                    $script:lastCli.TimedOut = $true
                    # /T 杀整棵树。幂等：进程已退出时 taskkill 直接报"找不到"，忽略即可。
                    & $env:ComSpec /c ('taskkill /T /F /PID {0} >nul 2>nul' -f $proc.Id) 2>&1 | Out-Null
                    $script:lastCli.Killed = $true
                    if (-not $proc.WaitForExit(5000)) { try { $proc.Kill() } catch { } }
                } else {
                    $script:lastCli.Rc = $proc.ExitCode
                }
            } catch { }
            $proc.Dispose()
        }
    } else {
        # 非 Windows 仍走原路径（无外部硬超时）。测量在 Windows 上做，这里不引入未经验证的
        #   `timeout`/`pkill` 依赖，避免 macOS 上因缺 coreutils 直接跑不起来。
        $sq = ($cli | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
        & bash -c ("'" + $hostExe + "' " + $sq + " > '" + $outPath + "' 2> '" + $errPath + "'") | Out-Null
    }
    $script:lastCli.Seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
    $text = ''
    try { if (Test-Path -LiteralPath $outPath) { $text = [System.IO.File]::ReadAllText($outPath, [System.Text.Encoding]::UTF8) } } catch { }
    $obj = $null
    try { $obj = $text | ConvertFrom-Json } catch { }
    # 失败时留 stderr 尾巴：没有它，"0 结果"永远只能靠猜。
    if ($null -eq $obj) {
        try {
            if (Test-Path -LiteralPath $errPath) {
                $errLines = @([System.IO.File]::ReadAllLines($errPath, [System.Text.Encoding]::UTF8))
                $tail = @($errLines | Where-Object { $_.Trim() } | Select-Object -Last 6)
                $script:lastCli.ErrTail = ($tail -join ' / ')
            }
        } catch { }
    }
    Remove-Item -LiteralPath $outPath, $errPath -Force -ErrorAction SilentlyContinue
    return $obj
}

function Get-RepoSegment([string]$name) {
    if (-not $name) { return '' }
    $n = $name.Trim()
    if ($n -match '/') { return ($n -split '/')[-1].ToLower() }
    return $n.ToLower()
}

# ================= P0-2：固定语料采集（快照模式） =================
# 为什么要有它：质量基线走 live GitHub，同一查询两次可能不同 —— 改排序/改检索式后，
#   "变好还是变坏"会被网络抖动淹没。这里把**候选池**连同打分信号一起冻结，
#   之后所有排序实验都用 `evals/quality-replay.mjs` 在同一份语料上跑。
# 存的字段 = 离线重排所需的最小集：name/url/stars/updated/archived/desc
#   + relevance/popularity/recency/score/index（score 用来校验重算公式与引擎一致）。
# sha256 覆盖"把本字段替换成 64 个 0 之后的整文件字节"：跨语言（PS 写 / Node 读）不需要
#   约定规范化序列化，任何一处字节改动都会校验失败。规则见 quality-replay.mjs loadSnapshot。
if ($Snapshot) {
    $snapLimit = if ($SnapshotLimit -gt 0) { $SnapshotLimit } else { 50 }
    $snapQueries = @()
    $failed = @()
    $idx = 0
    foreach ($c in $cases) {
        $idx++
        # 采集必须**重试**：实测 60 条里 6 条撞上 GitHub 403/401（secondary rate limit），
        #   不重试就会在语料里留下 6 个空洞 —— 空候选在复算里恒为 miss，等于系统性压低基线，
        #   而且没人看得出来。这是"量具自己有 bug"的典型形态，必须挡住。
        $attempts = 0
        $obj = $null
        $secs = 0.0
        $timedOut = $false
        $verdict = ''; $exitCode = -1
        while ($true) {
            $attempts++
            $obj = Invoke-CliJson $c.q $snapLimit
            $secs = [Math]::Round($secs + $script:lastCli.Seconds, 1)
            $timedOut = $script:lastCli.TimedOut
            $verdict = ''; $exitCode = -1
            if ($null -ne $obj) {
                try { $verdict = [string]$obj.coverage.Verdict } catch { }
                try { $exitCode = [int]$obj.metrics.ExitCode } catch { }
            }
            $needRetry = (-not $timedOut) -and ($attempts -lt 3) -and ($null -eq $obj -or $verdict -eq 'none' -or $exitCode -ge 2)
            if (-not $needRetry) { break }
            # 403（secondary rate limit）需要退避，不是立刻重试
            $wait = if ($attempts -eq 1) { 5000 } else { 20000 }
            Write-Host ("[snapshot]   重试 {0}/3（{1}s 后）：verdict={2} exit={3}" -f $attempts, ($wait / 1000), $verdict, $exitCode)
            Start-Sleep -Milliseconds $wait
        }
        $reason = ''
        if ($null -ne $obj) {
            # 0 命中 / 引擎失败必须能在语料里分开（P0-1 §8.3 的口径洞）
            try { $reason = [string]$obj.metrics.PerPlatformOutcome.ReasonCodes.GitHub } catch { }
        }
        $engineOk = ($null -ne $obj) -and ($verdict -eq 'full' -or $verdict -eq 'partial')
        $note = ''
        if ($timedOut) { $note = 'timeout' }
        elseif ($null -eq $obj) { $note = 'no-json' }
        if (-not $engineOk) {
            $why = if ($timedOut) { 'timeout' } elseif ($null -eq $obj) { 'no-json' } else { ('{0}/exit{1}' -f $verdict, $exitCode) }
            $failed += [PSCustomObject]@{ q = $c.q; set = $c.set; why = $why; reason = $reason; attempts = $attempts }
        }
        $cands = @()
        if ($null -ne $obj) {
            foreach ($r in @($obj.results)) {
                if ($null -eq $r) { continue }
                $d = [string]$r.Desc
                if ($d.Length -gt 200) { $d = $d.Substring(0, 200) }
                $rel = 0.0; $pop = 0.0; $rec = 0.0; $sc = 0.0
                try { $rel = [double]$r.Relevance } catch { }
                try { $pop = [double]$r.Popularity } catch { }
                try { $rec = [double]$r.ScoreParts.recency } catch { }
                try { $sc = [double]$r.Score } catch { }
                $cands += [ordered]@{
                    name       = [string]$r.Name
                    url        = [string]$r.Url
                    stars      = [long]$r.Stars
                    updated    = [string]$r.Updated
                    archived   = [bool]$r.Archived
                    desc       = $d
                    relaxed    = [bool]$r.Relaxed
                    noise      = [bool]$r.NoiseFlagged
                    relevance  = $rel
                    popularity = $pop
                    recency    = $rec
                    score      = $sc
                    index      = [int]$r.Index
                }
            }
        }
        $segs = @($cands | ForEach-Object { Get-RepoSegment $_.name })
        $present = @($c.want | Where-Object { $segs -contains $_ })
        $rank = 0
        for ($k = 0; $k -lt $segs.Count; $k++) {
            if ($c.want -contains $segs[$k]) { $rank = $k + 1; break }
        }
        $snapQueries += [ordered]@{
            set          = $c.set
            q            = $c.q
            want         = @($c.want)
            verdict      = $verdict
            reasonCode   = $reason
            exitCode     = $exitCode
            sec          = $secs
            attempts     = $attempts
            note         = $note
            rank         = $rank
            presentWants = $present
            candidates   = $cands
        }
        Write-Host ("[snapshot] {0}/{1} {2,-30} cand={3,2} rank={4} {5}s try={6} {7}" -f $idx, $cases.Count, $c.q, $cands.Count, $rank, $secs, $attempts, $note)
        # 节流：60 次 search（per_page=50）连发会触发 GitHub secondary rate limit —— 上一轮就是 6 条 403/401
        if ($idx -lt $cases.Count) { Start-Sleep -Milliseconds 1200 }
    }
    if ($failed.Count -gt 0) {
        Write-Host ''
        Write-Host ("[snapshot] 采集失败 {0} 条，**不写语料**（有洞的语料会系统性压低基线）：" -f $failed.Count)
        foreach ($f in $failed) { Write-Host ("  {0} / {1} → {2} ({3}, {4} 次)" -f $f.set, $f.q, $f.why, $f.reason, $f.attempts) }
        Write-Host '[snapshot] 处置：修复凭据/退避后整体重采；不要用残缺语料出读数。'
        exit 5
    }
    $version = ''
    try {
        $m = [regex]::Match([System.IO.File]::ReadAllText($main, [System.Text.Encoding]::UTF8), '(?m)^\$VERSION\s*=\s*"([0-9.]+)"')
        if ($m.Success) { $version = $m.Groups[1].Value }
    } catch { }
    $snapObj = [ordered]@{
        kind             = 'quality-snapshot'
        createdAt        = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        engineVersion    = $version
        set              = $Set
        limit            = $snapLimit
        queryTimeoutSec  = $QueryTimeoutSec
        queryCount       = $snapQueries.Count
        # 只记"有候选"的条数，方便一眼看出语料是否被大面积超时污染
        nonEmptyQueries  = @($snapQueries | Where-Object { $_.candidates.Count -gt 0 }).Count
        totalCandidates  = (@($snapQueries | ForEach-Object { $_.candidates.Count }) | Measure-Object -Sum).Sum
        # 走到这里一定是 0（有失败早退）；写进文件，是为了读语料的人能一眼确认"没有洞"
        failedQueries    = $failed.Count
        queries          = $snapQueries
        sha256           = ('0' * 64)
    }
    $snapText = $snapObj | ConvertTo-Json -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($snapText)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hex = -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    $snapText = $snapText -replace '("sha256":\s*")0{64}"', ('${1}' + $hex + '"')
    $snapPath = if ([System.IO.Path]::IsPathRooted($Snapshot)) { $Snapshot } else { Join-Path $root $Snapshot }
    $snapDir = Split-Path -Parent $snapPath
    if ($snapDir -and -not (Test-Path -LiteralPath $snapDir)) { New-Item -ItemType Directory -Force -Path $snapDir | Out-Null }
    [System.IO.File]::WriteAllText($snapPath, $snapText, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host ("[snapshot] {0} 条查询 / {1} 条候选 / 非空 {2} / v{3} → {4}" -f $snapQueries.Count, $snapObj.totalCandidates, $snapObj.nonEmptyQueries, $version, $snapPath)
    Write-Host ("[snapshot] sha256={0}" -f $hex)
    exit 0
}

$rows = @()
$hit3 = 0; $hit5 = 0; $mrrSum = 0.0; $exec = 0; $attempted = 0; $timeouts = 0
# P0-1：分组统计。每组单独报 n / Hit@3 / Hit@K / MRR@K —— 否则 60 条混在一起，
#   一个"中文全 miss"会被主流组的命中掩盖掉，等于白扩样。
$setStats = [ordered]@{}
foreach ($g in @($caseGroups.Keys)) {
    $setStats[$g] = [PSCustomObject]@{ n = 0; hit3 = 0; hit5 = 0; mrrSum = 0.0 }
}
foreach ($c in $cases) {
    $attempted++
    $obj = Invoke-CliJson $c.q
    $timedOut = $script:lastCli.TimedOut
    $secs = $script:lastCli.Seconds
    $errTail = $script:lastCli.ErrTail
    $verdict = ''; $exitCode = -1
    if ($null -ne $obj) {
        try { $verdict = [string]$obj.coverage.Verdict } catch { }
        try { $exitCode = [int]$obj.metrics.ExitCode } catch { }
    }
    # P0-1（2026-10-25 实测补）：**引擎失败不是 miss**。上一轮 60 条里有 8 条 `Verdict=none/ExitCode=4`
    #   被当成 miss 计进分母 ⇒ Hit@3 从 30.8% 被压到 26.7%。处置：失败重试一次；仍失败则标 no-engine，
    #   **不进分母**，同时单独报 availability。这与 skills-gate 的语义二分同源（没跑成 ≠ 判失败）。
    #   但**超时不重试**：挂死的查询再跑一遍还是挂死，只会把墙钟翻倍（上一轮 27 分钟就是这么来的）。
    if (-not $timedOut -and ($null -eq $obj -or $verdict -eq 'none' -or $exitCode -ge 2)) {
        Start-Sleep -Milliseconds 900
        $obj = Invoke-CliJson $c.q
        $timedOut = $script:lastCli.TimedOut
        $secs = [Math]::Round($secs + $script:lastCli.Seconds, 1)
        $errTail = $script:lastCli.ErrTail
        $verdict = ''; $exitCode = -1
        if ($null -ne $obj) {
            try { $verdict = [string]$obj.coverage.Verdict } catch { }
            try { $exitCode = [int]$obj.metrics.ExitCode } catch { }
        }
    }
    if ($timedOut) { $timeouts++ }
    if ($null -eq $obj) {
        $status = if ($timedOut) { 'timeout' } else { 'no-json' }
        $note = if ($timedOut) { ('>{0}s 已杀进程树' -f $QueryTimeoutSec) } elseif ($errTail) { $errTail } else { '' }
        $rows += [PSCustomObject]@{ Set = $c.set; Query = $c.q; Status = $status; HitRank = 0; Verdict = ''; ExitCode = -1; Note = $note; Sec = $secs; TopK = ''; Want = ($c.want -join ',') }
        Write-Host ("[quality:{0}] {1,-30} rank=- status={2} {3}s {4}" -f $c.set, $c.q, $status, $secs, $note)
        continue
    }
    $names = @($obj.results | ForEach-Object { [string]$_.Name })
    $segments = @($names | ForEach-Object { Get-RepoSegment $_ })
    $scorable = ($verdict -eq 'full' -or $verdict -eq 'partial')
    $rank = 0
    for ($i = 0; $i -lt $segments.Count; $i++) {
        if ($c.want -contains $segments[$i]) { $rank = $i + 1; break }
    }
    $status = if (-not $scorable) { 'no-engine' } elseif ($rank -gt 0) { 'hit' } else { 'miss' }
    $note = if ($scorable) { '' } else { ('Verdict={0} ExitCode={1}' -f $verdict, $exitCode) }
    if ($scorable) {
        $exec++
        $st = $setStats[$c.set]
        $st.n = $st.n + 1
        if ($rank -ge 1 -and $rank -le 3) { $hit3++; $st.hit3 = $st.hit3 + 1 }
        if ($rank -ge 1 -and $rank -le $Limit) {
            $hit5++; $mrrSum += (1.0 / $rank)
            $st.hit5 = $st.hit5 + 1; $st.mrrSum = $st.mrrSum + (1.0 / $rank)
        }
    }
    $rows += [PSCustomObject]@{
        Set      = $c.set
        Query    = $c.q
        Status   = $status
        HitRank  = $rank
        Verdict  = $verdict
        ExitCode = $exitCode
        Note     = $note
        Sec      = $secs
        TopK     = ($names -join ' | ')
        Want     = ($c.want -join ',')
    }
    Write-Host ("[quality:{0}] {1,-30} rank={2} verdict={3} {4}s top={5}" -f $c.set, $c.q, $(if ($rank -gt 0) { $rank } else { '-' }), $verdict, $secs, ($names -join ', '))
}

$n = if ($exec -gt 0) { $exec } else { 1 }
$hit3Rate = [Math]::Round(100.0 * $hit3 / $n, 1)
$hit5Rate = [Math]::Round(100.0 * $hit5 / $n, 1)
$mrr = [Math]::Round($mrrSum / $n, 3)
$avail = [Math]::Round(100.0 * $exec / [Math]::Max(1, $attempted), 1)
# n=0 时把 0% 写成"不适用"：0/0 的商不是 0%，写 0% 会被读成"一个都没命中"。
$readout = if ($exec -gt 0) { ('Hit@3={0}% Hit@{1}={2}% MRR@{1}={3}' -f $hit3Rate, $Limit, $hit5Rate, $mrr) } else { ('Hit@3=n/a Hit@{0}=n/a MRR@{0}=n/a（无可评分样本）' -f $Limit) }
Write-Host ''
Write-Host ("[quality] attempted={0} scorable={1} availability={2}% timeouts={3} {4}" -f $attempted, $exec, $avail, $timeouts, $readout)

# ---- 落盘：Markdown 报告（人读）+ JSON（复核用）----
$stamp = Get-Date -Format 'yyyy-MM-dd'
# P0-1：单跑某一组时**不许覆盖全量报告**（否则 main 单跑会把 60 条的读数冲掉）。
$suffix = if ($Set -eq 'all') { '' } else { '-' + $Set }
$mdPath = Join-Path $OutDir ("quality-baseline-{0}{1}.md" -f $stamp, $suffix)
$jsonPath = Join-Path $OutDir ("quality-baseline-{0}{1}.json" -f $stamp, $suffix)
$lines = @()
$lines += ("# 质量基线（repo 池弱标注）— {0}" -f $stamp)
$lines += ''
$lines += ('> 口径：GitHub 单源、`-Limit {0}`、`-NoCache`；期望集为**弱标注**（生态共识，非人工金标）；' -f $Limit)
$lines += '> 匹配只看 repo 名（`owner/repo` 取后一段，小写）；指标为查询级 Hit@3 / Hit@K / MRR@K。'
$lines += ('> 用例集：{0}（main=主流 / zh=中文主题词 / long=长句）；本次跑的是 `-Set {1}`。' -f ("n=" + $exec), $Set)
$lines += ('> 单条查询硬超时 `-QueryTimeoutSec {0}`：超时杀进程树，标 `timeout`，**不进分母**。' -f $QueryTimeoutSec)
$lines += ''
$mdReadout = if ($exec -gt 0) { ('**Hit@3={0}%**，**Hit@{1}={2}%**，**MRR@{1}={3}**' -f $hit3Rate, $Limit, $hit5Rate, $mrr) } else { ('**Hit@3=—**，**Hit@{0}=—**，**MRR@{0}=—**（n/a：无一条可评分，0/0 不等于 0%）' -f $Limit) }
$lines += ('**本次读数**：n={0}（可评分；attempted={1}，availability={2}%，timeouts={3}），{4}' -f $exec, $attempted, $avail, $timeouts, $mdReadout)
$lines += ''
$lines += '## 分组读数（同一把尺子，分开报）'
$lines += ''
$lines += '| 组 | n | Hit@3 | Hit@5 | MRR@5 | 说明 |'
$lines += '|---|---|---|---|---|---|'
$setNote = @{ main = '主流英文主题（与旧 12 条同族）'; zh = '中文主题词（词法映射未覆盖时的主要边界）'; long = '长句/复合需求（多词约束）' }
foreach ($g in @($caseGroups.Keys)) {
    $s = $setStats[$g]
    if ($s.n -eq 0) { continue }
    $g3 = [Math]::Round(100.0 * $s.hit3 / $s.n, 1)
    $g5 = [Math]::Round(100.0 * $s.hit5 / $s.n, 1)
    $gm = [Math]::Round($s.mrrSum / $s.n, 3)
    $lines += ('| {0} | {1} | {2}% | {3}% | {4} | {5} |' -f $g, $s.n, $g3, $g5, $gm, $setNote[$g])
}
$lines += ''
$lines += '## 明细'
$lines += ''
$lines += '| 组 | 查询 | 结果 | 命中名次 | 引擎判定 | 耗时(s) | 备注 | Top-K（实际返回） |'
$lines += '|---|---|---|---|---|---|---|---|'
foreach ($r in $rows) {
    $v = if ($r.Verdict) { $r.Verdict } else { '-' }
    $lines += ('| {0} | `{1}` | {2} | {3} | {4} | {5} | {6} | {7} |' -f $r.Set, $r.Query, $r.Status, $(if ($r.HitRank -gt 0) { $r.HitRank } else { '-' }), $v, $r.Sec, (($r.Note -replace '\|', '/') -replace '\r?\n', ' '), ($r.TopK -replace '\|', '/'))
}
# P0-1：0 结果必须归因，否则"引擎失败"会被读成"这个主题没有项目"。
$emptyRows = @($rows | Where-Object { -not $_.TopK })
if ($emptyRows.Count -gt 0) {
    $lines += ''
    $lines += ('## 0 结果归因（{0} 条）' -f $emptyRows.Count)
    $lines += ''
    $lines += '| 组 | 查询 | 结果 | 引擎判定 | ExitCode | 备注 |'
    $lines += '|---|---|---|---|---|---|'
    foreach ($r in $emptyRows) {
        $v = if ($r.Verdict) { $r.Verdict } else { '-' }
        $lines += ('| {0} | `{1}` | {2} | {3} | {4} | {5} |' -f $r.Set, $r.Query, $r.Status, $v, $r.ExitCode, (($r.Note -replace '\|', '/') -replace '\r?\n', ' '))
    }
    $lines += ''
    $lines += ('> `Verdict=full` 且 `ExitCode=0` 的空结果才是"真的没有"；其余是引擎失败（deadline/forbidden）或 `timeout`（>{0}s 被杀），**不得计入质量**。' -f $QueryTimeoutSec)
}
$lines += ''
$lines += '## 怎么用这个数字'
$lines += ''
$lines += '- **可承诺的部分**：主流答案进前 3 的比例；它是"典型调研查询"的下界，不是所有查询的保证。'
$lines += '- **分组读数的意义**：`zh` 与 `long` 是**已知弱项**。它们的绝对值低不丢人，丢人的是**没有读数**——分组后每次改动都能看出"是不是又压低了中文/长句"。'
$lines += '- **不可承诺的部分**：极其小众的主题、未进词法映射的领域黑话 —— 这些受词法匹配限制，见 `references/参数速查.md`。'
$lines += '- **回归用法**：改动检索式/排序后重跑本脚本，同一组的 Hit@3 **下降超过 5 个百分点**即视为质量回退；跨组不可比。'
[System.IO.File]::WriteAllLines($mdPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
$sets = [ordered]@{}
foreach ($g in @($caseGroups.Keys)) {
    $s = $setStats[$g]
    if ($s.n -eq 0) { continue }
    $sets[$g] = [PSCustomObject]@{
        n = $s.n
        hit3 = [Math]::Round(100.0 * $s.hit3 / $s.n, 1)
        hit5 = [Math]::Round(100.0 * $s.hit5 / $s.n, 1)
        mrr = [Math]::Round($s.mrrSum / $s.n, 3)
    }
}
$json = [PSCustomObject]@{ date = $stamp; set = $Set; limit = $Limit; queryTimeoutSec = $QueryTimeoutSec; attempted = $attempted; n = $exec; availability = $avail; timeouts = $timeouts; hit3 = $hit3Rate; hit5 = $hit5Rate; mrr = $mrr; sets = $sets; rows = $rows }
[System.IO.File]::WriteAllText($jsonPath, ($json | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("[quality] 报告: {0}" -f $mdPath)
# 落盘自检：写失败必须非 0 退出，否则"有报告"只是打印出来的假象。
$mdOk = Test-Path -LiteralPath $mdPath
$jsonOk = Test-Path -LiteralPath $jsonPath
if (-not ($mdOk -and $jsonOk)) {
    Write-Host ("[quality] 落盘失败：md={0} json={1}（OutDir 不可写？）" -f $mdOk, $jsonOk)
    exit 3
}
if ($exec -eq 0) { exit 1 } else { exit 0 }
