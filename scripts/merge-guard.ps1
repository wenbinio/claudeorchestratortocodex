# Advisory tripwire only: the dispatch/integration protocol is the enforcement
# layer. This hook is not a security boundary and must fail open on errors.
$ErrorActionPreference = 'Stop'

function Stop-Merge {
    param(
        [string]$Branch,
        [string]$Verdict
    )

    [Console]::Error.WriteLine(
        "Merge blocked for branch '$Branch' (verdict: $Verdict). " +
        "This advisory tripwire gates only Claude's tool calls; the user's own terminal is unaffected. " +
        "Path forward: apply the reviewer's fixes and re-run dispatch to re-review, or merge from your own terminal."
    )
    exit 2
}

function Resolve-DataDirectory {
    if (-not [string]::IsNullOrWhiteSpace($env:CLAUDE_PLUGIN_DATA)) {
        return $env:CLAUDE_PLUGIN_DATA
    }

    if ([string]::IsNullOrWhiteSpace($HOME)) {
        return $null
    }

    # Marketplace installs may qualify the data-dir id; glob before assuming
    # the bare name. No match is an infrastructure miss, so the guard opens.
    $dataRoot = Join-Path $HOME '.claude/plugins/data'
    $globMatches = @(
        Get-ChildItem -LiteralPath $dataRoot -Directory -Filter '*codex-fleet*' -ErrorAction SilentlyContinue
    )
    if ($globMatches.Count -ge 1) {
        return $globMatches[0].FullName
    }

    return $null
}

function ConvertTo-StaticCommandToken {
    param([System.Management.Automation.Language.CommandElementAst]$Element)

    if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return [PSCustomObject]@{ IsStatic = $true; Value = $Element.Value }
    }

    if ($Element -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and
        $Element.NestedExpressions.Count -eq 0) {
        return [PSCustomObject]@{ IsStatic = $true; Value = $Element.Value }
    }

    if ($Element -is [System.Management.Automation.Language.CommandParameterAst]) {
        return [PSCustomObject]@{ IsStatic = $true; Value = $Element.Extent.Text }
    }

    return [PSCustomObject]@{ IsStatic = $false; Value = $null }
}

function Get-StaticCommandTokens {
    param([System.Management.Automation.Language.CommandAst]$CommandAst)

    $values = @()
    foreach ($element in $CommandAst.CommandElements) {
        $token = ConvertTo-StaticCommandToken $element
        if (-not $token.IsStatic) {
            return [PSCustomObject]@{ Success = $false; Tokens = @() }
        }
        $values += [string]$token.Value
    }

    return [PSCustomObject]@{ Success = $true; Tokens = @($values) }
}

function Get-CommandBaseName {
    param([string]$Token)

    if ([string]::IsNullOrWhiteSpace($Token)) {
        return ''
    }

    $normalized = $Token.Replace('/', '\')
    return [System.IO.Path]::GetFileName($normalized)
}

function Test-IsGitCommand {
    param([string]$Token)

    $name = Get-CommandBaseName $Token
    return [string]::Equals($name, 'git', [StringComparison]::OrdinalIgnoreCase) -or
        [string]::Equals($name, 'git.exe', [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsEnvironmentAssignment {
    param([string]$Token)

    return $Token -cmatch '^[A-Za-z_][A-Za-z0-9_]*='
}

function Find-GitTokenIndex {
    param([string[]]$Tokens)

    $index = 0
    $mode = 'leader'
    $expectWrapperValue = $false

    while ($index -lt $Tokens.Count) {
        $token = $Tokens[$index]

        if ($expectWrapperValue) {
            $expectWrapperValue = $false
            $index++
            continue
        }

        if ($mode -eq 'leader') {
            if (Test-IsEnvironmentAssignment $token) {
                $index++
                continue
            }
            if (Test-IsGitCommand $token) {
                return $index
            }

            $name = (Get-CommandBaseName $token).ToLowerInvariant()
            switch ($name) {
                'command' { $mode = 'command'; $index++; continue }
                'command.exe' { $mode = 'command'; $index++; continue }
                'exec' { $mode = 'exec'; $index++; continue }
                'env' { $mode = 'env'; $index++; continue }
                'env.exe' { $mode = 'env'; $index++; continue }
                'sudo' { $mode = 'sudo'; $index++; continue }
                'sudo.exe' { $mode = 'sudo'; $index++; continue }
                default { return -1 }
            }
        }

        if ($mode -eq 'command') {
            if ($token -ceq '-v' -or $token -ceq '-V') {
                return -1
            }
            if ($token -ceq '-p' -or $token -ceq '--') {
                $index++
                continue
            }
            $mode = 'leader'
            continue
        }

        if ($mode -eq 'exec') {
            if ($token -ceq '--') {
                $index++
                continue
            }
            if ($token -ceq '-a') {
                $expectWrapperValue = $true
                $index++
                continue
            }
            if ($token.StartsWith('-')) {
                $index++
                continue
            }
            $mode = 'leader'
            continue
        }

        if ($mode -eq 'env') {
            if (Test-IsEnvironmentAssignment $token) {
                $index++
                continue
            }
            if ($token -ceq '--') {
                $mode = 'leader'
                $index++
                continue
            }
            if ($token -ceq '-u' -or $token -ceq '--unset' -or
                $token -ceq '-C' -or $token -ceq '--chdir') {
                $expectWrapperValue = $true
                $index++
                continue
            }
            if ($token.StartsWith('--unset=') -or $token.StartsWith('--chdir=') -or
                $token -ceq '-i' -or $token -ceq '--ignore-environment' -or
                $token -ceq '-0' -or $token -ceq '--null') {
                $index++
                continue
            }
            if ($token.StartsWith('-')) {
                $index++
                continue
            }
            $mode = 'leader'
            continue
        }

        if ($mode -eq 'sudo') {
            if ($token -ceq '--') {
                $mode = 'leader'
                $index++
                continue
            }
            if ($token -in @('-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt',
                    '-C', '--close-from', '-T', '--command-timeout', '-R', '--chroot', '-D', '--chdir')) {
                $expectWrapperValue = $true
                $index++
                continue
            }
            if ($token -cmatch '^--(?:user|group|host|prompt|close-from|command-timeout|chroot|chdir)=') {
                $index++
                continue
            }
            if ($token.StartsWith('-')) {
                $index++
                continue
            }
            $mode = 'leader'
            continue
        }
    }

    return -1
}

function Get-WrappedCommandTexts {
    param([string[]]$Tokens)

    if ($Tokens.Count -lt 2) {
        return @()
    }

    $name = (Get-CommandBaseName $Tokens[0]).ToLowerInvariant()
    if ($name -in @('invoke-expression', 'iex')) {
        return @($Tokens[1])
    }

    if ($name -in @('powershell', 'powershell.exe', 'pwsh', 'pwsh.exe')) {
        for ($index = 1; $index -lt $Tokens.Count - 1; $index++) {
            if ($Tokens[$index] -in @('-Command', '-C', '-c')) {
                return @($Tokens[$index + 1])
            }
        }
        return @()
    }

    if ($name -in @('cmd', 'cmd.exe')) {
        for ($index = 1; $index -lt $Tokens.Count - 1; $index++) {
            if ($Tokens[$index] -in @('/c', '/C', '/k', '/K')) {
                return @($Tokens[$index + 1])
            }
        }
        return @()
    }

    if ($name -in @('sh', 'sh.exe', 'bash', 'bash.exe', 'dash', 'zsh', 'ksh')) {
        for ($index = 1; $index -lt $Tokens.Count - 1; $index++) {
            if ($Tokens[$index] -ceq '-c') {
                return @($Tokens[$index + 1])
            }
        }
    }

    return @()
}

function Resolve-CommandTarget {
    param(
        [string]$CurrentTarget,
        [string]$Path
    )

    if ($Path.Length -eq 0) {
        return $CurrentTarget
    }

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $CurrentTarget $Path))
}

function Get-NormalizedCodexBranch {
    param([string]$Token)

    $branch = $Token
    if ($branch.StartsWith('refs/heads/', [StringComparison]::Ordinal)) {
        $branch = $branch.Substring('refs/heads/'.Length)
    }

    if ($branch -cmatch '^codex/[A-Za-z0-9._/-]+$') {
        return $branch
    }

    return $null
}

function Get-MergeInvocationsFromTokens {
    param(
        [string[]]$Tokens,
        [string]$FallbackTarget
    )

    $gitIndex = Find-GitTokenIndex $Tokens
    if ($gitIndex -lt 0) {
        return @()
    }

    $target = $FallbackTarget
    $index = $gitIndex + 1
    $foundMerge = $false
    while ($index -lt $Tokens.Count) {
        $token = $Tokens[$index]
        if ([string]::Equals($token, 'merge', [StringComparison]::OrdinalIgnoreCase)) {
            $foundMerge = $true
            $index++
            break
        }

        if ($token -ceq '-C') {
            if ($index + 1 -ge $Tokens.Count) {
                return @()
            }
            $target = Resolve-CommandTarget -CurrentTarget $target -Path $Tokens[$index + 1]
            $index += 2
            continue
        }
        if ($token.StartsWith('-C', [StringComparison]::Ordinal) -and $token.Length -gt 2) {
            $target = Resolve-CommandTarget -CurrentTarget $target -Path $token.Substring(2)
            $index++
            continue
        }

        if ($token -in @('-c', '--config-env', '--exec-path', '--git-dir', '--work-tree',
                '--namespace', '--super-prefix')) {
            if ($index + 1 -ge $Tokens.Count) {
                return @()
            }
            $index += 2
            continue
        }
        if ($token -cmatch '^(?:-c.+|--(?:config-env|exec-path|git-dir|work-tree|namespace|super-prefix)=.+)$') {
            $index++
            continue
        }
        if ($token -ceq '--' -or $token.StartsWith('-')) {
            $index++
            continue
        }

        return @()
    }

    if (-not $foundMerge) {
        return @()
    }

    $invocations = @()
    $expectValue = $false
    while ($index -lt $Tokens.Count) {
        $token = $Tokens[$index]
        if ($expectValue) {
            $expectValue = $false
            $index++
            continue
        }

        if ($token -in @('-m', '--message', '-F', '--file', '-s', '--strategy', '-X',
                '--strategy-option', '--cleanup', '--into-name')) {
            $expectValue = $true
            $index++
            continue
        }
        if ($token -cmatch '^(?:-[mFsX].+|--(?:message|file|strategy|strategy-option|cleanup|into-name)=.+)$') {
            $index++
            continue
        }
        if ($token -ceq '--') {
            $index++
            continue
        }
        if ($token.StartsWith('-')) {
            $index++
            continue
        }

        $branch = Get-NormalizedCodexBranch $token
        if ($null -ne $branch) {
            $invocations += [PSCustomObject]@{ Target = $target; Branch = $branch }
        }
        $index++
    }

    return @($invocations)
}

function Get-CodexMergeInvocations {
    param(
        [string]$Command,
        [string]$FallbackTarget,
        [int]$Depth = 0
    )

    if ($Depth -gt 4) {
        return @()
    }

    $parseTokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        $Command,
        [ref]$parseTokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        return @()
    }

    $invocations = @()
    $commandAsts = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.CommandAst]
    }, $true))

    foreach ($commandAst in $commandAsts) {
        $result = Get-StaticCommandTokens $commandAst
        if (-not $result.Success -or $result.Tokens.Count -eq 0) {
            continue
        }

        $invocations += @(Get-MergeInvocationsFromTokens -Tokens $result.Tokens -FallbackTarget $FallbackTarget)
        foreach ($wrappedCommand in @(Get-WrappedCommandTexts $result.Tokens)) {
            $invocations += @(Get-CodexMergeInvocations `
                -Command $wrappedCommand `
                -FallbackTarget $FallbackTarget `
                -Depth ($Depth + 1))
        }
    }

    return @($invocations)
}

function Get-CanonicalRepoKey {
    param([string]$Target)

    $commonOutput = @(& git -C $Target rev-parse --git-common-dir 2>$null)
    if ($LASTEXITCODE -ne 0 -or $commonOutput.Count -eq 0) {
        return $null
    }

    $commonDir = ($commonOutput -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($commonDir)) {
        return $null
    }

    if ([System.IO.Path]::IsPathRooted($commonDir)) {
        $commonPath = [System.IO.Path]::GetFullPath($commonDir)
    } else {
        $commonPath = [System.IO.Path]::GetFullPath((Join-Path $Target $commonDir))
    }

    $resolved = Resolve-Path -LiteralPath $commonPath -ErrorAction Stop
    return $resolved.ProviderPath.Replace('\', '/')
}

try {
    $inputJson = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($inputJson)) {
        exit 0
    }

    $payload = $inputJson | ConvertFrom-Json -ErrorAction Stop
    if ($payload -isnot [PSCustomObject]) {
        exit 0
    }

    $command = $null
    $toolInputProperty = @($payload.PSObject.Properties | Where-Object {
        $_.Name -ceq 'tool_input'
    } | Select-Object -First 1)
    if ($toolInputProperty.Count -eq 1 -and
        $toolInputProperty[0].Value -is [PSCustomObject]) {
        $commandProperty = @($toolInputProperty[0].Value.PSObject.Properties | Where-Object {
            $_.Name -ceq 'command'
        } | Select-Object -First 1)
        if ($commandProperty.Count -eq 1 -and $commandProperty[0].Value -is [string]) {
            $command = $commandProperty[0].Value
        }
    }

    if ($null -eq $command) {
        $commandProperty = @($payload.PSObject.Properties | Where-Object {
            $_.Name -ceq 'command'
        } | Select-Object -First 1)
        if ($commandProperty.Count -eq 1 -and $commandProperty[0].Value -is [string]) {
            $command = $commandProperty[0].Value
        }
    }

    if ([string]::IsNullOrWhiteSpace($command)) {
        exit 0
    }

    $fallbackTarget = (Get-Location).ProviderPath
    $invocations = @(Get-CodexMergeInvocations `
        -Command $command `
        -FallbackTarget $fallbackTarget)
    if ($invocations.Count -eq 0) {
        exit 0
    }

    $dataDir = Resolve-DataDirectory
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        exit 0
    }

    $approvedPath = Join-Path $dataDir 'approved.json'
    if (-not (Test-Path -LiteralPath $approvedPath -PathType Leaf)) {
        exit 0
    }

    $approved = Get-Content -Raw -LiteralPath $approvedPath | ConvertFrom-Json -ErrorAction Stop
    if ($approved -isnot [PSCustomObject]) {
        exit 0
    }

    foreach ($invocation in $invocations) {
        $branch = $invocation.Branch
        $target = $invocation.Target
        $repoKey = Get-CanonicalRepoKey $target
        if ([string]::IsNullOrWhiteSpace($repoKey)) {
            exit 0
        }

        $repoProperty = $null
        foreach ($property in $approved.PSObject.Properties) {
            if ([string]::Equals(
                    [string]$property.Name,
                    $repoKey,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                $repoProperty = $property
                break
            }
        }

        if ($null -eq $repoProperty) {
            continue
        }

        $repoEntry = $repoProperty.Value
        if ($repoEntry -isnot [PSCustomObject]) {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }

        $branchProperty = @($repoEntry.PSObject.Properties | Where-Object {
            $_.Name -ceq $branch
        } | Select-Object -First 1)
        if ($branchProperty.Count -ne 1) {
            Stop-Merge -Branch $branch -Verdict 'missing'
        }

        $entry = $branchProperty[0].Value
        if ($entry -isnot [PSCustomObject]) {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }

        $shaProperty = @($entry.PSObject.Properties | Where-Object {
            $_.Name -ceq 'sha'
        } | Select-Object -First 1)
        if ($shaProperty.Count -ne 1 -or
            $shaProperty[0].Value -isnot [string] -or
            $shaProperty[0].Value -cnotmatch '^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$') {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }
        $recordedSha = $shaProperty[0].Value

        $tipOutput = @(& git -C $target rev-parse $branch 2>$null)
        if ($LASTEXITCODE -ne 0 -or $tipOutput.Count -eq 0) {
            exit 0
        }
        $currentSha = ($tipOutput -join "`n").Trim()
        if ($currentSha -notmatch '^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$') {
            exit 0
        }

        if (-not [string]::Equals(
                $currentSha,
                $recordedSha,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            # A7.8 block-on-stale: a recorded branch that changed since review
            # is stale/unreviewed, closing the amend-one-commit bypass.
            Stop-Merge -Branch $branch -Verdict 'stale (branch changed since review)'
        }

        $verdictProperty = @($entry.PSObject.Properties | Where-Object {
            $_.Name -ceq 'verdict'
        } | Select-Object -First 1)
        if ($verdictProperty.Count -ne 1 -or
            $verdictProperty[0].Value -isnot [string]) {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }

        $verdict = $verdictProperty[0].Value
        if ($verdict -ceq 'needs_work' -or $verdict -ceq 'reject') {
            Stop-Merge -Branch $branch -Verdict $verdict
        }
        if ($verdict -cne 'approve') {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }

        $eligibleProperty = @($entry.PSObject.Properties | Where-Object {
            $_.Name -ceq 'eligible'
        } | Select-Object -First 1)
        if ($eligibleProperty.Count -ne 1 -or
            $eligibleProperty[0].Value -isnot [bool]) {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }
        if (-not $eligibleProperty[0].Value) {
            Stop-Merge -Branch $branch -Verdict 'ineligible (verification requirements not met)'
        }
    }

    exit 0
} catch {
    exit 0
}
