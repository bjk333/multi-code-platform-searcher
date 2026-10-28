# U-128 离线 harness：P3/P4/P5 判据（dot-source 主脚本，MCPS_NO_MAIN=1，不联网）。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)   # R69 A1：与 u124 harness 同口径，stdout 钉死 UTF-8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$main = (Resolve-Path (Join-Path (Join-Path $here '..') 'multi-platform-searcher.ps1')).Path
$env:MCPS_NO_MAIN = '1'
. $main -NoEnvFile -AsJson -Keyword 'x' -Limit 5
function Row($plat, $name, $desc, $url) { [PSCustomObject]@{ Platform = $plat; Name = $name; Stars = 10; Unit = 'stars'; Url = $url; Desc = $desc; License = ''; Updated = '' } }
$cases = @(
    @{ Id = 'P3-spelling-plural'; Keyword = 'serialization benchmark'; Rows = @(Row 'GitHub' 'fastser' 'Fast JSON serialisation benchmarks for Rust' 'https://github.com/a/fastser') },
    @{ Id = 'P4-substring';       Keyword = 'code';                    Rows = @(Row 'crates.io' 'unicode-ident' 'Determine whether characters have the XID_Start property per Unicode Standard Annex 31' 'https://crates.io/crates/unicode-ident') },
    @{ Id = 'P5-url-only';        Keyword = 'serialization';           Rows = @(Row 'GitHub' 'foo' 'bar baz' 'https://github.com/x/serialization') },
    @{ Id = 'P2-wholeword-keeps'; Keyword = 'code search evaluation benchmark'; Rows = @(Row 'arXiv' 'Benchmark Radar: A Living Database and Search Engine for AI Benchmarks and Evaluation' 'code search benchmark evaluation' 'https://arxiv.org/abs/1') },
    @{ Id = 'P3b-reverse';        Keyword = 'serialisation';           Rows = @(Row 'npm' 'ser' 'Fast serialization library' 'https://npmjs.com/ser') }
)
$out = foreach ($c in $cases) {
    $s = Set-UnifiedScore -Results $c.Rows -Keyword $c.Keyword
    $r = @($s)[0]
    [PSCustomObject]@{ Id = $c.Id; Keyword = $c.Keyword; Relevance = $r.Relevance; MatchTerms = @($r.MatchTerms); Score = $r.Score }
}
$out | ConvertTo-Json -Depth 4
