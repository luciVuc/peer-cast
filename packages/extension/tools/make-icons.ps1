# Generates PeerCast extension icons (rounded gradient square + broadcast mark).
# Usage: powershell -File tools\make-icons.ps1  (run from the repo root)
Add-Type -AssemblyName System.Drawing

function New-PeerCastIcon {
  param(
    [int]$Size,
    [string]$OutPath
  )

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Rounded-rectangle background path.
  $radius = [Math]::Max(2.0, $Size * 0.22)
  $d = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($Size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($Size - $d - 1, $Size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $Size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 99, 102, 241),
    [System.Drawing.Color]::FromArgb(255, 76, 29, 149),
    55.0
  )
  $g.FillPath($brush, $path)

  # Broadcast waves (two arcs left/right of center).
  $penWidth = [Math]::Max(1.0, $Size * 0.055)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penWidth)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  foreach ($f in @(0.30, 0.46)) {
    $r = $Size * $f
    $g.DrawArc($pen, $Size / 2 - $r, $Size / 2 - $r, $r * 2, $r * 2, 212, 116)
    $g.DrawArc($pen, $Size / 2 - $r, $Size / 2 - $r, $r * 2, $r * 2, 32, 116)
  }

  # Center dot.
  $dotR = [Math]::Max(1.5, $Size * 0.13)
  $g.FillEllipse([System.Drawing.Brushes]::White, $Size / 2 - $dotR, $Size / 2 - $dotR, $dotR * 2, $dotR * 2)

  $g.Dispose()
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $OutPath"
}

$root = Split-Path -Parent $PSScriptRoot
New-PeerCastIcon 16  (Join-Path $root 'icons\icon16.png')
New-PeerCastIcon 48  (Join-Path $root 'icons\icon48.png')
New-PeerCastIcon 128 (Join-Path $root 'icons\icon128.png')
