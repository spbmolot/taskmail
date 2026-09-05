<#
  Генератор иконок TaskMail.

  Иконка = конверт с галочкой на фоне акцентного цвета интерфейса (#4f46e5).
  На 16 и 24 пикселях конверт превращается в кашу, поэтому там остаётся только
  галочка: в панели браузера важна узнаваемость силуэта, а не детали.

  Запуск: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
#>

Add-Type -AssemblyName System.Drawing

$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'icons'
New-Item -ItemType Directory -Force $out | Out-Null

$accent = [System.Drawing.Color]::FromArgb(79, 70, 229)   # --accent из theme.css
$paper  = [System.Drawing.Color]::White
$check  = [System.Drawing.Color]::FromArgb(52, 211, 153)  # мятный: виден и на белом, и на индиго

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Подложка: скруглённый квадрат акцентного цвета.
  $bg = New-Object System.Drawing.SolidBrush $accent
  $plate = New-RoundedPath 0 0 ([single]$size) ([single]$size) ([single]($size * 0.24))
  $g.FillPath($bg, $plate)

  $detailed = $size -ge 32

  if ($detailed) {
    # Конверт: белый прямоугольник и линии сгиба цветом подложки.
    $ex = [single]($size * 0.16); $ey = [single]($size * 0.24)
    $ew = [single]($size * 0.62); $eh = [single]($size * 0.42)
    $paperBrush = New-Object System.Drawing.SolidBrush $paper
    $envelope = New-RoundedPath $ex $ey $ew $eh ([single]($size * 0.06))
    $g.FillPath($paperBrush, $envelope)

    $fold = New-Object System.Drawing.Pen $accent, ([single]($size * 0.075))
    $fold.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $fold.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $fold.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($fold, [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($ex + $size * 0.04, $ey + $size * 0.05),
      [System.Drawing.PointF]::new($ex + $ew / 2, $ey + $eh * 0.55),
      [System.Drawing.PointF]::new($ex + $ew - $size * 0.04, $ey + $size * 0.05)
    ))
    $fold.Dispose()
    $paperBrush.Dispose()
  }

  # Галочка. На крупных размерах она вынесена в кружок-значок в углу: если
  # вести её через весь конверт, она спорит с линией сгиба и читается как
  # вторая галочка. На мелких — сама иконка и есть галочка.
  if ($detailed) {
    $cx = [single]($size * 0.74); $cy = [single]($size * 0.74); $r = [single]($size * 0.26)

    # Кольцо цветом подложки отделяет значок от белой бумаги конверта.
    $ring = New-Object System.Drawing.SolidBrush $accent
    $g.FillEllipse($ring, $cx - $r - $size * 0.05, $cy - $r - $size * 0.05,
                   ($r + $size * 0.05) * 2, ($r + $size * 0.05) * 2)
    $ring.Dispose()

    $badge = New-Object System.Drawing.SolidBrush $check
    $g.FillEllipse($badge, $cx - $r, $cy - $r, $r * 2, $r * 2)
    $badge.Dispose()

    $tick = New-Object System.Drawing.Pen $paper, ([single]($size * 0.09))
    $tick.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $tick.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $tick.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($tick, [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new($cx - $r * 0.45, $cy + $r * 0.05),
      [System.Drawing.PointF]::new($cx - $r * 0.10, $cy + $r * 0.42),
      [System.Drawing.PointF]::new($cx + $r * 0.50, $cy - $r * 0.40)
    ))
    $tick.Dispose()
  } else {
    $pen = New-Object System.Drawing.Pen $paper, ([single]($size * 0.13))
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($pen, [System.Drawing.PointF[]]@(
      [System.Drawing.PointF]::new([single]($size * 0.26), [single]($size * 0.52)),
      [System.Drawing.PointF]::new([single]($size * 0.44), [single]($size * 0.70)),
      [System.Drawing.PointF]::new([single]($size * 0.76), [single]($size * 0.30))
    ))
    $pen.Dispose()
  }

  $g.Dispose()
  $bmp.Save((Join-Path $out "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "  icon$size.png"
}
