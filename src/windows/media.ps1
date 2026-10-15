# Lecture en cours (Spotify, navigateur…) via les contrôles média de Windows.
# Tourne sous Windows PowerShell 5.1 (accès WinRT) : écrit media.json + cover.jpg dans le dossier d'état,
# et exécute la commande déposée par l'agent dans media-cmd.txt (toggle, next, prev).
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File media.ps1 [-StateDir <dossier>]
# Dossier par défaut : %LOCALAPPDATA%\claude-dojo. Se termine seul quand le processus parent (l'agent) disparaît.
param([string]$StateDir = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'claude-dojo'))
$ErrorActionPreference = 'SilentlyContinue'

# Une seule instance par dossier d'état (distincte de l'instance d'une autre installation).
$stateKey = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($StateDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($false, "Local\ClaudeDojoMedia-$stateKey")
if (-not $mutex.WaitOne(0)) { exit }

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
if (-not $asTask) { exit }   # WinRT indisponible : on s'arrête, l'agent reçoit null
function Await($op, [Type]$type) {
    $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if ($t.Wait(3000)) { $t.Result } else { $null }
}

$out = Join-Path $StateDir 'media.json'
$cmdFile = Join-Path $StateDir 'media-cmd.txt'
$coverFile = Join-Path $StateDir 'cover.jpg'
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
if (-not $mgr) { exit }
$lastKey = ''; $coverId = 0
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

function Pick-Session {
    # priorité à ce qui joue ; sinon la session « courante » de Windows
    $all = @($mgr.GetSessions())
    $playing = $all | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if ($playing) { $playing } else { $mgr.GetCurrentSession() }
}

function Save-Cover($thumb) {
    $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if (-not $stream) { return $false }
    # PS 5.1 : le flux revient en __ComObject sans .Size ; conversion en Stream .NET par réflexion
    # (l'extension AsStreamForRead n'est pas résolue directement en PS 5.1).
    $net = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream])).Invoke($null, @($stream))
    $ms = New-Object IO.MemoryStream
    try { $net.CopyTo($ms) } finally { $net.Dispose() }
    if ($ms.Length -eq 0 -or $ms.Length -gt 8MB) { return $false }
    [IO.File]::WriteAllBytes($coverFile, $ms.ToArray())
    $true
}

$tick = 0
while ($true) {
    # commande de l'agent (clic sur le lecteur de la page)
    if (Test-Path $cmdFile) {
        $cmd = (Get-Content $cmdFile -Raw).Trim(); Remove-Item $cmdFile -Force
        $s = Pick-Session
        if ($s) {
            switch ($cmd) {
                'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
                'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
                'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
            }
        }
        $tick = 0   # réécriture immédiate de media.json : l'agent lit le nouvel état
    }
    if ($tick -le 0) {
        $tick = 4
        $s = Pick-Session
        $o = @{ active = $false; updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        if ($s) {
            $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $pb = $s.GetPlaybackInfo(); $tl = $s.GetTimelineProperties()
            if ($p -and $p.Title) {
                $key = "$($s.SourceAppUserModelId)|$($p.Title)|$($p.Artist)"
                # nouveau morceau, ou pochette effacée entre-temps → on la réécrit
                if ($key -ne $lastKey -or ($coverId -and -not (Test-Path $coverFile))) {
                    $lastKey = $key
                    if ($p.Thumbnail -and (Save-Cover $p.Thumbnail)) { $coverId++ } else { Remove-Item $coverFile -Force -ErrorAction SilentlyContinue; $coverId = 0 }
                }
                $app = $s.SourceAppUserModelId -replace '\.exe$', '' -replace '^.*[!\\]', ''
                $o = @{
                    active = $true; app = $app; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle
                    status = [string]$pb.PlaybackStatus
                    position = $tl.Position.TotalSeconds; duration = ($tl.EndTime - $tl.StartTime).TotalSeconds
                    positionAt = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
                    cover = if ($coverId) { $coverId } else { 0 }
                    canNext = $pb.Controls.IsNextEnabled; canPrev = $pb.Controls.IsPreviousEnabled
                    updated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                }
            }
        }
        $json = $o | ConvertTo-Json -Compress
        [IO.File]::WriteAllText("$out.tmp", $json, [Text.UTF8Encoding]::new($false))
        Move-Item "$out.tmp" $out -Force
        # l'agent a disparu → on s'arrête aussi
        if ($parent -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
    }
    Start-Sleep -Milliseconds 250
    $tick--
}
