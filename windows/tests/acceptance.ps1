<#
.SYNOPSIS
    Recette automatisee de DojoWallpaper (lot H) : build, demarrage, clic transmis, pause, nettoyage.

.DESCRIPTION
    Prouve, sur la machine courante, sans jamais toucher a l'agent dojo de la machine (port 7777)
    ni a Lively :
      A. build.ps1 -Test (code 0), puis presence de bin\DojoWallpaper.exe.
      B. Demarrage (critere 1) : une fenetre DojoWallpaper-N par ecran, parent Progman ou WorkerW
         (verifie par Win32), page chargee (journal NavigationCompleted IsSuccess=True et requetes
         /stats relayees), capture d'ecran du bureau.
      C. Clic transmis (critere 2) : clic SendInput sur un point du bureau (racine Progman/WorkerW,
         case vide), /focus recu en mode interactif, absent en mode passif (controle negatif).
         Si l'agent de test expose des sessions (ninjas) et que -NinjaPoint est fourni, meme test
         sur le vrai index.html.
      D. Pause (critere 3) : fenetres plein ecran de test ; journal pause / reprise, CPU et GPU
         actif versus pause, TrySuspendAsync.
      E. Nettoyage : processus, ports, cle HKCU Run, curseur, Lively et agent 7777.

    Serveurs de test : le relais (/stats, /focus) et la page de clic sont ce meme script lance
    avec -Serve, en arriere-plan, sur le port 7879. Le relais bloque /kill, /open et /media.

    Compatible Windows PowerShell 5.1 et PowerShell 7. Aucun secret. Fichiers ecrits :
    bin\dojo-wallpaper.json (retire a la fin), captures et journaux de test dans -OutDir.

.PARAMETER OutDir
    Dossier des captures et journaux de test (defaut : %TEMP%\dojo-acceptance).

.PARAMETER NinjaPoint
    Optionnel "X,Y" (pixels physiques) d'une carte ninja cliquable sur la capture de l'etape B.
    Attention : le clic sur un ninja appelle /focus sur une vraie session (fenetre mise au premier plan).

.EXAMPLE
    pwsh -NoProfile -File windows\tests\acceptance.ps1 -OutDir "$env:TEMP\dojo-recette"
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path ([IO.Path]::GetTempPath()) 'dojo-acceptance'),
    [string]$NinjaPoint = '',
    # Usage interne : serveur de test lance en arriere-plan par ce script.
    [ValidateSet('', 'relay', 'click')]
    [string]$Serve = '',
    [int]$ServePort = 0,
    [string]$ServeUpstream = 'none',
    [string]$ServeLog = '',
    [string]$ServeStop = ''
)

$ErrorActionPreference = 'Stop'

$script:PsExe        = (Get-Process -Id $PID).Path
$script:WinDir       = Split-Path -Parent $PSScriptRoot
$script:DojoDir      = Split-Path -Parent $script:WinDir
$script:BinDir       = Join-Path $script:WinDir 'bin'
$script:ExePath      = Join-Path $script:BinDir 'DojoWallpaper.exe'
$script:ConfigPath   = Join-Path $script:BinDir 'dojo-wallpaper.json'
$script:BuildScript  = Join-Path $script:WinDir 'build.ps1'
$script:AgentScript  = Join-Path $script:DojoDir 'agent.ps1'
$script:LogPath      = Join-Path $env:LOCALAPPDATA 'DojoWallpaper\dojo.log'
$script:AgentPort    = 7878
$script:StubPort     = 7879
$script:Stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Results      = New-Object System.Collections.ArrayList
$script:AppPids      = New-Object System.Collections.ArrayList
$script:StubPids     = New-Object System.Collections.ArrayList
$script:AgentPid     = 0
$script:CoverPid     = 0

# Source C# : Win32 (fenetres, curseur, SendInput, LVM_HITTEST distant sur l'Explorateur).
$script:NativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public struct DPoint { public int X; public int Y; }

[StructLayout(LayoutKind.Sequential)]
public struct DMouseInput
{
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct DInput
{
    public uint type;
    public DMouseInput mi;
}

public static class DojoAcc
{
    public delegate bool EnumProc(IntPtr h, IntPtr lp);

    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out DPoint p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(DPoint p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [StructLayout(LayoutKind.Sequential)] struct DRect { public int L; public int T; public int R; public int B; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out DRect r);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, DInput[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref DPoint p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr addr, IntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr addr, IntPtr size, uint type);
    [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr addr, byte[] buf, IntPtr size, out IntPtr written);

    public static DPoint Cursor() { DPoint p; GetCursorPos(out p); return p; }

    public static string ClassOf(IntPtr h)
    {
        if (h == IntPtr.Zero) return "";
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string TextOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static List<IntPtr> TopWindows()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr lp) { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    // Tous les descendants (EnumChildWindows est recursif).
    public static List<IntPtr> ChildWindows(IntPtr parent)
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr h, IntPtr lp) { list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static int ExStyleOf(IntPtr h) { return GetWindowLongW(h, -20); }

    public static int CloakedOf(IntPtr h)
    {
        int v;
        if (DwmGetWindowAttribute(h, 14, out v, 4) != 0) return -1; // DWMWA_CLOAKED
        return v;
    }

    public static string RectOf(IntPtr h)
    {
        DRect r;
        if (!GetWindowRect(h, out r)) return "";
        return r.L + "," + r.T + "," + r.R + "," + r.B;
    }

    public static IntPtr HitAt(int x, int y)
    {
        DPoint p = new DPoint();
        p.X = x;
        p.Y = y;
        return WindowFromPoint(p);
    }

    public static IntPtr RootOf(IntPtr h) { return GetAncestor(h, 2); }

    public static uint PidOf(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return pid;
    }

    // Index de l'element de ListView sous (sx, sy) en coordonnees ecran : -1 si case vide, -2 si echec.
    // La ListView appartient a l'Explorateur : LVM_HITTEST recoit un pointeur dans sa memoire.
    public static int ListViewItemAt(IntPtr lv, int sx, int sy)
    {
        DPoint c = new DPoint();
        c.X = sx;
        c.Y = sy;
        ScreenToClient(lv, ref c);
        IntPtr hp = OpenProcess(0x0438, false, PidOf(lv)); // VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION
        if (hp == IntPtr.Zero) return -2;
        try
        {
            int size = 24; // LVHITTESTINFO : POINT, flags, iItem, iSubItem, iGroup
            IntPtr mem = VirtualAllocEx(hp, IntPtr.Zero, (IntPtr)size, 0x3000, 0x04);
            if (mem == IntPtr.Zero) return -2;
            try
            {
                byte[] buf = new byte[size];
                BitConverter.GetBytes(c.X).CopyTo(buf, 0);
                BitConverter.GetBytes(c.Y).CopyTo(buf, 4);
                IntPtr written;
                if (!WriteProcessMemory(hp, mem, buf, (IntPtr)size, out written)) return -2;
                return (int)SendMessage(lv, 0x1012, IntPtr.Zero, mem).ToInt64(); // LVM_HITTEST
            }
            finally
            {
                VirtualFreeEx(hp, mem, IntPtr.Zero, 0x8000);
            }
        }
        finally
        {
            CloseHandle(hp);
        }
    }

    // Deplacement absolu par SendInput (evenement materiel simule, comme une vraie souris).
    public static void MoveTo(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        DInput[] a = new DInput[1];
        a[0].type = 0;
        a[0].mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        a[0].mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        a[0].mi.dwFlags = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
        SendInput(1, a, Marshal.SizeOf(typeof(DInput)));
    }

    public static void LeftClick()
    {
        DInput[] down = new DInput[1];
        down[0].type = 0;
        down[0].mi.dwFlags = 0x0002; // LEFTDOWN
        DInput[] up = new DInput[1];
        up[0].type = 0;
        up[0].mi.dwFlags = 0x0004; // LEFTUP
        int size = Marshal.SizeOf(typeof(DInput));
        SendInput(1, down, size);
        Thread.Sleep(80);
        SendInput(1, up, size);
    }
}
'@

# ---------------------------------------------------------------------------
# Utilitaires generaux
# ---------------------------------------------------------------------------

function Write-Step([string]$title) {
    Write-Host ''
    Write-Host ('== ' + $title + ' ==')
}

function Add-Check([string]$id, [bool]$ok, [string]$detail) {
    [void]$script:Results.Add([pscustomobject]@{ Id = $id; Ok = $ok; Detail = $detail })
    $tag = 'FAIL'
    if ($ok) { $tag = 'PASS' }
    Write-Host ('[{0}] {1} : {2}' -f $tag, $id, $detail)
}

function Add-Note([string]$id, [string]$detail) {
    [void]$script:Results.Add([pscustomobject]@{ Id = $id; Ok = $null; Detail = $detail })
    Write-Host ('[NOTE] {0} : {1}' -f $id, $detail)
}

# Lance un executable natif sans que les lignes stderr ne deviennent des erreurs bloquantes.
function Invoke-Native([string]$exe, [string[]]$argList) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & $exe @argList 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prev
    }
    return [pscustomobject]@{ Code = $code; Text = ($lines -join "`n") }
}

function Get-Http([string]$url, [int]$timeoutMs = 5000) {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Timeout = $timeoutMs
    $req.KeepAlive = $false
    $req.Proxy = $null
    $req.Method = 'GET'
    $resp = $null
    try {
        $resp = $req.GetResponse()
    }
    catch [System.Net.WebException] {
        if ($_.Exception.Response) { $resp = $_.Exception.Response }
    }
    if ($null -eq $resp) { return [pscustomobject]@{ Code = 0; Body = '' } }
    try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $sr.ReadToEnd()
        return [pscustomobject]@{ Code = [int]$resp.StatusCode; Body = $body }
    }
    finally {
        $resp.Close()
    }
}

function Wait-Http([string]$url, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-Http $url 2000).Code -eq 200) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-FileLength([string]$file) {
    if (Test-Path -LiteralPath $file) { return [long](Get-Item -LiteralPath $file).Length }
    return [long]0
}

# Lignes du fichier a partir d'un decalage en octets (fichier partage en lecture/ecriture).
function Read-TextFrom([string]$file, [long]$offset) {
    if (-not (Test-Path -LiteralPath $file)) { return @() }
    $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($offset -gt $fs.Length) { $offset = 0 }
        [void]$fs.Seek($offset, [System.IO.SeekOrigin]::Begin)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        return @($text -split "`r?`n" | Where-Object { $_ -ne '' })
    }
    finally {
        $fs.Dispose()
    }
}

function Count-Lines([string]$pattern, [string]$file, [long]$offset) {
    return @(Read-TextFrom $file $offset | Where-Object { $_ -match $pattern }).Count
}

# Attend qu'au moins $need lignes correspondent (ou le delai). Retourne le nombre trouve.
function Wait-Count([string]$pattern, [string]$file, [long]$offset, [int]$need, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $n = 0
    do {
        $n = Count-Lines $pattern $file $offset
        if ($n -ge $need) { break }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    return $n
}

function Get-DescendantPids([int]$rootPid) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)
    $ids = New-Object System.Collections.ArrayList
    [void]$ids.Add([int]$rootPid)
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue([int]$rootPid)
    while ($queue.Count -gt 0) {
        $parent = [int]$queue.Dequeue()
        foreach ($c in $all) {
            $cid = [int]$c.ProcessId
            if ([int]$c.ParentProcessId -eq $parent -and -not $ids.Contains($cid)) {
                [void]$ids.Add($cid)
                $queue.Enqueue($cid)
            }
        }
    }
    return @($ids | ForEach-Object { [int]$_ })
}

function Stop-Pids([int[]]$pids) {
    foreach ($id in $pids) {
        if ($id -le 0) { continue }
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
}

function New-DPoint([int]$x, [int]$y) {
    $p = New-Object DPoint
    $p.X = $x
    $p.Y = $y
    return $p
}

# ---------------------------------------------------------------------------
# Configuration de l'application (bin\dojo-wallpaper.json, retire a la fin)
# ---------------------------------------------------------------------------

function Write-DojoConfig([string]$mode, [string]$url) {
    $cfg = [ordered]@{
        Url = $url
        Mode = $mode
        Mirror = $true
        Zoom = 0
        DisabledScreens = @()
        Pause = [ordered]@{
            OnFullscreen = $true
            OnMaximized = $true
            OnBattery = $true
            OnBatterySaver = $true
            ForegroundApps = @()
            IgnoreApps = @('DojoWallpaper', 'SearchHost', 'ShellExperienceHost', 'StartMenuExperienceHost')
        }
    }
    $json = ConvertTo-Json -InputObject $cfg -Depth 6
    [System.IO.File]::WriteAllText($script:ConfigPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------------------
# Processus de test : agent dojo (7878), relais / page de clic (7879), application, cache de pause
# ---------------------------------------------------------------------------

function Start-TestAgent {
    $oldPort = $env:DOJO_PORT
    $oldNoMutex = $env:DOJO_NOMUTEX
    $env:DOJO_PORT = [string]$script:AgentPort
    $env:DOJO_NOMUTEX = '1'
    try {
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"' + $script:AgentScript + '"'))
        $p = Start-Process -FilePath $script:PsExe -ArgumentList $argList -PassThru -WindowStyle Hidden
    }
    finally {
        if ($null -eq $oldPort) { Remove-Item Env:DOJO_PORT -ErrorAction SilentlyContinue } else { $env:DOJO_PORT = $oldPort }
        if ($null -eq $oldNoMutex) { Remove-Item Env:DOJO_NOMUTEX -ErrorAction SilentlyContinue } else { $env:DOJO_NOMUTEX = $oldNoMutex }
    }
    $script:AgentPid = $p.Id
    return $p
}

function Start-StubServer([string]$role, [int]$port, [string]$upstream, [string]$logFile, [string]$stopFile) {
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force }
    if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force }
    $argList = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', ('"' + $PSCommandPath + '"'),
        '-Serve', $role,
        '-ServePort', [string]$port,
        '-ServeUpstream', $upstream,
        '-ServeLog', ('"' + $logFile + '"'),
        '-ServeStop', ('"' + $stopFile + '"')
    )
    $p = Start-Process -FilePath $script:PsExe -ArgumentList $argList -PassThru -WindowStyle Hidden
    [void]$script:StubPids.Add($p.Id)
    return $p
}

function Wait-StubReady([string]$logFile) {
    return (Wait-Count 'READY' $logFile 0 1 25) -ge 1
}

function Stop-StubServer($proc, [string]$stopFile) {
    if ($null -eq $proc) { return }
    try { Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII } catch {}
    for ($i = 0; $i -lt 10; $i++) {
        if ($proc.HasExited) { return }
        Start-Sleep -Milliseconds 300
    }
    Stop-Pids @($proc.Id)
}

# Lance l'application (DOJO_URL herite pour ce seul lancement).
function Start-DojoApp([string]$url) {
    if (Get-Process -Name 'DojoWallpaper' -ErrorAction SilentlyContinue) {
        throw 'une instance DojoWallpaper tourne deja (test arrete, rien n''a ete touche)'
    }
    $old = $env:DOJO_URL
    $env:DOJO_URL = $url
    try {
        $p = Start-Process -FilePath $script:ExePath -WorkingDirectory $script:BinDir -PassThru -WindowStyle Hidden
    }
    finally {
        if ($null -eq $old) { Remove-Item Env:DOJO_URL -ErrorAction SilentlyContinue } else { $env:DOJO_URL = $old }
    }
    [void]$script:AppPids.Add($p.Id)
    return $p
}

# Arrete l'application et tous ses descendants (WebView2) : ce sont nos processus, traces au lancement.
function Stop-DojoApp($proc) {
    if ($null -eq $proc) { return }
    $ids = Get-DescendantPids $proc.Id
    Stop-Pids $ids
    Start-Sleep -Milliseconds 800
}

# Fenetres plein ecran de test (un formulaire par ecran), dans un processus jetable.
function Start-Cover {
    # Le moteur de pause ignore le plein ecran si le processus au premier plan figure dans IgnoreApps
# (DojoWallpaper y est par defaut) : la couverture doit donc etre au premier plan. Un appui ALT
# emis par ce processus lui permet de prendre le premier plan (SetForegroundWindow seul est refuse).
$src = @'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DojoCoverDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra); }'
[void][DojoCoverDpi]::SetProcessDPIAware()
$ctx = New-Object System.Windows.Forms.ApplicationContext
$first = $true
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'
    $f.StartPosition = 'Manual'
    $f.Bounds = $s.Bounds
    $f.TopMost = $true
    $f.ShowInTaskbar = $false
    $f.BackColor = [System.Drawing.Color]::Black
    $f.Text = 'DojoAcceptanceCover'
    $f.Show()
    if ($first) { $ctx.MainForm = $f; $first = $false }
}
[DojoCoverDpi]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[DojoCoverDpi]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][DojoCoverDpi]::SetForegroundWindow($ctx.MainForm.Handle)
$ctx.MainForm.Activate()
[System.Windows.Forms.Application]::Run($ctx)
'@
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($src))
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', $enc)
    $p = Start-Process -FilePath $script:PsExe -ArgumentList $argList -PassThru -WindowStyle Hidden
    $script:CoverPid = $p.Id
    return $p
}

# ---------------------------------------------------------------------------
# Fenetres du bureau, captures, mesures
# ---------------------------------------------------------------------------

function Get-DojoWindows {
    $found = New-Object System.Collections.ArrayList
    foreach ($top in [DojoAcc]::TopWindows()) {
        $cls = [DojoAcc]::ClassOf($top)
        if ($cls -ne 'Progman' -and $cls -ne 'WorkerW') { continue }
        foreach ($h in [DojoAcc]::ChildWindows($top)) {
            $title = [DojoAcc]::TextOf($h)
            if ($title -like 'DojoWallpaper-*') {
                $parent = [DojoAcc]::GetParent($h)
                [void]$found.Add([pscustomobject]@{
                    Title = $title
                    Parent = [DojoAcc]::ClassOf($parent)
                    Visible = [DojoAcc]::IsWindowVisible($h)
                })
            }
        }
    }
    return @($found)
}

function Save-Screen($bounds, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
        }
        finally {
            $g.Dispose()
        }
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bmp.Dispose()
    }
}

# Luminance moyenne et nombre de couleurs sur une grille : detecte un ecran noir ou uniforme.
function Get-ImageStats([string]$path) {
    $bmp = [System.Drawing.Bitmap]::FromFile($path)
    try {
        $sum = 0.0
        $n = 0
        $colors = @{}
        $sx = [Math]::Max(1, [int]($bmp.Width / 48))
        $sy = [Math]::Max(1, [int]($bmp.Height / 32))
        for ($y = 0; $y -lt $bmp.Height; $y += $sy) {
            for ($x = 0; $x -lt $bmp.Width; $x += $sx) {
                $c = $bmp.GetPixel($x, $y)
                $sum += 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
                $n++
                $colors[$c.ToArgb()] = $true
            }
        }
        return [pscustomobject]@{ Mean = $sum / $n; Colors = $colors.Count }
    }
    finally {
        $bmp.Dispose()
    }
}

# Premier point du bureau principal : racine Progman/WorkerW, aucune autre application au-dessus,
# et, si c'est une ListView de l'Explorateur, case vide (pas une icone).
function Find-DesktopPoint {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    for ($y = [int]($b.Height * 0.45); $y -lt ($b.Height - 120); $y += 40) {
        for ($x = [int]($b.Width * 0.5); $x -lt ($b.Width - 40); $x += 40) {
            $hit = [DojoAcc]::HitAt($x, $y)
            if ($hit.ToInt64() -eq 0) { continue }
            $root = [DojoAcc]::ClassOf([DojoAcc]::RootOf($hit))
            if ($root -ne 'Progman' -and $root -ne 'WorkerW') { continue }
            $cls = [DojoAcc]::ClassOf($hit)
            if ($cls -eq 'SysListView32') {
                if ([DojoAcc]::ListViewItemAt($hit, $x, $y) -ne -1) { continue }
            }
            elseif ($cls -ne 'WorkerW' -and $cls -ne 'Progman') {
                continue
            }
            return [pscustomobject]@{ X = $x; Y = $y; Class = $cls; Root = $root }
        }
    }
    return $null
}

# Clic souris materiel simule sur le bureau : deplacement SendInput, verification de la position,
# puis clic gauche. Aucun clic n'est emis si le curseur n'a pas atteint la cible (sinon le clic
# tomberait au hasard sur le bureau). Retourne $true si le clic a ete emis.
function Invoke-DesktopClick([int]$x, [int]$y) {
    [DojoAcc]::MoveTo($x, $y)
    Start-Sleep -Milliseconds 400
    $p = [DojoAcc]::Cursor()
    if ($p.X -ne $x -or $p.Y -ne $y) { return $false }
    [DojoAcc]::LeftClick()
    return $true
}

function Get-CpuMap([int[]]$pids) {
    $map = @{}
    foreach ($p in @(Get-Process -Id $pids -ErrorAction SilentlyContinue)) {
        $map[[int]$p.Id] = $p.TotalProcessorTime.TotalSeconds
    }
    return $map
}

# Somme des pourcentages GPU Engine des processus de la liste (compteur Windows), moyenne des echantillons.
# Deux tentatives : une instance GPU peut disparaitre entre le listage et l'echantillonnage.
function Get-GpuPercent([int[]]$pids, [int]$seconds) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $value = Get-GpuPercentOnce $pids $seconds
        if ($null -ne $value) { return $value }
    }
    return $null
}

function Get-GpuPercentOnce([int[]]$pids, [int]$seconds) {
    $paths = New-Object System.Collections.ArrayList
    foreach ($inst in @((Get-Counter -ListSet 'GPU Engine' -ErrorAction SilentlyContinue).PathsWithInstances)) {
        # Seul le pourcentage d'utilisation : les compteurs "running time" sont cumulatifs (non bornes).
        if ($inst -match 'pid_(\d+)_' -and $inst -match 'utilization percentage$') {
            if ($pids -contains [int]$matches[1]) { [void]$paths.Add($inst) }
        }
    }
    if ($paths.Count -eq 0) { return $null }
    $set = Get-Counter -Counter @($paths) -SampleInterval 1 -MaxSamples ($seconds + 1) -ErrorAction SilentlyContinue
    if ($null -eq $set) { return $null }
    # Chaque moteur est borne a 0..100 (pourcentage) ; le total par echantillon est une somme ; on garde la
    # mediane des echantillons (hors premier, qui n'a pas de base de calcul) pour ne pas subir un pic isole.
    $sums = New-Object System.Collections.ArrayList
    foreach ($s in @($set)) {
        $sum = 0.0
        foreach ($cs in $s.CounterSamples) {
            $v = [double]$cs.CookedValue
            $sum += [Math]::Min(100.0, [Math]::Max(0.0, $v))
        }
        [void]$sums.Add($sum)
    }
    $vals = @($sums | Select-Object -Skip 1 | Sort-Object)
    if ($vals.Count -eq 0) { return $null }
    $mid = [int][Math]::Floor(($vals.Count - 1) / 2)
    if ($vals.Count % 2 -eq 1) { return [Math]::Round([double]$vals[$mid], 2) }
    return [Math]::Round((([double]$vals[$mid] + [double]$vals[$mid + 1]) / 2), 2)
}

# Rectangle (ecran) de la fenetre de couverture de test, ou chaine vide si absente.
function Get-CoverRect {
    foreach ($top in [DojoAcc]::TopWindows()) {
        if ([DojoAcc]::TextOf($top) -eq 'DojoAcceptanceCover') { return [DojoAcc]::RectOf($top) }
    }
    return ''
}

# Diagnostic de la couverture telle que le moteur de pause la voit (style etendu, cloak DWM, premier plan).
function Get-CoverDiag {
    foreach ($top in [DojoAcc]::TopWindows()) {
        if ([DojoAcc]::TextOf($top) -eq 'DojoAcceptanceCover') {
            $fg = [DojoAcc]::Foreground()
            return ("rect={0} exstyle=0x{1:X} cloaked={2} classe={3} foreground={4}" -f [DojoAcc]::RectOf($top), [DojoAcc]::ExStyleOf($top), [DojoAcc]::CloakedOf($top), [DojoAcc]::ClassOf($top), ([DojoAcc]::ClassOf($fg) + '/' + [DojoAcc]::TextOf($fg)))
        }
    }
    return 'absente'
}

# Charge moyenne sur $seconds : CPU en % de la machine (tous coeurs) et GPU (somme des moteurs).
function Measure-Load([int]$rootPid, [int]$seconds) {
    $pids = Get-DescendantPids $rootPid
    $before = Get-CpuMap $pids
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $gpu = Get-GpuPercent $pids $seconds
    $sw.Stop()
    $after = Get-CpuMap $pids
    $delta = 0.0
    foreach ($k in $before.Keys) {
        if ($after.ContainsKey($k)) { $delta += ($after[$k] - $before[$k]) }
    }
    $cores = [Environment]::ProcessorCount
    $cpu = 100.0 * $delta / ([Math]::Max(0.001, $sw.Elapsed.TotalSeconds) * $cores)
    return [pscustomobject]@{
        Cpu = [Math]::Round($cpu, 2)
        Gpu = $gpu
        Procs = $pids.Count
        Seconds = [Math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
}

function Get-ProcessSnapshot {
    $lively = @(Get-Process -Name 'Lively' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id } | Sort-Object)
    return [pscustomobject]@{ LivelyIds = ($lively -join ',') }
}

function Get-RunSnapshot {
    $props = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    $h = @{}
    if ($props) {
        foreach ($prop in $props.PSObject.Properties) {
            if ($prop.Name -notlike 'PS*') { $h[$prop.Name] = [string]$prop.Value }
        }
    }
    return (@($h.Keys | Sort-Object | ForEach-Object { "$_=" + $h[$_] }) -join "`n")
}

# ---------------------------------------------------------------------------
# Phases
# ---------------------------------------------------------------------------

function Test-PhaseA {
    Write-Step 'A. Build (build.ps1 -Test)'
    $r = Invoke-Native $script:PsExe @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:BuildScript, '-Test')
    Add-Check 'A1' ($r.Code -eq 0) ("build.ps1 -Test : code {0}" -f $r.Code)
    $m = [regex]::Match($r.Text, '(\d+) test\(s\), (\d+) echec')
    $tests = 0
    $fails = -1
    if ($m.Success) { $tests = [int]$m.Groups[1].Value; $fails = [int]$m.Groups[2].Value }
    Add-Check 'A2' ($m.Success -and $tests -gt 0 -and $fails -eq 0) ("tests unitaires : {0} execute(s), {1} echec(s)" -f $tests, $fails)
    $exists = Test-Path -LiteralPath $script:ExePath
    Add-Check 'A3' $exists ("binaire : $script:ExePath")
    $files = @(Get-ChildItem -LiteralPath $script:BinDir -Recurse -File -ErrorAction SilentlyContinue)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    Add-Check 'A4' ($bytes -lt 5MB) ("taille de bin\ : {0:N2} Mo ({1} fichiers, limite 5 Mo)" -f ($bytes / 1MB), $files.Count)
}

function Test-PhaseB {
    Write-Step 'B. Demarrage (critere 1)'
    [void](Start-TestAgent)
    $agentOk = Wait-Http ("http://localhost:{0}/stats" -f $script:AgentPort) 90
    Add-Check 'B0' $agentOk ("agent de test sur {0} sert /stats" -f $script:AgentPort)
    if (-not $agentOk) { throw 'agent de test indisponible' }

    $relayLog = Join-Path $OutDir ("relay-{0}.log" -f $script:Stamp)
    $relayStop = Join-Path $OutDir ("relay-{0}.stop" -f $script:Stamp)
    $script:RelayProc = Start-StubServer 'relay' $script:StubPort ("http://localhost:{0}" -f $script:AgentPort) $relayLog $relayStop
    $script:RelayLog = $relayLog
    $script:RelayStop = $relayStop
    if (-not (Wait-StubReady $relayLog)) { throw 'relais de test non pret' }

    Write-DojoConfig 'interactive' ("http://localhost:{0}/" -f $script:StubPort)
    $off = Get-FileLength $script:LogPath
    $script:AppProc = Start-DojoApp ("http://localhost:{0}/" -f $script:StubPort)

    $screens = [System.Windows.Forms.Screen]::AllScreens
    $need = $screens.Count
    $nav = Wait-Count 'DojoWallpaper-\d+ NavigationCompleted IsSuccess=True' $script:LogPath $off $need 60
    $wins = @(Get-DojoWindows)
    $titles = @($wins | ForEach-Object { $_.Title } | Sort-Object)
    $expected = @(0..($need - 1) | ForEach-Object { "DojoWallpaper-$_" })
    $titlesOk = (($titles -join ',') -eq ($expected -join ','))
    Add-Check 'B1' $titlesOk ("fenetres : {0} (attendu : {1} ecran(s))" -f ($titles -join ', '), $need)

    $okParents = @($wins | Where-Object { $_.Parent -eq 'Progman' -or $_.Parent -eq 'WorkerW' }).Count
    $parentList = (@($wins | ForEach-Object { $_.Title + '->' + $_.Parent }) -join ', ')
    Add-Check 'B2' ($wins.Count -gt 0 -and $okParents -eq $wins.Count) ("parent Win32 (GetParent) : {0}" -f $parentList)

    Add-Check 'B3' ($nav -ge $need) ("journal NavigationCompleted IsSuccess=True : {0} / {1}" -f $nav, $need)

    $stats = Wait-Count 'GET /stats 200$' $script:RelayLog 0 1 30
    $page = Count-Lines 'GET / 200$' $script:RelayLog 0
    Add-Check 'B4' ($page -ge 1 -and $stats -ge 1) ("requetes de la WebView relayees a l'agent de test : GET / 200 = {0}, GET /stats 200 = {1}" -f $page, $stats)

    Start-Sleep -Seconds 6
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $shot = Join-Path $OutDir ("acceptance-B-{0}.png" -f $script:Stamp)
    Save-Screen $bounds $shot
    $st = Get-ImageStats $shot
    Add-Check 'B5' ($st.Mean -gt 8 -and $st.Colors -gt 20) ("capture {0} : luminance moyenne {1:N1}, couleurs distinctes {2}" -f $shot, $st.Mean, $st.Colors)

    Test-PhaseD $script:AppProc.Id $need
}

function Test-PhaseD([int]$appPid, [int]$screenCount) {
    Write-Step 'D. Pause (critere 3)'
    Start-Sleep -Seconds 6
    $treeNow = @(Get-DescendantPids $appPid)
    $wv = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $treeNow -contains [int]$_.ProcessId }).Count
    Add-Note 'D0' ("processus de l'application : {0} dont {1} msedgewebview2" -f $treeNow.Count, $wv)

    $active = Measure-Load $appPid 8

    $off = Get-FileLength $script:LogPath
    $cover = Start-Cover
    $coverRect = ''
    for ($i = 0; $i -lt 40 -and $coverRect -eq ''; $i++) {
        Start-Sleep -Milliseconds 250
        $coverRect = Get-CoverRect
    }
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Add-Note 'D0b' ("fenetre plein ecran de test (rect {0}) sur ecran {1},{2},{3},{4}" -f $coverRect, $scr.Left, $scr.Top, $scr.Right, $scr.Bottom)
    $fgOk = $false
    for ($i = 0; $i -lt 25 -and -not $fgOk; $i++) {
        Start-Sleep -Milliseconds 200
        $fgOk = ([DojoAcc]::TextOf([DojoAcc]::Foreground()) -eq 'DojoAcceptanceCover')
    }
    Add-Note 'D0d' ("couverture au premier plan : {0}" -f $fgOk)
    $pauseN = Wait-Count 'DojoWallpaper-\d+ pause$' $script:LogPath $off $screenCount 25
    if ($pauseN -lt $screenCount) {
        $resp = (Get-Process -Id $appPid -ErrorAction SilentlyContinue).Responding
        Add-Note 'D0c' ("pause non journalisee : couverture {0} ; application Responding={1}" -f (Get-CoverDiag), $resp)
    }
    Start-Sleep -Seconds 4
    $susp = Count-Lines 'TrySuspendAsync -> True' $script:LogPath $off
    $paused = Measure-Load $appPid 8

    Stop-Pids @($cover.Id)
    $script:CoverPid = 0
    $resN = Wait-Count 'DojoWallpaper-\d+ reprise$' $script:LogPath $off $screenCount 25
    Stop-DojoApp $script:AppProc
    $script:AppProc = $null

    Add-Check 'D1' ($pauseN -ge $screenCount -and $resN -ge $screenCount) ("journal : pause = {0}, reprise = {1} (ecrans : {2})" -f $pauseN, $resN, $screenCount)
    Add-Check 'D2' ($susp -ge 1) ("TrySuspendAsync -> True : {0} occurrence(s)" -f $susp)

    $cpuRatio = 'n/a'
    if ($active.Cpu -gt 0) { $cpuRatio = [Math]::Round($paused.Cpu / $active.Cpu, 3) }
    $cpuOk = ($paused.Cpu -le 1.0) -or ($active.Cpu -gt 0 -and $paused.Cpu -le 0.1 * $active.Cpu)
    Add-Check 'D3' $cpuOk ("CPU actif {0} % / pause {1} % (machine, {2} coeurs), ratio {3}" -f $active.Cpu, $paused.Cpu, [Environment]::ProcessorCount, $cpuRatio)

    if ($null -eq $active.Gpu -or $null -eq $paused.Gpu) {
        Add-Note 'D4' ("compteur GPU Engine indisponible (actif={0}, pause={1}) : controle GPU non realise, CPU et TrySuspendAsync seuls" -f $active.Gpu, $paused.Gpu)
    }
    else {
        $gpuOk = ($paused.Gpu -le 1.0) -or ($paused.Gpu -le 0.1 * $active.Gpu)
        Add-Check 'D4' $gpuOk ("GPU Engine (somme des moteurs) actif {0} / pause {1}" -f $active.Gpu, $paused.Gpu)
    }
}

function Test-PhaseC {
    Write-Step 'C. Clic transmis (critere 2)'
    # Le relais de la phase B est arrete : meme port pour la page de clic.
    Stop-StubServer $script:RelayProc $script:RelayStop
    $script:RelayProc = $null

    $point = Find-DesktopPoint
    if ($null -eq $point) {
        Add-Check 'C0' $false 'aucun point du bureau (racine Progman/WorkerW, case vide) trouve'
        return
    }
    Add-Check 'C0' $true ("point de clic {0},{1} : racine {2}, fenetre sous le point {3}" -f $point.X, $point.Y, $point.Root, $point.Class)

    $clickLog = Join-Path $OutDir ("click-{0}.log" -f $script:Stamp)
    $clickStop = Join-Path $OutDir ("click-{0}.stop" -f $script:Stamp)
    $click = Start-StubServer 'click' $script:StubPort 'none' $clickLog $clickStop
    if (-not (Wait-StubReady $clickLog)) { throw 'page de clic non prete' }

    # Mode interactif : le clic doit parvenir a la page.
    Write-DojoConfig 'interactive' ("http://localhost:{0}/" -f $script:StubPort)
    $off = Get-FileLength $script:LogPath
    $offClick = Get-FileLength $clickLog
    $script:AppProc = Start-DojoApp ("http://localhost:{0}/" -f $script:StubPort)
    [void](Wait-Count 'DojoWallpaper-\d+ NavigationCompleted IsSuccess=True' $script:LogPath $off 1 60)
    $loaded = Wait-Count 'GET / 200$' $clickLog $offClick 1 30
    Start-Sleep -Seconds 3
    $before = Get-FileLength $clickLog
    $sent = Invoke-DesktopClick $point.X $point.Y
    Start-Sleep -Seconds 2
    $focus = Count-Lines 'GET /focus\?id=test 200$' $clickLog $before
    Add-Check 'C1' ($sent -and $focus -ge 1) ("interactif : page chargee ({0}), clic emis sur {1},{2} : {3}, /focus recu apres clic : {4}" -f ($loaded -ge 1), $point.X, $point.Y, $sent, $focus)
    Stop-DojoApp $script:AppProc

    # Controle negatif : meme page, mode passif, meme clic : aucun /focus.
    Write-DojoConfig 'passive' ("http://localhost:{0}/" -f $script:StubPort)
    $off2 = Get-FileLength $script:LogPath
    $offClick2 = Get-FileLength $clickLog
    $script:AppProc = Start-DojoApp ("http://localhost:{0}/" -f $script:StubPort)
    [void](Wait-Count 'DojoWallpaper-\d+ NavigationCompleted IsSuccess=True' $script:LogPath $off2 1 60)
    $loaded2 = Wait-Count 'GET / 200$' $clickLog $offClick2 1 30
    Start-Sleep -Seconds 3
    $before2 = Get-FileLength $clickLog
    $sent2 = Invoke-DesktopClick $point.X $point.Y
    Start-Sleep -Seconds 2
    $focusP = Count-Lines 'GET /focus\?id=test 200$' $clickLog $before2
    # Controle valide seulement si le clic a bien ete emis (sinon 0 /focus ne prouverait rien).
    Add-Check 'C2' ($sent2 -and $loaded2 -ge 1 -and $focusP -eq 0) ("passif (controle negatif) : page chargee ({0}), clic emis : {1}, /focus apres clic : {2}" -f ($loaded2 -ge 1), $sent2, $focusP)
    Stop-DojoApp $script:AppProc
    $script:AppProc = $null

    Stop-StubServer $click $clickStop

    Test-NinjaClick
}

# Test sur le vrai index.html : seulement si l'agent de test expose des sessions (ninjas) et -NinjaPoint.
function Test-NinjaClick {
    $sessions = 0
    $stats = Get-Http ("http://localhost:{0}/stats" -f $script:AgentPort)
    if ($stats.Code -eq 200) {
        try { $sessions = @((ConvertFrom-Json $stats.Body).sessions).Count } catch { $sessions = 0 }
    }
    if ($sessions -eq 0) {
        Add-Note 'C3' 'aucun ninja cliquable (sessions = 0 dans /stats) : test sur index.html non execute'
        return
    }
    if ($NinjaPoint -notmatch '^\s*(\d+)\s*,\s*(\d+)\s*$') {
        Add-Note 'C3' ("{0} session(s) exposee(s) mais -NinjaPoint absent : test sur index.html non execute (position de la carte a relever sur la capture B)" -f $sessions)
        return
    }
    $nx = [int]$matches[1]
    $ny = [int]$matches[2]

    $relayLog = Join-Path $OutDir ("relay-ninja-{0}.log" -f $script:Stamp)
    $relayStop = Join-Path $OutDir ("relay-ninja-{0}.stop" -f $script:Stamp)
    $relay = Start-StubServer 'relay' $script:StubPort ("http://localhost:{0}" -f $script:AgentPort) $relayLog $relayStop
    if (-not (Wait-StubReady $relayLog)) { throw 'relais (ninja) non pret' }
    Write-DojoConfig 'interactive' ("http://localhost:{0}/" -f $script:StubPort)
    $off = Get-FileLength $script:LogPath
    $script:AppProc = Start-DojoApp ("http://localhost:{0}/" -f $script:StubPort)
    [void](Wait-Count 'DojoWallpaper-\d+ NavigationCompleted IsSuccess=True' $script:LogPath $off 1 60)
    [void](Wait-Count 'GET /stats 200$' $relayLog 0 1 30)
    Start-Sleep -Seconds 6
    $before = Get-FileLength $relayLog
    $sentN = Invoke-DesktopClick $nx $ny
    Start-Sleep -Seconds 3
    $focus = Count-Lines 'GET /focus\?id=[^ ]+ 200$' $relayLog $before
    Add-Check 'C3' ($sentN -and $focus -ge 1) ("index.html : clic ninja {0},{1} ({2} session(s)) emis : {3}, /focus relaye a l'agent : {4}" -f $nx, $ny, $sessions, $sentN, $focus)
    Stop-DojoApp $script:AppProc
    $script:AppProc = $null
    Stop-StubServer $relay $relayStop
}

# ---------------------------------------------------------------------------
# Nettoyage et verification finale (E)
# ---------------------------------------------------------------------------

function Invoke-Cleanup($savedCursor) {
    foreach ($id in @($script:AppPids)) { Stop-Pids (Get-DescendantPids $id) }
    if ($script:AgentPid -gt 0) {
        $agentTree = Get-DescendantPids $script:AgentPid
        Stop-Pids $agentTree
    }
    foreach ($id in @($script:StubPids)) { Stop-Pids @([int]$id) }
    if ($script:CoverPid -gt 0) { Stop-Pids @($script:CoverPid) }
    if (Test-Path -LiteralPath $script:ConfigPath) { Remove-Item -LiteralPath $script:ConfigPath -Force }
    if ($null -ne $savedCursor) { [void][DojoAcc]::SetCursorPos($savedCursor.X, $savedCursor.Y) }
}

function Test-Final($initial, $savedCursor) {
    Write-Step 'E. Nettoyage et etat final'
    Start-Sleep -Seconds 2

    $leftApp = @(Get-Process -Name 'DojoWallpaper' -ErrorAction SilentlyContinue).Count
    $leftWv = 0
    foreach ($id in @($script:AppPids)) {
        $leftWv += @(Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue).Count
    }
    $leftAgent = 0
    if ($script:AgentPid -gt 0) { $leftAgent = @(Get-Process -Id $script:AgentPid -ErrorAction SilentlyContinue).Count }
    $leftStub = 0
    foreach ($id in @($script:StubPids)) { $leftStub += @(Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue).Count }
    Add-Check 'E1' ($leftApp -eq 0 -and $leftWv -eq 0 -and $leftAgent -eq 0 -and $leftStub -eq 0) ("processus restants : DojoWallpaper={0}, app traquee={1}, agent de test={2}, relais/page={3}" -f $leftApp, $leftWv, $leftAgent, $leftStub)

    $listening = @(Get-NetTCPConnection -State Listen -LocalPort $script:AgentPort, $script:StubPort -ErrorAction SilentlyContinue).Count
    Add-Check 'E2' ($listening -eq 0) ("ports {0} et {1} libres : {2} ecoute(s) restante(s)" -f $script:AgentPort, $script:StubPort, $listening)

    $runNow = Get-RunSnapshot
    Add-Check 'E3' ($runNow -eq $initial.Run) 'cle HKCU Run identique avant et apres le test'

    $cur = [DojoAcc]::Cursor()
    Add-Check 'E4' ($cur.X -eq $savedCursor.X -and $cur.Y -eq $savedCursor.Y) ("curseur restaure : {0},{1} (initial {2},{3})" -f $cur.X, $cur.Y, $savedCursor.X, $savedCursor.Y)

    $now = Get-ProcessSnapshot
    Add-Check 'E5' ($now.LivelyIds -eq $initial.Lively.LivelyIds -and $initial.Lively.LivelyIds -ne '') ("Lively : PID initiaux [{0}], maintenant [{1}]" -f $initial.Lively.LivelyIds, $now.LivelyIds)

    $agent = Get-Http 'http://localhost:7777/stats' 5000
    Add-Check 'E6' ($agent.Code -eq 200 -and $initial.Agent7777 -eq 200) ("agent de la machine (7777) : HTTP {0} (initial {1})" -f $agent.Code, $initial.Agent7777)

    Add-Check 'E7' (-not (Test-Path -LiteralPath $script:ConfigPath)) 'bin\dojo-wallpaper.json de test retire'
}

function Get-InitialState {
    $cur = [DojoAcc]::Cursor()
    $agent = Get-Http 'http://localhost:7777/stats' 5000
    return [pscustomobject]@{
        Cursor = $cur
        Run = Get-RunSnapshot
        Lively = Get-ProcessSnapshot
        Agent7777 = $agent.Code
    }
}

function Invoke-Acceptance {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    if (-not ('DojoAcc' -as [type])) { Add-Type -TypeDefinition $script:NativeSource -Language CSharp }
    [void][DojoAcc]::SetProcessDPIAware()
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    if (Get-Process -Name 'DojoWallpaper' -ErrorAction SilentlyContinue) {
        throw 'une instance DojoWallpaper tourne deja : test arrete avant toute modification'
    }
    $initial = Get-InitialState
    $savedCursor = New-DPoint $initial.Cursor.X $initial.Cursor.Y
    Write-Host ("Etat initial : curseur {0},{1}, Lively [{2}], agent 7777 HTTP {3}" -f $savedCursor.X, $savedCursor.Y, $initial.Lively.LivelyIds, $initial.Agent7777)

    try {
        Test-PhaseA
        Test-PhaseB
        Test-PhaseC
    }
    catch {
        Add-Check 'ERR' $false ("exception : " + $_.Exception.Message)
    }
    finally {
        Invoke-Cleanup $savedCursor
    }
    Test-Final $initial $savedCursor

    Write-Step 'Resume'
    $checks = @($script:Results | Where-Object { $null -ne $_.Ok })
    $pass = @($checks | Where-Object { $_.Ok }).Count
    $fail = @($checks | Where-Object { -not $_.Ok }).Count
    Write-Host ("{0} verification(s) PASS, {1} FAIL, {2} note(s)" -f $pass, $fail, (@($script:Results | Where-Object { $null -eq $_.Ok }).Count))
    if ($fail -eq 0 -and $pass -gt 0) { exit 0 }
    exit 1
}

# ---------------------------------------------------------------------------
# Point d'entree
# ---------------------------------------------------------------------------

function Invoke-TestServer {
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $clickPage = @'
<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recette clic</title>
<style>html,body{margin:0;height:100%;background:#0b3d91}
#b{position:fixed;inset:0;width:100%;height:100%;border:0;background:#ffd400;color:#000;font:700 48px sans-serif;cursor:pointer}</style>
</head><body><button id="b" type="button">CLIC TEST</button>
<script>
document.getElementById('b').addEventListener('click', function () {
  fetch('/focus?id=test').catch(function () {});
});
</script></body></html>
'@

    function Write-ServeLog([string]$line) {
        $stamp = (Get-Date).ToString('HH:mm:ss.fff')
        [System.IO.File]::AppendAllText($ServeLog, ("{0} {1}`r`n" -f $stamp, $line), $utf8)
    }
    function Send-ServeBytes($ctx, [int]$code, [byte[]]$bytes, [string]$type) {
        $res = $ctx.Response
        $res.StatusCode = $code
        if (-not $type) { $type = 'application/octet-stream' }
        $res.ContentType = $type
        $res.ContentLength64 = $bytes.Length
        if ($bytes.Length -gt 0) { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
        $res.OutputStream.Close()
    }
    function Invoke-ServeRequest($ctx) {
        $method = $ctx.Request.HttpMethod
        $pq = $ctx.Request.Url.PathAndQuery
        $path = $ctx.Request.Url.AbsolutePath
        if ($method -eq 'OPTIONS') {
            Send-ServeBytes $ctx 204 (New-Object byte[] 0) 'text/plain'
            return
        }
        if ($Serve -eq 'click') {
            if ($path -eq '/') {
                $code = 200; $bytes = $utf8.GetBytes($clickPage); $type = 'text/html; charset=utf-8'
            }
            elseif ($path -eq '/focus') {
                $code = 200; $bytes = $utf8.GetBytes('{"result":"ok"}'); $type = 'application/json'
            }
            else {
                $code = 404; $bytes = $utf8.GetBytes('{}'); $type = 'application/json'
            }
            Write-ServeLog ("{0} {1} {2}" -f $method, $pq, $code)
            Send-ServeBytes $ctx $code $bytes $type
            return
        }
        # Relais : transmet a l'agent de test, bloque les actions qui ont des effets de bord.
        if ($path -eq '/kill' -or $path -eq '/open' -or $path -eq '/media') {
            Write-ServeLog ("{0} {1} 403 (bloque par le relais de test)" -f $method, $pq)
            Send-ServeBytes $ctx 403 $utf8.GetBytes('{}') 'application/json'
            return
        }
        $req = [System.Net.HttpWebRequest]::Create($ServeUpstream.TrimEnd('/') + $pq)
        $req.Method = 'GET'
        $req.Timeout = 15000
        $req.KeepAlive = $false
        $req.Proxy = $null
        $resp = $null
        try {
            $resp = [System.Net.HttpWebResponse]$req.GetResponse()
        }
        catch [System.Net.WebException] {
            if ($_.Exception.Response) { $resp = [System.Net.HttpWebResponse]$_.Exception.Response }
        }
        if ($null -eq $resp) {
            Write-ServeLog ("{0} {1} 502" -f $method, $pq)
            Send-ServeBytes $ctx 502 $utf8.GetBytes('{}') 'application/json'
            return
        }
        $ms = New-Object System.IO.MemoryStream
        $in = $resp.GetResponseStream()
        $in.CopyTo($ms)
        $in.Close()
        $code = [int]$resp.StatusCode
        $type = $resp.ContentType
        $resp.Close()
        Write-ServeLog ("{0} {1} {2}" -f $method, $pq, $code)
        Send-ServeBytes $ctx $code $ms.ToArray() $type
    }

    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add(("http://localhost:{0}/" -f $ServePort))
    $listener.Start()
    Write-ServeLog ("READY {0} port {1}" -f $Serve, $ServePort)
    $task = $listener.GetContextAsync()
    while ($listener.IsListening -and -not (Test-Path -LiteralPath $ServeStop)) {
        if (-not $task.Wait(250)) { continue }
        $ctx = $task.Result
        $task = $listener.GetContextAsync()
        try {
            Invoke-ServeRequest $ctx
        }
        catch {
            Write-ServeLog ("erreur : " + $_.Exception.Message)
            try { $ctx.Response.Abort() } catch {}
        }
    }
    Write-ServeLog 'STOP'
    $listener.Stop()
    $listener.Close()
}

if ($Serve -ne '') {
    Invoke-TestServer
    exit 0
}

Invoke-Acceptance
