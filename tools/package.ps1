<#
  Сборка пакета для Chrome Web Store.

  В магазин уезжает только то, что нужно расширению: манифест, иконки, src.
  Тесты, генератор иконок и документы остаются в репозитории.

  Запуск: powershell -ExecutionPolicy Bypass -File tools/package.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

Write-Host 'Тесты...' -ForegroundColor Cyan
& node tests/run.mjs
if ($LASTEXITCODE -ne 0) { throw 'Тесты не прошли — пакет не собран' }

$manifest = Get-Content 'manifest.json' -Raw | ConvertFrom-Json
$version = $manifest.version
Write-Host "`nПроверка манифеста (версия $version)..." -ForegroundColor Cyan

if ($version -notmatch '^\d+(\.\d+){1,3}$') { throw "Некорректная версия: $version" }

# Всё, на что ссылается манифест, должно существовать.
$referenced = @($manifest.background.service_worker, $manifest.action.default_popup) +
              $manifest.content_scripts.js + $manifest.icons.PSObject.Properties.Value
foreach ($file in $referenced | Select-Object -Unique) {
  if (-not (Test-Path $file)) { throw "Файл из манифеста отсутствует: $file" }
}

# Списки хостов в манифесте обязаны совпадать (за совпадением с hosts.js
# следит самотест, здесь — что оба поля манифеста не разъехались).
$hosts = $manifest.host_permissions | Sort-Object
$matches = $manifest.content_scripts[0].matches | Sort-Object
if (Compare-Object $hosts $matches) { throw 'host_permissions и content_scripts.matches разошлись' }

if ($manifest.permissions -contains 'tabs') {
  Write-Warning 'Разрешение tabs показывает пользователю «читать историю просмотров»'
}

$dist = Join-Path $root 'dist'
$stage = Join-Path $dist "taskmail-$version"
$zip = Join-Path $dist "taskmail-$version.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force $stage | Out-Null

Write-Host 'Сборка пакета...' -ForegroundColor Cyan
Copy-Item 'manifest.json' $stage
Copy-Item 'icons' $stage -Recurse
Copy-Item 'src' $stage -Recurse

# Мусор, который иногда заносит в src.
Get-ChildItem $stage -Recurse -Include '*.map', '*.log', 'Thumbs.db', '.DS_Store' |
  Remove-Item -Force -ErrorAction SilentlyContinue

# Архив собираем поэлементно. Обе штатные функции — Compress-Archive и
# ZipFile.CreateFromDirectory — в Windows PowerShell 5.1 пишут пути с обратными
# слэшами (.NET Framework берёт системный разделитель), а спецификация ZIP и
# Chrome Web Store требуют прямых.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$stream = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in Get-ChildItem $stage -Recurse -File | Sort-Object FullName) {
    $name = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $file.FullName, $name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}

# Проверяем то, на чём спотыкается загрузка в магазин.
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $wrong = @($check.Entries | Where-Object { $_.FullName.Contains('\') })
  if ($wrong.Count) { throw "В архиве пути с обратными слэшами: $($wrong[0].FullName)" }
  if (-not ($check.Entries | Where-Object { $_.FullName -eq 'manifest.json' })) {
    throw 'manifest.json должен лежать в корне архива'
  }
  Write-Host "  записей в архиве: $($check.Entries.Count)"
} finally {
  $check.Dispose()
}

$files = (Get-ChildItem $stage -Recurse -File).Count
$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)

Write-Host "`nГотово" -ForegroundColor Green
Write-Host "  файлов в пакете: $files"
Write-Host "  архив: dist/taskmail-$version.zip ($size КБ)"
Write-Host "  загружать в магазин именно .zip, не папку"
