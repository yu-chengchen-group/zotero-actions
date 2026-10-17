param(
    [string]$Output = "zotero-actions-student.zip"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputPath = if ([IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $root $Output }
$staging = Join-Path ([IO.Path]::GetTempPath()) ("zotero-actions-student-" + [guid]::NewGuid().ToString("N"))

$rootFiles = @(
    "README.md",
    "install.cmd",
    "update.cmd",
    "doctor.cmd",
    "uninstall.cmd",
    "installer.ps1",
    "maintenance.ps1"
)
$scriptFiles = @(
    "sync-attachments.js",
    "document2md.js"
)

New-Item -ItemType Directory -Path $staging | Out-Null
New-Item -ItemType Directory -Path (Join-Path $staging "scripts") | Out-Null
try {
    foreach ($name in $rootFiles) {
        $source = Join-Path $root $name
        if (-not (Test-Path $source)) { throw "Required student package file is missing: $name" }
        Copy-Item $source (Join-Path $staging $name)
    }
    foreach ($name in $scriptFiles) {
        $source = Join-Path $root (Join-Path "scripts" $name)
        if (-not (Test-Path $source)) { throw "Required student script is missing: $name" }
        Copy-Item $source (Join-Path $staging (Join-Path "scripts" $name))
    }

    if (Test-Path $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $outputPath -CompressionLevel Optimal
    Write-Host "Created $outputPath" -ForegroundColor Green
}
finally {
    if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
