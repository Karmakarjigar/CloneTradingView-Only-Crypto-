# Generates build/icon.ico and build/icon.png without external dependencies.
Add-Type -AssemblyName System.Drawing

$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sizes = 16, 24, 32, 48, 64, 128, 256

function New-RoundPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $s = $size / 256.0

  $bg = New-RoundPath (0 * $s) (0 * $s) (255 * $s) (255 * $s) (52 * $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point(0, $size)),
    [System.Drawing.Color]::FromArgb(255, 23, 29, 42),
    [System.Drawing.Color]::FromArgb(255, 12, 16, 26)
  )
  $g.FillPath($brush, $bg)
  $border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 42, 46, 57), [Math]::Max(1, 3 * $s))
  $g.DrawPath($border, $bg)

  # Accent trend line behind the candles.
  $accent = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 41, 98, 255), [Math]::Max(1.2, 9 * $s))
  $accent.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $accent.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($accent, 34 * $s, 208 * $s, 226 * $s, 44 * $s)

  $up = [System.Drawing.Color]::FromArgb(255, 38, 166, 154)
  $down = [System.Drawing.Color]::FromArgb(255, 239, 83, 80)
  $candles = @(
    @{ x = 58; top = 150; bottom = 202; wickTop = 131; wickBottom = 218; color = $up },
    @{ x = 106; top = 126; bottom = 174; wickTop = 109; wickBottom = 192; color = $down },
    @{ x = 154; top = 94; bottom = 148; wickTop = 78; wickBottom = 166; color = $up },
    @{ x = 202; top = 66; bottom = 120; wickTop = 48; wickBottom = 140; color = $down }
  )

  foreach ($c in $candles) {
    $wick = New-Object System.Drawing.Pen($c.color, [Math]::Max(1, 6 * $s))
    $wick.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $wick.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLine($wick, $c.x * $s, $c.wickTop * $s, $c.x * $s, $c.wickBottom * $s)

    $bodyW = 24 * $s
    $bodyH = ($c.bottom - $c.top) * $s
    $body = New-RoundPath (($c.x * $s) - ($bodyW / 2)) ($c.top * $s) $bodyW $bodyH ([Math]::Max(1, 4 * $s))
    $bodyBrush = New-Object System.Drawing.SolidBrush($c.color)
    $g.FillPath($bodyBrush, $body)
    $bodyBrush.Dispose()
    $body.Dispose()
    $wick.Dispose()
  }

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $g.Dispose()
  $bmp.Dispose()
  $bg.Dispose()
  $brush.Dispose()
  $border.Dispose()
  $accent.Dispose()
  return ,$bytes
}

$pngs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) { $pngs.Add([byte[]](New-IconPng $s)) }
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.png'), $pngs[$sizes.Count - 1])

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $bw.Write([byte]$dim)
  $bw.Write([byte]$dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngs[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($png in $pngs) { $bw.Write([byte[]]$png) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $outDir 'icon.ico'), $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

Write-Host "wrote $outDir\icon.ico ($([System.IO.File]::ReadAllBytes((Join-Path $outDir 'icon.ico')).Length) bytes)"
