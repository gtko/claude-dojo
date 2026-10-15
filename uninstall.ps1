<#
.SYNOPSIS
    Uninstalls Claude Dojo on Windows: autostart, agent launcher, DojoWallpaper.exe, Dojo entries of settings.json.
.DESCRIPTION
    Windows counterpart of uninstall.sh. This script is a thin wrapper: the logic lives in src/setup.js.
    The agent (node running agent-win.js, with its collector and media helper) and DojoWallpaper.exe are stopped first.
    Only what install.ps1 added is removed. Other hooks, settings and plugins of Claude Code are left untouched.
    Without -Purge, config.json and backgrounds\ are kept, so that a reinstall reuses them.
.PARAMETER Purge
    Also deletes the Dojo folder (config.json, backgrounds and cache) and the wallpaper session state (~\.claude\dojo).
.EXAMPLE
    pwsh -File uninstall.ps1
.EXAMPLE
    pwsh -File uninstall.ps1 -Purge
.NOTES
    Environment variables: DOJO_SKIP_REGISTRY=1 leaves the HKCU Run values alone (tests and CI).
    USERPROFILE selects the profile, as it does for setup.js.
#>
param(
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
# Node.js major version required by setup.js.
$MinNodeMajor = 18
# No gh credential probe (as in uninstall.sh).
$env:DOJO_DETECT_NO_GH_AUTH = '1'

function Write-Step([string]$Text) { Write-Host "==> $Text" }
function Write-Info([string]$Text) { Write-Host "    $Text" }

# Runs a program without a shell. stdin: optional text, sent as UTF-8. stdout and stderr are read as UTF-8.
# Returns ExitCode, Stdout and Stderr once the program has exited.
function Invoke-Program {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [string[]]$Arguments = @(),
        [string]$StdinText = $null
    )
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FileName
    # Each argument is quoted. The values passed here never contain a double quote.
    $psi.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        $writer = [System.IO.StreamWriter]::new($proc.StandardInput.BaseStream, [System.Text.UTF8Encoding]::new($false))
        if ($null -ne $StdinText) { $writer.Write($StdinText) }
        $writer.Close()
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        return [pscustomobject]@{ ExitCode = $proc.ExitCode; Stdout = $stdoutTask.Result; Stderr = $stderr }
    } finally {
        $proc.Dispose()
    }
}

# Runs setup.js. It prints one JSON line on stdout. A JSON argument is passed as '-' with the text on stdin,
# which avoids quoting problems on the command line.
function Invoke-Setup {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$StdinText = $null
    )
    $result = Invoke-Program -FileName $script:NodeExe -Arguments (@($script:SetupJs) + $Arguments) -StdinText $StdinText
    $text = $result.Stdout.Trim()
    if ($result.ExitCode -ne 0) {
        $reason = $null
        try { $reason = ($text | ConvertFrom-Json).error } catch { $reason = $null }
        if (-not $reason) { $reason = $result.Stderr.Trim() }
        if (-not $reason) { $reason = "exit code $($result.ExitCode)" }
        throw "setup.js $($Arguments[0]) failed: $reason"
    }
    foreach ($line in ($result.Stderr.Trim() -split '\r?\n')) {
        if ($line) { Write-Info $line }
    }
    if ($text -eq '') { return $null }
    return ($text | ConvertFrom-Json)
}

# Node.js 18 or newer: PATH first, then the usual install folders. Returns Path and Version, or $null.
function Find-Node {
    $candidates = @()
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { $candidates += $onPath.Source }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE '.volta\bin\node.exe') }
    if ($env:NVM_SYMLINK) { $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe') }
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $probe = Invoke-Program -FileName $candidate -Arguments @('-p', 'process.versions.node')
        $version = $probe.Stdout.Trim()
        $major = 0
        if ($probe.ExitCode -eq 0 -and [int]::TryParse(($version -split '\.')[0], [ref]$major) -and $major -ge $MinNodeMajor) {
            return [pscustomobject]@{ Path = $candidate; Version = $version }
        }
    }
    return $null
}

function Invoke-Uninstall {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'this script runs on Windows only (use uninstall.sh on macOS).'
    }
    $script:SetupJs = Join-Path (Join-Path $PSScriptRoot 'src') 'setup.js'
    if (-not (Test-Path -LiteralPath $script:SetupJs -PathType Leaf)) {
        throw 'src\setup.js not found next to uninstall.ps1. Run this script from a clone of the repository.'
    }
    if (-not $env:USERPROFILE) { throw 'USERPROFILE is not set.' }

    Write-Step 'Checks'
    $node = Find-Node
    if (-not $node) {
        throw "Node.js $MinNodeMajor or newer not found (PATH, Program Files, volta, nvm-windows): setup.js cannot run."
    }
    $script:NodeExe = $node.Path
    Write-Info "Node.js $($node.Version) : $($node.Path)"

    $detect = Invoke-Setup @('detect')
    $dojo = $detect.install.configDir
    $settingsFile = $detect.settings.path

    Write-Step 'Removing Claude Dojo'
    $options = '{}'
    if ($Purge) { $options = '{"purge":true,"states":true}' }
    $out = Invoke-Setup @('uninstall', '-') -StdinText $options

    Write-Step 'Agent and wallpaper'
    $stopped = @($out.processes.stopped)
    if ($stopped.Count -gt 0) {
        foreach ($item in $stopped) { Write-Info "stopped: $($item.kind) (pid $($item.pid))" }
    } else {
        Write-Info 'none running'
    }
    foreach ($warning in @($out.warnings)) { Write-Warning $warning }

    Write-Step 'Autostart'
    $removed = @($out.launchAgents.removed)
    if ($removed.Count -gt 0) {
        foreach ($name in $removed) { Write-Info "Run value removed: $name" }
    } else {
        Write-Info 'no Run value to remove'
    }
    foreach ($warning in @($out.launchAgents.warnings)) { Write-Warning $warning }

    Write-Step 'DojoWallpaper.exe'
    if ($out.app.existed) {
        foreach ($path in @($out.appRemoved)) { Write-Info "removed: $path" }
        if ($out.appRemaining) {
            Write-Warning "$($out.appRemaining) is in use: close the wallpaper, then run uninstall.ps1 again."
        }
    } else {
        Write-Info "absent: $($out.app.path)"
    }

    Write-Step 'Claude Code settings'
    if ($out.settings.error) {
        Write-Warning "settings.json is unreadable or invalid, left as is: $($out.settings.error)"
    } elseif ($out.settings.changed) {
        Write-Info "Dojo entries removed from $settingsFile"
        if ($out.settings.backup) { Write-Info "backup: $($out.settings.backup)" }
    } else {
        Write-Info 'no Dojo entry: file unchanged, no backup'
    }

    Write-Step 'Configuration'
    if ($Purge) {
        if ($out.config.error) { Write-Warning "not deleted: $dojo" } elseif ($out.config.removed) { Write-Info "deleted: $dojo" } else { Write-Info "absent: $dojo" }
    } elseif (@($out.config.kept).Count -gt 0) {
        foreach ($name in @($out.config.kept)) { Write-Info "kept: $(Join-Path $dojo $name)" }
        Write-Info 'run with -Purge to delete them too'
    } else {
        Write-Info "nothing to keep in $dojo"
    }
    if ($out.states.existed) {
        if ($out.states.removed) { Write-Info "deleted: $($out.states.path)" } else { Write-Info "kept: $($out.states.path)" }
    }

    Write-Step 'Claude Dojo is uninstalled'
    Write-Info 'Claude Code: other hooks, settings and plugins were not touched.'
    Write-Info 'Processes outside the Dojo folder (for example a personal agent) were not touched.'
}

try {
    Invoke-Uninstall
    exit 0
} catch {
    [Console]::Error.WriteLine('Error: ' + $_.Exception.Message)
    exit 1
}
