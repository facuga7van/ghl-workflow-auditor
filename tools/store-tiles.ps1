# powershell -NoProfile -File tools/store-tiles.ps1 [<out-dir>]
#
# The two promotional tiles the Chrome Web Store asks for:
#   small tile    440x280
#   marquee tile 1400x560
# Both 24-bit with no alpha, same as the screenshots.
#
# Needs tools/mark512.png, which `node tools/make-icons.js` writes.

param([string]$OutDir = "local/store")

Add-Type -AssemblyName System.Drawing

$BG    = [System.Drawing.Color]::FromArgb(0x0f, 0x11, 0x15)
$TXT   = [System.Drawing.Color]::FromArgb(0xe6, 0xe8, 0xec)
$DIM   = [System.Drawing.Color]::FromArgb(0x8b, 0x93, 0xa1)
$ACC   = [System.Drawing.Color]::FromArgb(0x5b, 0x9d, 0xff)
$RED   = [System.Drawing.Color]::FromArgb(0xf8, 0x51, 0x49)
$LINE  = [System.Drawing.Color]::FromArgb(0x25, 0x2a, 0x34)

$markPath = Join-Path $PSScriptRoot 'mark512.png'
if (-not (Test-Path $markPath)) { throw "missing $markPath - run: node tools/make-icons.js" }
$mark = [System.Drawing.Image]::FromFile($markPath)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-Tile([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($BG)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  @{ bmp = $bmp; g = $g }
}

function Save-Tile($tile, [string]$name) {
  $tile.g.Dispose()
  $dest = Join-Path $OutDir $name
  $tile.bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  "{0,-22} {1}x{2}  {3}" -f $name, $tile.bmp.Width, $tile.bmp.Height, $tile.bmp.PixelFormat
  $tile.bmp.Dispose()
}

$fontName = 'Segoe UI'
function F([single]$size, [string]$style = 'Regular') {
  New-Object System.Drawing.Font($fontName, $size, [System.Drawing.FontStyle]::$style, [System.Drawing.GraphicsUnit]::Pixel)
}
function Brush($c) { New-Object System.Drawing.SolidBrush($c) }

# ---------------------------------------------------------------- small 440x280
# Mark on top, name under it, one line of what it does. At this size anything
# more becomes unreadable.
$t = New-Tile 440 280
$t.g.DrawImage($mark, 170, 42, 100, 100)

$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center

$t.g.DrawString('GHL Workflow Auditor', (F 27 'Bold'), (Brush $TXT), 220, 162, $sf)
$t.g.DrawString('Find what fails silently', (F 16), (Brush $DIM), 220, 200, $sf)

# a thin accent rule, to stop it reading as a plain text slide
$pen = New-Object System.Drawing.Pen($LINE, 1)
$t.g.DrawLine($pen, 150, 240, 290, 240)
Save-Tile $t 'promo-small-440x280.png'

# -------------------------------------------------------------- marquee 1400x560
# Mark and wordmark on the left, three real findings on the right: the point is
# that it reports things no error message ever tells you about.
$t = New-Tile 1400 560
$t.g.DrawImage($mark, 96, 120, 190, 190)

$t.g.DrawString('GHL Workflow Auditor', (F 62 'Bold'), (Brush $TXT), 320, 126)
$t.g.DrawString('Reads every workflow in a GoHighLevel sub-account', (F 27), (Brush $DIM), 324, 212)
$t.g.DrawString('and tells you where it is silently broken.', (F 27), (Brush $DIM), 324, 250)

$pen = New-Object System.Drawing.Pen($LINE, 2)
$t.g.DrawLine($pen, 324, 320, 1304, 320)

# three findings, laid out the way the report lays them out
$rows = @(
  @{ sev = 'HIGH';   rule = 'loops back on itself';    what = 'contacts go round forever, sending every message' },
  @{ sev = 'HIGH';   rule = 'assigns to nobody';       what = 'the lead stays unowned and no one is told' },
  @{ sev = 'MEDIUM'; rule = 'merge field with no gate'; what = 'an empty one goes out as-is, mid-sentence' }
)
$y = 362
foreach ($r in $rows) {
  $c = if ($r.sev -eq 'HIGH') { $RED } else { [System.Drawing.Color]::FromArgb(0xd2, 0x99, 0x22) }
  $t.g.DrawString($r.sev,  (F 17 'Bold'), (Brush $c),   324, $y)
  $t.g.DrawString($r.rule, (F 19 'Bold'), (Brush $TXT), 420, $y - 2)
  $t.g.DrawString($r.what, (F 19),        (Brush $DIM), 760, $y - 2)
  $y += 46
}
Save-Tile $t 'promo-marquee-1400x560.png'

$mark.Dispose()
"`ntiles in $OutDir"
