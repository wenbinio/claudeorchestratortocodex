$ErrorActionPreference = 'Stop'

function Stop-Merge {
    param(
        [string]$Branch,
        [string]$Verdict
    )

    [Console]::Error.WriteLine(
        "Merge blocked for branch '$Branch' (verdict: $Verdict). " +
        "This hook gates only Claude's tool calls; the user's own terminal is unaffected. " +
        "Path forward: apply the reviewer's fixes or re-run dispatch."
    )
    exit 2
}

function Remove-ShellTokenWrapping {
    param([string]$Token)

    $value = $Token.Trim()
    $value = $value.TrimStart([char[]]@('(')).TrimEnd([char[]]@(')'))

    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or
            ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }

    return $value.TrimStart([char[]]@('(')).TrimEnd([char[]]@(')'))
}

function Get-CodexMergeBranches {
    param([string]$Command)

    $branches = @()
    foreach ($segment in [regex]::Split($Command, '[\r\n;&|]+')) {
        $trimmed = $segment.Trim()
        if ($trimmed.Length -eq 0) {
            continue
        }

        $tokens = @([regex]::Split($trimmed, '\s+') | ForEach-Object {
            Remove-ShellTokenWrapping $_
        })

        if ($tokens.Count -lt 3 -or
            -not [string]::Equals($tokens[0], 'git', [StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($tokens[1], 'merge', [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }

        for ($index = 2; $index -lt $tokens.Count; $index++) {
            $candidate = $tokens[$index]
            if ($candidate -cmatch '^codex/[A-Za-z0-9._/-]+$' -and
                $branches -cnotcontains $candidate) {
                $branches += $candidate
            }
        }
    }

    return $branches
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

    $branches = @(Get-CodexMergeBranches $command)
    if ($branches.Count -eq 0) {
        exit 0
    }

    $repoOutput = @(& git rev-parse --show-toplevel 2>$null)
    if ($LASTEXITCODE -ne 0 -or $repoOutput.Count -eq 0) {
        exit 0
    }

    $repoKey = ($repoOutput -join "`n").Trim().Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($repoKey)) {
        exit 0
    }

    $dataDir = $env:CLAUDE_PLUGIN_DATA
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        if ([string]::IsNullOrWhiteSpace($HOME)) {
            exit 0
        }
        $dataDir = Join-Path $HOME '.claude/plugins/data/codex-fleet'
    }

    $approvedPath = Join-Path $dataDir 'approved.json'
    if (-not (Test-Path -LiteralPath $approvedPath -PathType Leaf)) {
        exit 0
    }

    $approved = Get-Content -Raw -LiteralPath $approvedPath | ConvertFrom-Json -ErrorAction Stop
    if ($approved -isnot [PSCustomObject]) {
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
        exit 0
    }

    foreach ($branch in $branches) {
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

        $tipOutput = @(& git rev-parse $branch 2>$null)
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
            continue
        }

        $verdictProperty = @($entry.PSObject.Properties | Where-Object {
            $_.Name -ceq 'verdict'
        } | Select-Object -First 1)
        if ($verdictProperty.Count -ne 1 -or
            $verdictProperty[0].Value -isnot [string]) {
            Stop-Merge -Branch $branch -Verdict 'malformed'
        }

        $verdict = $verdictProperty[0].Value
        if ($verdict -ceq 'approve') {
            continue
        }
        if ($verdict -ceq 'needs_work' -or $verdict -ceq 'reject') {
            Stop-Merge -Branch $branch -Verdict $verdict
        }

        Stop-Merge -Branch $branch -Verdict 'malformed'
    }

    exit 0
} catch {
    exit 0
}
