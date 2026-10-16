<#
.SYNOPSIS
    Installs Claude Dojo on Windows: agent, Claude Code hooks and statusline, autostart, wallpaper.
.DESCRIPTION
    Windows counterpart of install.sh. This script is a thin wrapper: the logic lives in src/setup.js.
    Run it from a clone of the repository (src/ must sit next to this script). No administrator rights needed.
    Idempotent: running it again updates the installation without duplicating anything. It stops the running agent and
    wallpaper first, replaces DojoWallpaper.exe with the release of this version, then starts them again.
.PARAMETER NoHeavyGate
    Does not register the heavy-gate hook (PreToolUse, matcher Bash|PowerShell).
    Same as DOJO_HEAVY_GATE=n in install.sh.
.PARAMETER NoWizard
    Does not open the setup assistant at the end of a first installation. Same as DOJO_NO_WIZARD=1.
    The assistant is also skipped in CI, in a non-interactive session, with redirected input, and when
    DOJO_SKIP_START or DOJO_SKIP_EXE is set.
.EXAMPLE
    pwsh -File install.ps1
.EXAMPLE
    pwsh -File install.ps1 -NoHeavyGate
.EXAMPLE
    pwsh -File install.ps1 -NoWizard
.NOTES
    Environment variables:
      DOJO_SKIP_REGISTRY=1   do not write the HKCU Run values (the launcher is still written)
      DOJO_SKIP_EXE=1        do not download or build DojoWallpaper.exe
      DOJO_SKIP_START=1      do not start the agent at the end (tests and CI)
      DOJO_NO_WIZARD=1       do not open the setup assistant at the end of a first installation
    USERPROFILE selects the profile, as it does for setup.js.
#>
param(
    [switch]$NoHeavyGate,
    [switch]$NoWizard
)

$ErrorActionPreference = 'Stop'
# Node.js major version required by setup.js.
$MinNodeMajor = 18
# No gh credential probe during the installation (as in install.sh).
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

function ConvertTo-JsonLine([hashtable]$Value) {
    return ($Value | ConvertTo-Json -Compress)
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

# Raison pour laquelle l'assistant de configuration ne s'ouvre pas à la fin de l'installation, ou $null s'il doit
# s'ouvrir. Il ne s'ouvre qu'à la première installation (pas de config.json au départ) dans une session interactive.
function Get-WizardSkip {
    param(
        [bool]$NoWizardSwitch,
        [bool]$FirstInstall
    )
    if ($NoWizardSwitch) { return '-NoWizard' }
    if ($env:DOJO_NO_WIZARD -eq '1') { return 'DOJO_NO_WIZARD=1' }
    if (-not $FirstInstall) { return 'configuration existante' }
    if ($env:CI -or $env:GITHUB_ACTIONS) { return 'CI' }
    if ($env:DOJO_SKIP_START -or $env:DOJO_SKIP_EXE) { return 'DOJO_SKIP_START ou DOJO_SKIP_EXE' }
    if (-not [Environment]::UserInteractive) { return 'session non interactive' }
    try {
        if ([Console]::IsInputRedirected) { return 'entrée redirigée' }
    } catch {
        return 'console indisponible'
    }
    return $null
}

function Invoke-Install {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'this script runs on Windows only (use install.sh on macOS).'
    }
    $script:SetupJs = Join-Path (Join-Path $PSScriptRoot 'src') 'setup.js'
    if (-not (Test-Path -LiteralPath $script:SetupJs -PathType Leaf)) {
        throw 'src\setup.js not found next to install.ps1. Run this script from a clone of the repository.'
    }
    if (-not $env:USERPROFILE) { throw 'USERPROFILE is not set.' }

    Write-Step 'Checks'
    $node = Find-Node
    if (-not $node) {
        throw "Node.js $MinNodeMajor or newer not found (PATH, Program Files, volta, nvm-windows). Install it with: winget install OpenJS.NodeJS.LTS"
    }
    $script:NodeExe = $node.Path
    Write-Info "Node.js $($node.Version) : $($node.Path)"

    $detect = Invoke-Setup @('detect')
    if ($detect.settings.error) {
        throw "$($detect.settings.path) is unreadable or invalid: fix or move it, then run this script again."
    }
    $dojo = $detect.install.configDir
    $settingsFile = $detect.settings.path
    # Mémorisé avant toute écriture : sans config.json, c'est une première installation (assistant de configuration).
    $firstInstall = -not [bool]$detect.install.configExists

    # Before any file is replaced: a running agent or wallpaper keeps the old code and locks DojoWallpaper.exe.
    Write-Step 'Stopping the running agent and wallpaper'
    $stop = Invoke-Setup @('stop-processes')
    foreach ($item in @($stop.stopped)) { Write-Info "stopped: $($item.kind) (pid $($item.pid))" }
    foreach ($warning in @($stop.warnings)) { Write-Warning $warning }
    if (@($stop.remaining).Count -gt 0) {
        $left = (@($stop.remaining) | ForEach-Object { "$($_.kind) (pid $($_.pid))" }) -join ', '
        throw "Claude Dojo is still running: $left. Close it, then run this script again."
    }
    $wallpaperWasRunning = [bool](@($stop.stopped) | Where-Object { $_ -and $_.kind -eq 'wallpaper' })

    Write-Step "Runtime files in $dojo"
    $copy = Invoke-Setup @('install-files', (Join-Path $PSScriptRoot 'src'))
    Write-Info "copied: $(@($copy.copied).Count) entries from src"
    if (@($copy.copied) -contains 'windows/ui/') { Write-Info 'interface copied: windows\ui (without tests)' }
    foreach ($warning in @($copy.warnings)) { Write-Warning $warning }

    Write-Step 'config.json'
    if ([bool]$detect.install.configExists) {
        Write-Info "kept: $(Join-Path $dojo 'config.json') (edit it for weather, calendars or GitHub)"
    } else {
        $cfg = Invoke-Setup @('write-config', '-') -StdinText '{"calendars":[],"github":{"owners":[]},"projects":{"roots":[],"onlyOwners":false}}'
        Write-Info "created: $($cfg.path)"
    }

    Write-Step 'Dependencies (node-ical)'
    $npm = Invoke-Setup @('npm-install', $script:NodeExe)
    Write-Info "npm install done in $($npm.dest)"

    Write-Step 'DojoWallpaper.exe'
    $exe = Invoke-Setup @('ensure-wallpaper-exe')
    if ($exe.installed) {
        Write-Info "ready ($($exe.source)) : $($exe.path)"
    } elseif ($exe.skipped) {
        Write-Info "skipped ($($exe.skipped))"
    }
    if ($exe.message) { Write-Warning $exe.message }

    # Assistant de configuration : première installation, session interactive, exe présent. Son lancement remplace le
    # redémarrage du fond (plus bas) : une seule instance, et c'est la première (--open n'agit qu'au démarrage).
    $wizardSkip = Get-WizardSkip -NoWizardSwitch ([bool]$NoWizard) -FirstInstall $firstInstall
    $openWizard = ($null -eq $wizardSkip) -and [bool]$exe.installed

    Write-Step 'Autostart (Run values and start-agent.vbs)'
    $auto = Invoke-Setup @('launchagents', 'install', '-') -StdinText (ConvertTo-JsonLine @{ node = $script:NodeExe })
    foreach ($file in @($auto.written)) { Write-Info "written: $file" }
    foreach ($name in @($auto.loaded)) { Write-Info "Run value set: $name" }
    foreach ($warning in @($auto.warnings)) { Write-Warning $warning }

    Write-Step 'Claude Code settings (hooks, statusline, heavy-gate)'
    $merge = Invoke-Setup @('merge-settings', '-') -StdinText (ConvertTo-JsonLine @{
        node = $script:NodeExe
        heavyGate = (-not $NoHeavyGate)
        statusLine = 'keep'
    })
    if ($merge.changed -eq $false) {
        Write-Info 'already up to date: no change, no backup'
    } elseif ($null -eq $merge.before) {
        Write-Info "created: $settingsFile"
    } else {
        Write-Info "updated (Dojo entries only): $settingsFile"
    }
    if ($merge.backup) { Write-Info "backup: $($merge.backup)" }
    if ($null -eq $merge.after.statusLine) {
        Write-Info 'statusline: none'
    } elseif ([string]$merge.after.statusLine.command -like '*statusline.js*') {
        Write-Info 'statusline: Dojo'
    } else {
        Write-Info 'statusline: existing one kept'
    }
    if ($NoHeavyGate) {
        Write-Info 'heavy-gate: not registered (-NoHeavyGate)'
    } else {
        Write-Info 'heavy-gate: registered (matcher Bash|PowerShell)'
    }

    Write-Step 'Agent'
    if ($env:DOJO_SKIP_START -eq '1') {
        Write-Info 'not started (DOJO_SKIP_START=1)'
    } else {
        $wscript = 'wscript.exe'
        if ($env:SystemRoot) { $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe' }
        $launcher = Join-Path $dojo 'start-agent.vbs'
        # wscript returns at once: the agent is a child of the launcher. -Wait would also wait for that child.
        $launch = Start-Process -FilePath $wscript -ArgumentList ('//B //Nologo "' + $launcher + '"') -WindowStyle Hidden -PassThru
        $launch.WaitForExit()
        if ($launch.ExitCode -eq 0) {
            Write-Info 'started in the background: http://localhost:7777'
        } else {
            Write-Warning "start-agent.vbs exited with code $($launch.ExitCode): run it by hand from the folder above."
        }
        if ($wallpaperWasRunning -and $exe.installed -and -not $openWizard) {
            try {
                Start-Process -FilePath $exe.path -WorkingDirectory (Split-Path -Parent $exe.path) | Out-Null
                Write-Info 'wallpaper started again (it was running before the update)'
            } catch {
                Write-Warning "wallpaper not started again: $($_.Exception.Message)"
            }
        }
    }

    # Fin de l'installation, première installation seulement : le fond démarre avec l'assistant ouvert.
    if ($null -eq $wizardSkip) {
        Write-Step 'Setup assistant'
        if ($exe.installed) {
            try {
                Start-Process -FilePath $exe.path -ArgumentList '--open', 'wizard' -WorkingDirectory (Split-Path -Parent $exe.path) | Out-Null
                Write-Info 'Assistant de configuration ouvert : choisissez votre thème et votre fond d''écran.'
                Write-Info "Il se rouvre depuis le menu de l'icône Dojo Wallpaper (zone de notification)."
            } catch {
                Write-Warning "Assistant non ouvert : $($_.Exception.Message)"
            }
        } else {
            Write-Warning "Assistant non ouvert : DojoWallpaper.exe est absent (voir le message ci-dessus). Une fois le fond installé, il s'ouvre depuis le menu de l'icône Dojo Wallpaper."
        }
    }

    Write-Step 'Claude Dojo is installed'
    Write-Info "Folder      : $dojo (config.json, runtime, agent, wallpaper exe)"
    Write-Info 'Agent       : http://localhost:7777, starts when you sign in to Windows'
    Write-Info "Claude Code : Dojo hooks in $settingsFile"
    Write-Info 'Uninstall   : pwsh -File uninstall.ps1 (add -Purge to also delete config.json)'
    Write-Info 'The clone can be deleted: the runtime was copied to the folder above.'
}

try {
    Invoke-Install
    exit 0
} catch {
    [Console]::Error.WriteLine('Error: ' + $_.Exception.Message)
    exit 1
}
