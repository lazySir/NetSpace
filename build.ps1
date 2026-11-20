param(
    [string]$Python = 'python',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/three.module.js'))) {
    & $Python tools/vendor_three.py
    if ($LASTEXITCODE -ne 0) { throw 'Cannot fetch pinned Three.js assets.' }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/fuse.min.js'))) {
    throw 'Pinned Fuse.js asset is missing.'
}
$assetArgument = (Join-Path $PSScriptRoot 'web') + ';web'
& $Python -m PyInstaller --noconfirm --clean --onefile --windowed --name NetSpace --icon assets/netspace.ico --add-data $assetArgument --distpath $OutputDirectory --workpath (Join-Path $OutputDirectory 'build') app.py
if ($LASTEXITCODE -ne 0) { throw 'The Windows application build failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $OutputDirectory 'README.md') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $OutputDirectory 'THIRD_PARTY_NOTICES.md') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/THREE-LICENSE.txt') -Destination (Join-Path $OutputDirectory 'THREE-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'web/vendor/FUSE-LICENSE.txt') -Destination (Join-Path $OutputDirectory 'FUSE-LICENSE.txt') -Force
$pythonFolder = & $Python -c "import sys; print(sys.base_prefix)"
$pythonLicense = Join-Path $pythonFolder 'LICENSE.txt'
if (Test-Path -LiteralPath $pythonLicense) {
    Copy-Item -LiteralPath $pythonLicense -Destination (Join-Path $OutputDirectory 'PYTHON-LICENSE.txt') -Force
}
$bundleFiles = @(
    (Join-Path $OutputDirectory 'NetSpace.exe'),
    (Join-Path $OutputDirectory 'README.md'),
    (Join-Path $OutputDirectory 'THIRD_PARTY_NOTICES.md'),
    (Join-Path $OutputDirectory 'THREE-LICENSE.txt'),
    (Join-Path $OutputDirectory 'FUSE-LICENSE.txt')
)
if (Test-Path -LiteralPath (Join-Path $OutputDirectory 'PYTHON-LICENSE.txt')) {
    $bundleFiles += (Join-Path $OutputDirectory 'PYTHON-LICENSE.txt')
}
Compress-Archive -LiteralPath $bundleFiles -DestinationPath (Join-Path $OutputDirectory 'NetSpace-Windows-x64.zip') -Force
& $Python tools/package_source.py --destination (Join-Path $OutputDirectory 'NetSpace-Source.zip')
if ($LASTEXITCODE -ne 0) { throw 'The source archive build failed.' }
Write-Output ('Created {0}' -f $OutputDirectory)
