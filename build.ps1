# Official UWP APPX Build Script for Windows 10 Mobile Lumia
# Uses official Microsoft Windows SDK MakeAppx and SignTool

$ErrorActionPreference = "Stop"

$projectRoot = "c:\Users\Israel\Desktop\metronome wp"
$toolsDir    = "$projectRoot\tools\x64"
$sourceDir   = "$projectRoot\MetronomeUWP"
$pkgLayout   = "$projectRoot\PackageLayout"
$releaseDir  = "$projectRoot\Release"
$outAppx     = "$releaseDir\Metronome_1.0.0.0_Lumia.appx"
$cerPath     = "$releaseDir\Metronome_TestCert.cer"

$makeappx = "$toolsDir\makeappx.exe"
$signtool = "$toolsDir\signtool.exe"

# The permanent cert thumbprint installed on the Lumia device (Valid until 2076 / 50 Years)
$certThumbprint = "791D3B1BC5C5C390C3B3292D22057B7F3859FA49"

Write-Host "1. Preparing clean PackageLayout directory..."
if (Test-Path $pkgLayout) { Remove-Item $pkgLayout -Recurse -Force }
New-Item -ItemType Directory -Path $pkgLayout -Force | Out-Null
New-Item -ItemType Directory -Path "$pkgLayout\assets" -Force | Out-Null
New-Item -ItemType Directory -Path "$pkgLayout\sounds" -Force | Out-Null
if (-not (Test-Path $releaseDir)) { New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null }

Copy-Item "$sourceDir\AppxManifest.xml" -Destination $pkgLayout
Copy-Item "$sourceDir\index.html" -Destination $pkgLayout
Copy-Item "$sourceDir\app.css" -Destination $pkgLayout
Copy-Item "$sourceDir\app.js" -Destination $pkgLayout
Copy-Item "$sourceDir\assets\*" -Destination "$pkgLayout\assets"
Copy-Item "$sourceDir\sounds\*" -Destination "$pkgLayout\sounds"

Write-Host "2. Creating package with official MakeAppx..."
if (Test-Path $outAppx) { Remove-Item $outAppx -Force }
& $makeappx pack /d $pkgLayout /p $outAppx /o /v

if ($LASTEXITCODE -ne 0) {
    throw "makeappx failed with exit code $LASTEXITCODE"
}

Write-Host "3. Signing package with official SignTool using installed cert ($certThumbprint)..."
& $signtool sign /fd SHA256 /sha1 $certThumbprint /v $outAppx

if ($LASTEXITCODE -ne 0) {
    throw "signtool failed with exit code $LASTEXITCODE"
}

# Verify cert file matches thumbprint
$cert = Get-ChildItem "Cert:\CurrentUser\My" | Where-Object { $_.Thumbprint -eq $certThumbprint }
if ($cert) {
    Export-Certificate -Cert $cert -FilePath $cerPath -Force | Out-Null
}

$sz = (Get-Item $outAppx).Length
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "BUILD SUCCESSFUL!" -ForegroundColor Green
Write-Host "Package: $outAppx ($([math]::Round($sz/1024, 1)) KB)"
Write-Host "Signed with permanent cert: CN=PhilippBobek ($certThumbprint)"
Write-Host "==========================================================" -ForegroundColor Green
