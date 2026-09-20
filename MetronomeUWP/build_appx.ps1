# PowerShell UWP APPX Packager for Windows 10 Mobile Lumia
# Fixed: [Content_Types].xml excluded from blockmap (per APPX spec footprint files rule)
# Fixed: binary files (png/wav) stored uncompressed so CompressedSize never > UncompressedSize
param(
    [string]$SourceDir = "c:\Users\Israel\Desktop\metronome wp\MetronomeUWP",
    [string]$OutputDir = "c:\Users\Israel\Desktop\metronome wp\Release",
    [string]$PackageName = "Metronome_1.0.0.0_Lumia.appx"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# Remove any old generated files from SourceDir
foreach ($old in @("AppxSignature.p7x")) {
    $p = "$SourceDir\$old"
    if (Test-Path $p) { Remove-Item $p -Force }
}

# -----------------------------------------------------------------------
# APPX "footprint" files - present in archive but NOT listed in blockmap
# -----------------------------------------------------------------------
$FOOTPRINT_FILES = @("[Content_Types].xml", "AppxBlockMap.xml", "AppxSignature.p7x")

# Extensions that should be stored UNCOMPRESSED (already binary-compressed)
$STORE_UNCOMPRESSED_EXT = @(".png", ".wav", ".jpg", ".jpeg", ".mp3", ".ogg", ".m4a")

Write-Host "1. Generating [Content_Types].xml..."
$contentTypesXml = '<?xml version="1.0" encoding="utf-8"?>' + "`r`n" +
'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + "`r`n" +
'  <Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml" />' + "`r`n" +
'  <Default Extension="png" ContentType="image/png" />' + "`r`n" +
'  <Default Extension="html" ContentType="text/html" />' + "`r`n" +
'  <Default Extension="css" ContentType="text/css" />' + "`r`n" +
'  <Default Extension="js" ContentType="application/javascript" />' + "`r`n" +
'  <Default Extension="wav" ContentType="audio/wav" />' + "`r`n" +
'  <Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml" />' + "`r`n" +
'  <Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml" />' + "`r`n" +
'</Types>'
[System.IO.File]::WriteAllText("$SourceDir\[Content_Types].xml", $contentTypesXml, [System.Text.Encoding]::UTF8)

# -----------------------------------------------------------------------
# Step 2: Collect files and plan compression
# -----------------------------------------------------------------------
Write-Host "2. Collecting payload files..."

# Files to exclude from both blockmap and archive (build scripts, old packages, certs)
$EXCLUDE_NAMES = @("build_package.js", "build_appx.ps1", "package.json", "package-lock.json")
$EXCLUDE_EXT   = @(".appx", ".pfx", ".cer", ".ps1", ".js")  # but keep app.js - check by Name specifically

$allPayloadFiles = Get-ChildItem -Path $SourceDir -Recurse -File | Where-Object {
    $n = $_.Name
    $e = $_.Extension.ToLower()
    # Exclude footprint files (they go in archive but not blockmap)
    ($FOOTPRINT_FILES -notcontains $n) -and
    # Exclude build tooling files
    ($EXCLUDE_NAMES -notcontains $n) -and
    # Exclude .pfx .appx .cer
    ($e -ne ".pfx") -and ($e -ne ".appx") -and ($e -ne ".cer") -and
    # Exclude build_appx.ps1 specifically
    ($n -ne "build_appx.ps1") -and ($n -ne "build_package.js")
}

# Sort: AppxManifest.xml first, then everything else alphabetically
$sortedPayload = $allPayloadFiles | Sort-Object {
    if ($_.Name -eq "AppxManifest.xml") { "!00_" + $_.FullName }
    else { $_.FullName }
}

# -----------------------------------------------------------------------
# Step 3: Generate AppxBlockMap.xml
# -----------------------------------------------------------------------
Write-Host "3. Generating AppxBlockMap.xml..."

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$BLOCK_SIZE = 65536

# We need to know the exact LfhSize for each file as it will appear in the ZIP.
# LfhSize = 30 (fixed header) + len(filename_utf8) + extraFieldLen
# .NET ZipFile with CompressionLevel::NoCompression for binary files => extraLen = 0
# .NET ZipFile with CompressionLevel::Optimal for text files => extraLen = 0
# So LfhSize = 30 + UTF8ByteCount(relPath)

$blockMapLines = New-Object System.Collections.Generic.List[string]
$blockMapLines.Add('<?xml version="1.0" encoding="utf-8"?>')
$blockMapLines.Add('<BlockMap HashMethod="http://www.w3.org/2001/04/xmlenc#sha256" xmlns="http://schemas.microsoft.com/appx/2010/blockmap">')

foreach ($file in $sortedPayload) {
    $relPath = $file.FullName.Substring($SourceDir.Length).TrimStart('\').Replace('\', '/')
    $fileBytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $lfhSize = 30 + [System.Text.Encoding]::UTF8.GetByteCount($relPath)

    $blockMapLines.Add("  <File Name=""$relPath"" Size=""$($fileBytes.Length)"" LfhSize=""$lfhSize"">")

    if ($fileBytes.Length -eq 0) {
        $h = [Convert]::ToBase64String($sha256.ComputeHash([byte[]]@()))
        $blockMapLines.Add("    <Block Hash=""$h"" Size=""0""/>")
    } else {
        $off = 0
        while ($off -lt $fileBytes.Length) {
            $chunkLen = [Math]::Min($BLOCK_SIZE, $fileBytes.Length - $off)
            $chunk = New-Object byte[] $chunkLen
            [Array]::Copy($fileBytes, $off, $chunk, 0, $chunkLen)
            $h = [Convert]::ToBase64String($sha256.ComputeHash($chunk))
            $blockMapLines.Add("    <Block Hash=""$h"" Size=""$chunkLen""/>")
            $off += $chunkLen
        }
    }
    $blockMapLines.Add("  </File>")
}

$blockMapLines.Add("</BlockMap>")
$blockMapContent = $blockMapLines -join "`r`n"
[System.IO.File]::WriteAllText("$SourceDir\AppxBlockMap.xml", $blockMapContent, [System.Text.Encoding]::UTF8)

# -----------------------------------------------------------------------
# Step 4: Build ZIP / APPX
# -----------------------------------------------------------------------
Write-Host "4. Building APPX container..."
$outAppx = Join-Path $OutputDir $PackageName
if (Test-Path $outAppx) { Remove-Item $outAppx -Force }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipStream = [System.IO.File]::Open($outAppx, [System.IO.FileMode]::Create)
$zipArchive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create, $false)

function Add-FileToZip {
    param($archive, $filePath, $entryName, [bool]$compress)
    
    $level = if ($compress) { [System.IO.Compression.CompressionLevel]::Optimal } `
             else           { [System.IO.Compression.CompressionLevel]::NoCompression }
    
    $entry = $archive.CreateEntry($entryName, $level)
    $entryStream = $entry.Open()
    $fileStream  = [System.IO.File]::OpenRead($filePath)
    $fileStream.CopyTo($entryStream)
    $fileStream.Close()
    $entryStream.Close()
}

# 1. [Content_Types].xml (footprint, first entry, compressed ok)
Add-FileToZip $zipArchive "$SourceDir\[Content_Types].xml" "[Content_Types].xml" $true

# 2. AppxManifest.xml (footprint, second entry)
Add-FileToZip $zipArchive "$SourceDir\AppxManifest.xml" "AppxManifest.xml" $true

# 3. AppxBlockMap.xml (footprint, third entry)
Add-FileToZip $zipArchive "$SourceDir\AppxBlockMap.xml" "AppxBlockMap.xml" $true

# 4. Payload files in sorted order
foreach ($file in $sortedPayload) {
    $relPath = $file.FullName.Substring($SourceDir.Length).TrimStart('\').Replace('\', '/')
    # Skip footprint files if somehow included
    if ($FOOTPRINT_FILES -contains $file.Name -or $file.Name -eq "AppxManifest.xml") { continue }
    
    $ext = $file.Extension.ToLower()
    $shouldCompress = ($STORE_UNCOMPRESSED_EXT -notcontains $ext)
    Add-FileToZip $zipArchive $file.FullName $relPath $shouldCompress
    
    Write-Host "  Added: $relPath (compress=$shouldCompress)"
}

$zipArchive.Dispose()
$zipStream.Dispose()

# -----------------------------------------------------------------------
# Step 5: Verify LfhSizes match between blockmap and actual ZIP
# -----------------------------------------------------------------------
Write-Host "5. Verifying blockmap LfhSize values match ZIP..."
$bytes = [System.IO.File]::ReadAllBytes($outAppx)
$off = 0
$lfhActual = @{}
while ($off -lt $bytes.Length - 4) {
    $sig = [BitConverter]::ToUInt32($bytes, $off)
    if ($sig -eq 0x04034b50) {
        $nl = [BitConverter]::ToUInt16($bytes, $off + 26)
        $el = [BitConverter]::ToUInt16($bytes, $off + 28)
        $cs = [BitConverter]::ToUInt32($bytes, $off + 18)
        $nm = [System.Text.Encoding]::UTF8.GetString($bytes, $off + 30, $nl)
        $lfhActual[$nm] = 30 + $nl + $el
        $off += 30 + $nl + $el + $cs
    } else { break }
}

[xml]$bm = [System.IO.File]::ReadAllText("$SourceDir\AppxBlockMap.xml")
$allOk = $true
foreach ($f in $bm.BlockMap.File) {
    $nm = $f.Name
    $bmLfh = [int]$f.LfhSize
    $actualLfh = if ($lfhActual.ContainsKey($nm)) { $lfhActual[$nm] } else { -1 }
    if ($actualLfh -ne $bmLfh) {
        Write-Host "  MISMATCH: $nm  blockmap=$bmLfh  zip=$actualLfh" -ForegroundColor Red
        $allOk = $false
    }
}
if ($allOk) { Write-Host "  All LfhSize values OK" -ForegroundColor Green }

# -----------------------------------------------------------------------
# Step 6: Export sideloading certificate
# -----------------------------------------------------------------------
Write-Host "6. Exporting sideloading certificate..."
$certSubject = "CN=PhilippBobek"
$cert = Get-ChildItem -Path "Cert:\CurrentUser\My" | Where-Object { $_.Subject -eq $certSubject } | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type Custom `
        -Subject $certSubject `
        -KeyUsage DigitalSignature `
        -FriendlyName "Metronome Lumia Sideload Certificate" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
}
$cerPath = Join-Path $OutputDir "Metronome_TestCert.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "BUILD COMPLETE!" -ForegroundColor Green
Write-Host "APPX Package : $outAppx"
Write-Host "Certificate  : $cerPath"
Write-Host "==========================================" -ForegroundColor Cyan
