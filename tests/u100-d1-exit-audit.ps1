# U-100 D1 P3：函数体内 exit 审计（ExitStatementAst，不是 CommandAst —— 后者会给假零）。输出 JSON。
param([string]$Path = 'multi-platform-searcher.ps1')
$t=$null;$e=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Path).Path,[ref]$t,[ref]$e)
$exits=@($ast.FindAll({param($x) $x -is [System.Management.Automation.Language.ExitStatementAst]},$true))
$fns=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true))
$withExit=@(); foreach ($f in $fns) { $n=@($f.Body.FindAll({param($x) $x -is [System.Management.Automation.Language.ExitStatementAst]},$true)).Count; if ($n) { $withExit += [PSCustomObject]@{ name=$f.Name; exits=$n } } }
[PSCustomObject]@{ path=$Path; parseErrors=@($e).Count; functions=$fns.Count; exitTotal=$exits.Count; exitLines=@($exits | ForEach-Object { $_.Extent.StartLineNumber }); functionsWithExit=$withExit } | ConvertTo-Json -Compress -Depth 4
