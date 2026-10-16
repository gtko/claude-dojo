# claude-dojo : accueil des sessions PowerShell (Windows Terminal). Equivalent de welcome.zsh, sans fastfetch :
# logo ANSI du theme (theme\logo.txt), puis le titre et deux lignes tirees au hasard (theme\lists.txt).
# Appele par le bloc (marqueurs claude-dojo) du profil PowerShell (setup.js terminal apply), en session interactive.
# DOJO_WELCOME=off : rien. Fichier en ASCII seul (Windows PowerShell 5.1 lit un .ps1 sans BOM en ANSI) : les
# caracteres U+2726 et U+00B7 sont produits par code. Tout est dans un try : une erreur n'empeche jamais l'ouverture du shell.
$ErrorActionPreference = 'Stop'
try {
  if ($env:DOJO_WELCOME -eq 'off') { return }
  $esc = [char]27
  $star = [char]0x2726
  $dot = [char]0x00B7
  $dir = Join-Path $PSScriptRoot 'theme'

  # lists.txt : lignes cle|valeur. l1 et l2 se repetent (un item par ligne) ; le reste sont des reglages.
  $kv = @{}
  $l1 = @()
  $l2 = @()
  $lists = Join-Path $dir 'lists.txt'
  if (Test-Path -LiteralPath $lists) {
    foreach ($raw in [IO.File]::ReadAllLines($lists, [Text.Encoding]::UTF8)) {
      $line = $raw -replace '[\x00-\x1f]', ''
      $i = $line.IndexOf('|')
      if ($i -lt 1) { continue }
      $key = $line.Substring(0, $i)
      $val = $line.Substring($i + 1)
      if ($key -eq 'l1') { $l1 += $val } elseif ($key -eq 'l2') { $l2 += $val } else { $kv[$key] = $val }
    }
  }
  function Get-DojoRgb([string]$value, [string]$fallback) {
    if ($value -match '^(\d{1,3});(\d{1,3});(\d{1,3})$' -and [int]$Matches[1] -le 255 -and [int]$Matches[2] -le 255 -and [int]$Matches[3] -le 255) {
      return $value
    }
    return $fallback
  }
  $acc = Get-DojoRgb $kv['accent'] '242;140;40'
  $txt = Get-DojoRgb $kv['value'] '248;248;242'

  # Titre : nom du theme lu dans config.json (affichage seulement, valeur validee).
  $theme = ''
  try {
    $cfg = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$cfg.theme -match '^[a-z0-9-]{1,64}$') { $theme = [string]$cfg.theme }
  } catch { $theme = '' }

  # Un item de l1 et un de l2 au hasard, avec leur libelle (aligne sur la plus longue cle).
  $items = @()
  if ($l1.Count -gt 0) { $items += [pscustomobject]@{ Label = [string]$kv['key1']; Value = [string](Get-Random -InputObject $l1) } }
  if ($l2.Count -gt 0) { $items += [pscustomobject]@{ Label = [string]$kv['key2']; Value = [string](Get-Random -InputObject $l2) } }
  $width = 0
  foreach ($it in $items) { if ($it.Label.Length -gt $width) { $width = $it.Label.Length } }

  $nacc = "${esc}[38;2;${acc}m"
  $ntxt = "${esc}[38;2;${txt}m"
  $nz = "${esc}[0m"
  $title = "${nacc}${esc}[1m${star} claude-dojo"
  if ($theme -ne '') { $title += " ${dot} $theme" }
  $title += $nz

  $lines = @()
  $logo = Join-Path $dir 'logo.txt'
  if (Test-Path -LiteralPath $logo) {
    $lines += [IO.File]::ReadAllText($logo, [Text.Encoding]::UTF8).TrimEnd([char]13, [char]10) -split '\r?\n'
  }
  $lines += ''
  $lines += $title
  foreach ($it in $items) {
    $lines += "${nacc}${star} " + $it.Label.PadRight($width) + "${nz} ${ntxt}" + $it.Value + $nz
  }

  # Sortie en UTF-8 (sans BOM) le temps du rendu, puis encodage de la console restaure.
  $prevEnc = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    [Console]::Out.Write((($lines -join "`r`n") + "`r`n"))
  } finally {
    [Console]::OutputEncoding = $prevEnc
  }
} catch {
  # Silencieux : l'accueil ne doit jamais bloquer le shell.
}
