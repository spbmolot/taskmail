<#
  Снимки экрана для карточки Chrome Web Store: 1280×800, как требует магазин.

  Интерфейс берётся настоящий — те же файлы из src, что уезжают в пакет.
  Подменяются только данные (tools/screenshots/mock.js), чтобы на снимке были
  осмысленные задачи, а не пустой список.

  Запуск: powershell -ExecutionPolicy Bypass -File tools/screenshots/make.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $root

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { throw 'Chrome не найден — снимки делает его безоконный режим' }

$build = Join-Path $root 'dist\shots-build'
$out = Join-Path $root 'dist\screenshots'
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $build, $out | Out-Null

# Светлая копия интерфейса.
Copy-Item 'src' (Join-Path $build 'src') -Recurse
Copy-Item 'tools\screenshots\shot.html' $build
Copy-Item 'tools\screenshots\promo.html' $build
Copy-Item 'tools\screenshots\mock.js' (Join-Path $build 'src\mock.js')

# Тёмная копия: медиазапрос превращается в обычные правила, поэтому палитра
# берётся ровно та же, что увидит пользователь с тёмной темой системы.
Copy-Item (Join-Path $build 'src') (Join-Path $build 'dark\src') -Recurse
$themePath = Join-Path $build 'dark\src\common\theme.css'
$theme = Get-Content $themePath -Raw
$theme = $theme -replace '@media \(prefers-color-scheme: dark\) \{\s*\r?\n\s*:root \{', ':root {'
# После замены остаётся лишняя закрывающая скобка медиаблока — убираем первую
# после блока переменных.
$theme = $theme -replace '(?s)(--shadow: 0 6px 20px rgba\(0, 0, 0, 0\.45\);\s*\r?\n\s*\}\s*\r?\n)\s*\}', '$1'
Set-Content $themePath $theme -NoNewline

# Мок подключается перед основным скриптом страницы.
foreach ($page in @('popup\popup.html', 'editor\editor.html')) {
  foreach ($variant in @('src', 'dark\src')) {
    $file = Join-Path $build "$variant\$page"
    $html = Get-Content $file -Raw
    $html = $html -replace '(<script type="module")', '<script src="../mock.js"></script>$1'
    Set-Content $file $html -NoNewline
  }
}

$server = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-Command',
  "Set-Location '$build'; python -m http.server 8940"
)
Start-Sleep -Seconds 2

function Get-Query([hashtable]$parts) {
  ($parts.GetEnumerator() | ForEach-Object {
    "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))"
  }) -join '&'
}

$shots = @(
  @{ file = '1-list.png'; query = @{
      page = 'popup'; height = 600
      title = 'Письмо превращается в задачу'
      lead = 'Срок, приоритет и напоминание — не выходя из почты.'
      points = 'Просроченные, сегодня, предстоящие|Поиск по теме и отправителю|Цветные метки приоритета'
  } }
  @{ file = '2-editor.png'; query = @{
      page = 'editor'; height = 660
      title = 'Задача за три клика'
      lead = 'Тема, отправитель и ссылка на письмо подставляются сами.'
      points = 'Сегодня, завтра, через неделю|Комментарий и приоритет|Ссылка открывается в нужном ящике'
  } }
  @{ file = '3-settings.png'; query = @{
      page = 'popup'; height = 470; action = 'settingsButton'
      title = 'Настройки под ваш ритм'
      lead = 'Время напоминания, интервал переноса, синхронизация между устройствами.'
      points = 'Текст письма не сохраняется без разрешения|Работает офлайн|Никаких сетевых запросов'
  } }
  @{ file = '4-dark.png'; query = @{
      page = 'popup'; height = 600; dark = 1
      title = 'Светлая и тёмная темы'
      lead = 'Интерфейс следует теме системы — ничего настраивать не нужно.'
      points = 'Спокойный список без лишнего|Действия под рукой|Уведомление в назначенное время'
  } }
)

try {
  foreach ($shot in $shots) {
    $url = "http://localhost:8940/shot.html?" + (Get-Query $shot.query)
    $target = Join-Path $out $shot.file
    # Chrome пишет «N bytes written» в поток ошибок, а при ErrorActionPreference
    # = Stop это роняет скрипт. Поэтому запускаем процессом с перенаправлением.
    $log = Join-Path $env:TEMP 'taskmail-shot.log'
    Start-Process $chrome -NoNewWindow -Wait -RedirectStandardError $log -ArgumentList @(
      '--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--virtual-time-budget=3000', '--window-size=1280,800',
      "--screenshot=$target", $url
    )

    if (-not (Test-Path $target)) { throw "Снимок не создан: $($shot.file)" }
    Add-Type -AssemblyName System.Drawing
    $image = New-Object System.Drawing.Bitmap $target
    $size = "$($image.Width)x$($image.Height)"
    $image.Dispose()
    if ($size -ne '1280x800') { throw "$($shot.file): размер $size вместо 1280x800" }
    Write-Host "  $($shot.file)  $size"
  }

# Рекламные изображения. Магазин требует JPEG или 24-битный PNG без альфа-канала,
# а Chrome снимает с прозрачностью, поэтому каждый кадр пересохраняется.
$promos = @(
  @{ file = 'promo-440x280.png'; size = 'small'; width = 440; height = 280 },
  @{ file = 'promo-1400x560.png'; size = 'wide'; width = 1400; height = 560 }
)

Add-Type -AssemblyName System.Drawing

foreach ($promo in $promos) {
  $target = Join-Path $out $promo.file
  $log = Join-Path $env:TEMP 'taskmail-promo.log'
  Start-Process $chrome -NoNewWindow -Wait -RedirectStandardError $log -ArgumentList @(
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--virtual-time-budget=3000', "--window-size=$($promo.width),$($promo.height)",
    "--screenshot=$target", "http://localhost:8940/promo.html?size=$($promo.size)"
  )

  if (-not (Test-Path $target)) { throw "Изображение не создано: $($promo.file)" }

  # Перерисовываем на непрозрачный холст: 32bppArgb -> 24bppRgb.
  $source = New-Object System.Drawing.Bitmap $target
  $flat = New-Object System.Drawing.Bitmap $source.Width, $source.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $canvas = [System.Drawing.Graphics]::FromImage($flat)
  $canvas.Clear([System.Drawing.Color]::White)
  $canvas.DrawImage($source, 0, 0, $source.Width, $source.Height)
  $canvas.Dispose()
  $source.Dispose()

  $flatPath = Join-Path $out ("flat-" + $promo.file)
  $flat.Save($flatPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $size = "$($flat.Width)x$($flat.Height)"
  $format = $flat.PixelFormat
  $flat.Dispose()

  Move-Item $flatPath $target -Force

  # Белый левый верхний угол означает, что снялась не наша страница,
  # а, например, экран "не удаётся получить доступ к сайту".
  $probe = New-Object System.Drawing.Bitmap $target
  $corner = $probe.GetPixel(8, 8)
  $probe.Dispose()
  if ($corner.R -gt 200 -and $corner.G -gt 200 -and $corner.B -gt 200) {
    throw "$($promo.file): фон белый — снялась не страница промо"
  }

  if ($size -ne "$($promo.width)x$($promo.height)") { throw "$($promo.file): размер $size" }
  if ("$format" -ne 'Format24bppRgb') { throw "$($promo.file): формат $format, нужен 24-битный без альфы" }
  Write-Host "  $($promo.file)  $size  $format"
}
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
    Where-Object { $_.CommandLine -like '*http.server 8940*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}


Write-Host "`nГотово: dist/screenshots" -ForegroundColor Green
