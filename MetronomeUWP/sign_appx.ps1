# sign_appx.ps1 - Authenticode APPX signer using .NET SignedCms
# Produces AppxSignature.p7x with a valid PKCS#7 SignerInfo (Signers != 0)
param(
    [string]$SrcDir    = "c:\Users\Israel\Desktop\metronome wp\MetronomeUWP",
    [string]$OutDir    = "c:\Users\Israel\Desktop\metronome wp\Release",
    [string]$AppxFile  = "Metronome_1.0.0.0_Lumia.appx",
    [string]$CertSubject = "CN=PhilippBobek"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# -----------------------------------------------------------------------
# Helper: minimal DER encoder (only what we need for SpcIndirectDataContent)
# -----------------------------------------------------------------------
function DER-Len([int]$n) {
    if ($n -lt 0x80)   { return [byte[]]$n }
    if ($n -le 0xFF)   { return [byte[]](0x81, $n) }
    if ($n -le 0xFFFF) { return [byte[]](0x82, ($n -shr 8), ($n -band 0xFF)) }
    return [byte[]](0x83, (($n -shr 16) -band 0xFF), (($n -shr 8) -band 0xFF), ($n -band 0xFF))
}
function DER-TLV([byte]$tag, [byte[]]$value) {
    return ([byte[]]$tag) + (DER-Len $value.Length) + $value
}
function DER-SEQ([byte[]]$v)  { return DER-TLV 0x30 $v }
function DER-NULL              { return [byte[]](0x05, 0x00) }
function DER-OCTET([byte[]]$v){ return DER-TLV 0x04 $v }

function DER-INT-Num([int]$n) {
    $hex = '{0:X}' -f $n; if ($hex.Length % 2) { $hex = '0' + $hex }
    $b = [byte[]]($hex -split '(?<=\G..)(?=.)' | ForEach-Object { [Convert]::ToByte($_, 16) })
    if ($b[0] -band 0x80) { $b = [byte[]]0x00 + $b }
    return DER-TLV 0x02 $b
}

function DER-OID([string]$dotted) {
    $parts = $dotted.Split('.') | ForEach-Object { [int]$_ }
    $bytes = New-Object 'System.Collections.Generic.List[byte]'
    $bytes.Add([byte](40 * $parts[0] + $parts[1]))
    for ($i = 2; $i -lt $parts.Length; $i++) {
        $v = $parts[$i]; $seg = New-Object 'System.Collections.Generic.List[byte]'
        $seg.Add([byte]($v -band 0x7F)); $v = $v -shr 7
        while ($v -gt 0) { $seg.Insert(0, [byte](($v -band 0x7F) -bor 0x80)); $v = $v -shr 7 }
        $bytes.AddRange($seg)
    }
    return DER-TLV 0x06 $bytes.ToArray()
}

# -----------------------------------------------------------------------
# Step 1: Get or create signing certificate (must have private key)
# -----------------------------------------------------------------------
Write-Host "1. Getting signing certificate..."
$cert = Get-ChildItem "Cert:\CurrentUser\My" |
    Where-Object { $_.Subject -eq $CertSubject -and $_.HasPrivateKey } |
    Select-Object -First 1

if (-not $cert) {
    Write-Host "   Creating new self-signed cert..."
    $cert = New-SelfSignedCertificate -Type Custom `
        -Subject $CertSubject `
        -KeyUsage DigitalSignature `
        -FriendlyName "Metronome Lumia Sideload" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
}
Write-Host "   Cert: $($cert.Subject)  Thumbprint: $($cert.Thumbprint)"

# Export public cert for installation on device
$cerPath = Join-Path $OutDir "Metronome_TestCert.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Write-Host "   Exported: $cerPath"

# -----------------------------------------------------------------------
# Step 2: Compute APPX Ax digest (hashes of footprint files)
# -----------------------------------------------------------------------
Write-Host "2. Computing APPX Ax footprint digest..."
$sha256 = [System.Security.Cryptography.SHA256]::Create()

function Get-SHA256File([string]$path) {
    return $sha256.ComputeHash([System.IO.File]::ReadAllBytes($path))
}

$hashCT  = Get-SHA256File "$SrcDir\[Content_Types].xml"   # AXPC
$hashBM  = Get-SHA256File "$SrcDir\AppxBlockMap.xml"       # AXBM
$hashMAN = Get-SHA256File "$SrcDir\AppxManifest.xml"       # AXCT

Write-Host "   AXPC ([Content_Types].xml): $([BitConverter]::ToString($hashCT).Replace('-','').ToLower())"
Write-Host "   AXBM (AppxBlockMap.xml):    $([BitConverter]::ToString($hashBM).Replace('-','').ToLower())"
Write-Host "   AXCT (AppxManifest.xml):    $([BitConverter]::ToString($hashMAN).Replace('-','').ToLower())"

# Build Ax binary blob
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint32]28)           # cbAxHeader
$bw.Write([uint32]0x58505041)   # 'APPX' magic (LE)
$bw.Write([uint32]0x00020000)   # version
$bw.Write([uint32]3)            # nAxItems
$bw.Write([uint32]0)            # flags
$bw.Write([uint32]0)            # pad1
$bw.Write([uint32]0)            # pad2
# AXPC
$bw.Write([uint32]0x43505841); $bw.Write([uint32]32); $bw.Write($hashCT)
# AXBM
$bw.Write([uint32]0x4D425841); $bw.Write([uint32]32); $bw.Write($hashBM)
# AXCT
$bw.Write([uint32]0x54435841); $bw.Write([uint32]32); $bw.Write($hashMAN)
$bw.Flush()
$axBytes = $ms.ToArray()
$appxDigest = $sha256.ComputeHash($axBytes)
Write-Host "   Ax Digest: $([BitConverter]::ToString($appxDigest).Replace('-','').ToLower())"

# -----------------------------------------------------------------------
# Step 3: Build SpcIndirectDataContent DER bytes
# -----------------------------------------------------------------------
Write-Host "3. Building SpcIndirectDataContent..."

# SpcSipInfo value:
#   INTEGER(65536), OCTETSTRING(16 zeros), INTEGER(0), INTEGER(0), INTEGER(0)
$sipInfoInner = `
    (DER-INT-Num 65536) +
    (DER-OCTET ([byte[]](0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0))) +
    (DER-INT-Num 0) +
    (DER-INT-Num 0) +
    (DER-INT-Num 0)
$sipInfo = DER-SEQ $sipInfoInner

# SpcAttributeTypeAndOptionalValue { OID(spcSipInfo), sipInfo }
$dataInner = (DER-OID '1.3.6.1.4.1.311.2.1.28') + $sipInfo
$data = DER-SEQ $dataInner

# DigestInfo { AlgorithmIdentifier(sha256), hash }
$algId = DER-SEQ ((DER-OID '2.16.840.1.101.3.4.2.1') + (DER-NULL))
$digestInfo = DER-SEQ ($algId + (DER-OCTET $appxDigest))

# SpcIndirectDataContent { data, messageDigest }
$spcContent = DER-SEQ ($data + $digestInfo)

Write-Host "   SpcIndirectDataContent: $($spcContent.Length) bytes"

# -----------------------------------------------------------------------
# Step 4: Sign using .NET SignedCms (guaranteed valid PKCS#7)
# -----------------------------------------------------------------------
Write-Host "4. Signing with .NET SignedCms..."

$contentInfo = New-Object System.Security.Cryptography.Pkcs.ContentInfo(
    [System.Security.Cryptography.Oid]::new('1.3.6.1.4.1.311.2.1.4'),
    [byte[]]$spcContent
)

$signedCms = New-Object System.Security.Cryptography.Pkcs.SignedCms($contentInfo, $false)

$signer = New-Object System.Security.Cryptography.Pkcs.CmsSigner($cert)
$signer.DigestAlgorithm = [System.Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.2.1') # SHA-256
$signer.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly

# Suppress the timestamp attribute (not needed for sideloading)
$signedCms.ComputeSignature($signer, $true)

$p7Bytes = $signedCms.Encode()
Write-Host "   PKCS#7 size: $($p7Bytes.Length) bytes"
Write-Host "   Signers in output: $($signedCms.SignerInfos.Count)"

# Verify we can round-trip the decode
$verify = New-Object System.Security.Cryptography.Pkcs.SignedCms
$verify.Decode($p7Bytes)
Write-Host "   Verification decode: OK, signers=$($verify.SignerInfos.Count)"

# -----------------------------------------------------------------------
# Step 5: Write AppxSignature.p7x = "PKCX" + PKCS#7 bytes
# -----------------------------------------------------------------------
Write-Host "5. Writing AppxSignature.p7x..."
$pkcx   = [byte[]](0x50, 0x4B, 0x43, 0x58)  # "PKCX"
$p7xBytes = $pkcx + $p7Bytes
$sigPath = Join-Path $SrcDir "AppxSignature.p7x"
[System.IO.File]::WriteAllBytes($sigPath, $p7xBytes)
Write-Host "   Written: $sigPath ($($p7xBytes.Length) bytes)"

# -----------------------------------------------------------------------
# Step 6: Inject AppxSignature.p7x into the existing APPX ZIP
# -----------------------------------------------------------------------
Write-Host "6. Injecting signature into APPX..."
$appxPath = Join-Path $OutDir $AppxFile

# Read current APPX (must rebuild because we can't just append - need correct offsets)
# Strategy: read all entries, replace or add AppxSignature.p7x

# Use ZipArchive to update - must rewrite the file
$tmpPath = $appxPath + ".tmp"
if (Test-Path $tmpPath) { Remove-Item $tmpPath }

# Read raw bytes of existing APPX
$existingBytes = [System.IO.File]::ReadAllBytes($appxPath)

# Open existing as source, create new as destination
$srcStream  = New-Object System.IO.MemoryStream(,$existingBytes)
$srcZip     = New-Object System.IO.Compression.ZipArchive($srcStream, [System.IO.Compression.ZipArchiveMode]::Read)

$dstStream  = [System.IO.File]::Open($tmpPath, [System.IO.FileMode]::Create)
$dstZip     = New-Object System.IO.Compression.ZipArchive($dstStream, [System.IO.Compression.ZipArchiveMode]::Create)

# Copy all entries except old AppxSignature.p7x, then add new one
$sigAdded = $false
foreach ($entry in $srcZip.Entries | Sort-Object { 
    # Maintain required order
    switch ($_.FullName) {
        '[Content_Types].xml'  { 0 }
        'AppxManifest.xml'     { 1 }
        'AppxBlockMap.xml'     { 2 }
        'AppxSignature.p7x'    { 3 }
        default                { 4 }
    }
}) {
    if ($entry.FullName -eq 'AppxSignature.p7x') { continue }  # skip old
    $newEntry = $dstZip.CreateEntry($entry.FullName, [System.IO.Compression.CompressionLevel]::NoCompression)
    # Set timestamp
    $newEntry.LastWriteTime = $entry.LastWriteTime
    $srcS = $entry.Open(); $dstS = $newEntry.Open()
    $srcS.CopyTo($dstS); $srcS.Close(); $dstS.Close()
}

# Add AppxSignature.p7x (must be stored, not compressed)
$sigEntry = $dstZip.CreateEntry('AppxSignature.p7x', [System.IO.Compression.CompressionLevel]::NoCompression)
$sigStream = $sigEntry.Open()
$sigStream.Write($p7xBytes, 0, $p7xBytes.Length)
$sigStream.Close()
Write-Host "   AppxSignature.p7x added to archive"

$srcZip.Dispose(); $srcStream.Dispose()
$dstZip.Dispose(); $dstStream.Dispose()

# Replace original
Move-Item -Path $tmpPath -Destination $appxPath -Force

# -----------------------------------------------------------------------
# Step 7: Verify final package
# -----------------------------------------------------------------------
Write-Host "7. Verifying final package..."
$zip2 = [System.IO.Compression.ZipFile]::OpenRead($appxPath)
$entries = $zip2.Entries | Select-Object FullName, Length, CompressedLength
$sigE = $zip2.Entries | Where-Object { $_.FullName -eq 'AppxSignature.p7x' }
if ($sigE) {
    $buf2 = New-Object byte[] ([int]$sigE.Length)
    $s2   = $sigE.Open(); $s2.Read($buf2, 0, $buf2.Length) | Out-Null; $s2.Close()
    $cms2 = New-Object System.Security.Cryptography.Pkcs.SignedCms
    try {
        $cms2.Decode($buf2[4..($buf2.Length-1)])
        Write-Host "   Signature in final APPX: VALID  Signers=$($cms2.SignerInfos.Count)"
    } catch {
        Write-Host "   Signature parse error: $_"
    }
}
$zip2.Dispose()

$sz = (Get-Item $appxPath).Length
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "SIGNED APPX COMPLETE!" -ForegroundColor Green
Write-Host "Package : $appxPath  ($([math]::Round($sz/1024,1)) KB)"
Write-Host "Cert    : $cerPath"
Write-Host "==========================================" -ForegroundColor Cyan
