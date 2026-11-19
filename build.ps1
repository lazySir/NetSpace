param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/three.module.js'))) {
    & $Python tools/vendor_three.py
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch pinned Three.js assets.' }
}
$assetArgument = (Join-Path $PSScriptRoot 'web') + ';web'
& $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name NetSpace --icon assets/netspace.ico --add-data $assetArgument app.py
if ($LASTEXITCODE -ne 0) { throw 'The Windows application build failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $PSScriptRoot 'dist/README.md') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $PSScriptRoot 'dist/THIRD_PARTY_NOTICES.md') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/THREE-LICENSE.txt') -Destination (Join-Path $PSScriptRoot 'dist/THREE-LICENSE.txt') -Force
$pythonFolder = & $Python -c "import sys; print(sys.base_prefix)"
$pythonLicense = Join-Path $pythonFolder 'LICENSE.txt'
if (Test-Path -LiteralPath $pythonLicense) {
    Copy-Item -LiteralPath $pythonLicense -Destination (Join-Path $PSScriptRoot 'dist/PYTHON-LICENSE.txt') -Force
}
$bundleFiles = @(
    (Join-Path $PSScriptRoot 'dist/NetSpace.exe'),
    (Join-Path $PSScriptRoot 'dist/README.md'),
    (Join-Path $PSScriptRoot 'dist/THIRD_PARTY_NOTICES.md'),
    (Join-Path $PSScriptRoot 'dist/THREE-LICENSE.txt')
)
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist/PYTHON-LICENSE.txt')) {
    $bundleFiles += (Join-Path $PSScriptRoot 'dist/PYTHON-LICENSE.txt')
}
Compress-Archive -LiteralPath $bundleFiles -DestinationPath (Join-Path $PSScriptRoot 'dist/NetSpace-Windows-x64.zip') -Force
& $Python tools/package_source.py
if ($LASTEXITCODE -ne 0) { throw 'The source archive build failed.' }
Write-Output 'Created dist/NetSpace.exe, dist/NetSpace-Windows-x64.zip and dist/NetSpace-Source.zip'
