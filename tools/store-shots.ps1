# powershell -NoProfile -File tools/store-shots.ps1 <input-dir> [<out-dir>]
#
# The Chrome Web Store wants screenshots at EXACTLY 1280x800 (or 640x400) and
# 24-bit with no alpha channel. A normal screen capture is neither: it is
# whatever size the window was, saved as 32-bit ARGB. That combination gets you
# "image size is incorrect" with no hint about which of the two rules you broke.
#
# This letterboxes each image onto a 1280x800 canvas in the extension's own
# background colour, so the padding reads as part of the screenshot, and writes
# it back out as 24bpp with the alpha dropped. Nothing is stretched.

param(
  [Parameter(Mandatory=$true)][string]$InputDir,
  [string]$OutDir = "$InputDir/store"
)

Add-Type -AssemblyName System.Drawing

# PowerShell variable names are CASE-INSENSITIVE: $W and $w are the same
# variable. Naming the canvas $W and the scaled width $w silently overwrote the
# canvas size and produced correctly-formatted images of the wrong dimensions.
$CanvasW = 1280
$CanvasH = 800
$MARGIN = 0.94          # leave a little breathing room at the edges
$MAX_UPSCALE = 2.2      # past this a small capture just looks soft
$BG = [System.Drawing.Color]::FromArgb(0x0f, 0x11, 0x15)   # --bg in the UI

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$n = 0

# -Include only filters when the path itself has a wildcard. Without the /* this
# silently matches nothing and reports "no images found" on a full folder.
Get-ChildItem -Path (Join-Path $InputDir '*') -File -Include *.png,*.jpg,*.jpeg | ForEach-Object {
  $src = [System.Drawing.Image]::FromFile($_.FullName)

  $scale = [Math]::Min(($CanvasW * $MARGIN) / $src.Width, ($CanvasH * $MARGIN) / $src.Height)
  $scale = [Math]::Min($scale, $MAX_UPSCALE)
  $drawW = [int]($src.Width * $scale)
  $drawH = [int]($src.Height * $scale)

  # 24bpp: no alpha channel at all, which is what the form is checking for
  $out = New-Object System.Drawing.Bitmap($CanvasW, $CanvasH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.Clear($BG)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src, [int](($CanvasW - $drawW) / 2), [int](($CanvasH - $drawH) / 2), $drawW, $drawH)
  $g.Dispose()

  $n++
  $dest = Join-Path $OutDir ("shot-{0}.png" -f $n)
  $out.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  "{0,-40} -> {1}x{2}  {3}  (scaled {4:P0})" -f $_.Name, $out.Width, $out.Height, $out.PixelFormat, $scale

  $out.Dispose(); $src.Dispose()
}

if ($n -eq 0) { "no images found in $InputDir" } else { "`n$n file(s) in $OutDir" }
