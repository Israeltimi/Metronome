# sign_and_inject.ps1
# 1. Generates AppxSignature.p7x using .NET SignedCms
# 2. Injects it into the existing APPX by rebuilding the ZIP from raw bytes
#    (does NOT use ZipArchive which corrupts already-compressed binary entries)
param(
    [string]$SrcDir      = "c:\Users\Israel\Desktop\metronome wp\MetronomeUWP",
    [string]$OutDir      = "c:\Users\Israel\Desktop\metronome wp\Release",
    [string]$AppxFile    = "Metronome_1.0.0.0_Lumia.appx",
    [string]$CertSubject = "CN=PhilippBobek"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security

# -----------------------------------------------------------------------
# DER helpers
# -----------------------------------------------------------------------
function DER-Len([int]$n) {
    if ($n -lt 0x80)   { return [byte[]]$n }
    if ($n -le 0xFF)   { return [byte[]](0x81, $n) }
    if ($n -le 0xFFFF) { return [byte[]](0x82, ($n -shr 8), ($n -band 0xFF)) }
    return [byte[]](0x83, (($n -shr 16)-band 0xFF),(($n -shr 8)-band 0xFF),($n -band 0xFF))
}
function DER-TLV([byte]$tag,[byte[]]$value){ ([byte[]]$tag)+(DER-Len $value.Length)+$value }
function DER-SEQ([byte[]]$v){ DER-TLV 0x30 $v }
function DER-NULL { [byte[]](0x05,0x00) }
function DER-OCTET([byte[]]$v){ DER-TLV 0x04 $v }
function DER-INT-Num([int]$n){
    $hex='{0:X}'-f $n; if($hex.Length%2){$hex='0'+$hex}
    $b=[byte[]]($hex-split'(?<=\G..)(?=.)' | ForEach-Object{[Convert]::ToByte($_,16)})
    if($b[0]-band 0x80){$b=[byte[]](0x00)+$b}
    DER-TLV 0x02 $b
}
function DER-OID([string]$d){
    $parts=$d.Split('.')|ForEach-Object{[int]$_}
    $bytes=New-Object 'System.Collections.Generic.List[byte]'
    $bytes.Add([byte](40*$parts[0]+$parts[1]))
    for($i=2;$i-lt$parts.Length;$i++){
        $v=$parts[$i];$seg=New-Object 'System.Collections.Generic.List[byte]'
        $seg.Add([byte]($v-band 0x7F));$v=$v-shr 7
        while($v-gt 0){$seg.Insert(0,[byte](($v-band 0x7F)-bor 0x80));$v=$v-shr 7}
        $bytes.AddRange($seg)
    }
    DER-TLV 0x06 $bytes.ToArray()
}

# -----------------------------------------------------------------------
# Step 1: Cert
# -----------------------------------------------------------------------
Write-Host "1. Getting signing certificate..."
$cert = Get-ChildItem "Cert:\CurrentUser\My" |
    Where-Object { $_.Subject -eq $CertSubject -and $_.HasPrivateKey } |
    Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type Custom -Subject $CertSubject `
        -KeyUsage DigitalSignature -FriendlyName "Metronome Lumia" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")
}
Write-Host "   $($cert.Subject)  [$($cert.Thumbprint)]"
Export-Certificate -Cert $cert -FilePath (Join-Path $OutDir "Metronome_TestCert.cer") | Out-Null

# -----------------------------------------------------------------------
# Step 2: APPX Ax digest
# -----------------------------------------------------------------------
Write-Host "2. Computing APPX Ax digest..."
$sha = [System.Security.Cryptography.SHA256]::Create()
function SHA256-File([string]$p){ $sha.ComputeHash([System.IO.File]::ReadAllBytes($p)) }

$ms=[System.IO.MemoryStream]::new(); $bw=[System.IO.BinaryWriter]::new($ms)
$bw.Write([uint32]28)
$bw.Write([uint32]0x58505041)  # APPX
$bw.Write([uint32]0x00020000)
$bw.Write([uint32]3)
$bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
# AXPC = [Content_Types].xml
$bw.Write([uint32]0x43505841); $bw.Write([uint32]32); $bw.Write((SHA256-File "$SrcDir\[Content_Types].xml"))
# AXBM = AppxBlockMap.xml
$bw.Write([uint32]0x4D425841); $bw.Write([uint32]32); $bw.Write((SHA256-File "$SrcDir\AppxBlockMap.xml"))
# AXCT = AppxManifest.xml
$bw.Write([uint32]0x54435841); $bw.Write([uint32]32); $bw.Write((SHA256-File "$SrcDir\AppxManifest.xml"))
$bw.Flush()
$axDigest = $sha.ComputeHash($ms.ToArray())
Write-Host "   Ax digest: $([BitConverter]::ToString($axDigest).Replace('-','').ToLower())"

# -----------------------------------------------------------------------
# Step 3: SpcIndirectDataContent DER
# -----------------------------------------------------------------------
$sipInfo = DER-SEQ ((DER-INT-Num 65536)+(DER-OCTET([byte[]](0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)))+(DER-INT-Num 0)+(DER-INT-Num 0)+(DER-INT-Num 0))
$data    = DER-SEQ ((DER-OID '1.3.6.1.4.1.311.2.1.28')+$sipInfo)
$algId   = DER-SEQ ((DER-OID '2.16.840.1.101.3.4.2.1')+(DER-NULL))
$digest  = DER-SEQ ($algId+(DER-OCTET $axDigest))
$spcContent = DER-SEQ ($data+$digest)

# -----------------------------------------------------------------------
# Step 4: Sign with .NET SignedCms
# -----------------------------------------------------------------------
Write-Host "3. Signing with .NET SignedCms..."
$ci = New-Object System.Security.Cryptography.Pkcs.ContentInfo(
    [System.Security.Cryptography.Oid]::new('1.3.6.1.4.1.311.2.1.4'),
    [byte[]]$spcContent)
$scms = New-Object System.Security.Cryptography.Pkcs.SignedCms($ci,$false)
$signer = New-Object System.Security.Cryptography.Pkcs.CmsSigner($cert)
$signer.DigestAlgorithm = [System.Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.2.1')
$signer.IncludeOption   = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly
$scms.ComputeSignature($signer,$true)
$p7Bytes = $scms.Encode()
Write-Host "   PKCS#7: $($p7Bytes.Length) bytes  Signers=$($scms.SignerInfos.Count)"

$p7xBytes = ([byte[]](0x50,0x4B,0x43,0x58))+$p7Bytes  # PKCX magic + PKCS#7
$sigPath  = Join-Path $SrcDir "AppxSignature.p7x"
[System.IO.File]::WriteAllBytes($sigPath, $p7xBytes)
Write-Host "   AppxSignature.p7x written ($($p7xBytes.Length) bytes)"

# -----------------------------------------------------------------------
# Step 5: Rebuild APPX with raw ZIP byte manipulation
#         Read all local file entries, strip old AppxSignature.p7x if present,
#         inject new one, recompute Central Directory + EOCD
# -----------------------------------------------------------------------
Write-Host "4. Rebuilding APPX with injected signature..."

$appxPath = Join-Path $OutDir $AppxFile
$zipBytes = [System.IO.File]::ReadAllBytes($appxPath)

# Parse all local file entries
$localEntries = [System.Collections.Generic.List[hashtable]]::new()
$pos = 0
while ($pos -lt $zipBytes.Length-4) {
    $sig = [BitConverter]::ToUInt32($zipBytes,$pos)
    if ($sig -ne 0x04034b50) { break }
    $method = [BitConverter]::ToUInt16($zipBytes,$pos+8)
    $crc    = [BitConverter]::ToUInt32($zipBytes,$pos+14)
    $cs     = [BitConverter]::ToUInt32($zipBytes,$pos+18)
    $us     = [BitConverter]::ToUInt32($zipBytes,$pos+22)
    $nl     = [BitConverter]::ToUInt16($zipBytes,$pos+26)
    $el     = [BitConverter]::ToUInt16($zipBytes,$pos+28)
    $name   = [System.Text.Encoding]::UTF8.GetString($zipBytes,$pos+30,$nl)
    $lfhBytes = $zipBytes[($pos)..($pos+30+$nl+$el+$cs-1)]
    $localEntries.Add(@{ Name=$name; Method=$method; CRC=$crc; CS=$cs; US=$us; NL=$nl; EL=$el; LFH=$lfhBytes })
    $pos += 30+$nl+$el+$cs
}
Write-Host "   Read $($localEntries.Count) entries from existing APPX"

# Remove old AppxSignature.p7x if present
$localEntries = [System.Collections.Generic.List[hashtable]]($localEntries | Where-Object { $_.Name -ne 'AppxSignature.p7x' })

# Build new AppxSignature.p7x entry raw bytes
function Make-LFH([string]$name,[byte[]]$data,[bool]$store) {
    $nameBytes = [System.Text.Encoding]::UTF8.GetBytes($name)
    $method = if ($store) { 0 } else { 8 }
    $compData = if ($store) { $data } else { ... }  # we always store .p7x
    $crc32 = Compute-CRC32 $data
    $lfh = New-Object byte[] (30+$nameBytes.Length)
    [BitConverter]::GetBytes([uint32]0x04034b50).CopyTo($lfh,0)
    [BitConverter]::GetBytes([uint16]20).CopyTo($lfh,4)
    [BitConverter]::GetBytes([uint16]0).CopyTo($lfh,6)   # gpFlag
    [BitConverter]::GetBytes([uint16]$method).CopyTo($lfh,8)
    [BitConverter]::GetBytes([uint16]0).CopyTo($lfh,10)  # mod time
    [BitConverter]::GetBytes([uint16]((2026-1980)*512+32+1)).CopyTo($lfh,12) # mod date 2026-01-01
    [BitConverter]::GetBytes([uint32]$crc32).CopyTo($lfh,14)
    [BitConverter]::GetBytes([uint32]$data.Length).CopyTo($lfh,18)  # comp=uncomp (stored)
    [BitConverter]::GetBytes([uint32]$data.Length).CopyTo($lfh,22)
    [BitConverter]::GetBytes([uint16]$nameBytes.Length).CopyTo($lfh,26)
    [BitConverter]::GetBytes([uint16]0).CopyTo($lfh,28)
    $nameBytes.CopyTo($lfh,30)
    return $lfh+$data
}

# CRC32
function Compute-CRC32([byte[]]$buf){
    $table = [uint32[]]::new(256)
    for($n=0;$n-lt 256;$n++){
        $c=[uint32]$n
        for($k=0;$k-lt 8;$k++){$c=if($c-band 1){0xEDB88320-bxor($c-shr 1)}else{$c-shr 1}}
        $table[$n]=$c
    }
    $crc=[uint32]0xFFFFFFFF
    foreach($b in $buf){$crc=$table[($crc-bxor$b)-band 0xFF]-bxor($crc-shr 8)}
    return ($crc-bxor 0xFFFFFFFF)
}

$sigLFHData = New-Object byte[] (30+([System.Text.Encoding]::UTF8.GetByteCount('AppxSignature.p7x'))+$p7xBytes.Length)
$sigNameBytes = [System.Text.Encoding]::UTF8.GetBytes('AppxSignature.p7x')
$crcSig = Compute-CRC32 $p7xBytes
$sigLFH = New-Object byte[] (30+$sigNameBytes.Length)
[BitConverter]::GetBytes([uint32]0x04034b50).CopyTo($sigLFH,0)
[BitConverter]::GetBytes([uint16]20).CopyTo($sigLFH,4)
[BitConverter]::GetBytes([uint16]0).CopyTo($sigLFH,6)
[BitConverter]::GetBytes([uint16]0).CopyTo($sigLFH,8)   # method=0 (stored)
[BitConverter]::GetBytes([uint16]0).CopyTo($sigLFH,10)
[BitConverter]::GetBytes([uint16]((2026-1980)*512+32+1)).CopyTo($sigLFH,12)
[BitConverter]::GetBytes([uint32]$crcSig).CopyTo($sigLFH,14)
[BitConverter]::GetBytes([uint32]$p7xBytes.Length).CopyTo($sigLFH,18)
[BitConverter]::GetBytes([uint32]$p7xBytes.Length).CopyTo($sigLFH,22)
[BitConverter]::GetBytes([uint16]$sigNameBytes.Length).CopyTo($sigLFH,26)
[BitConverter]::GetBytes([uint16]0).CopyTo($sigLFH,28)
$sigNameBytes.CopyTo($sigLFH,30)

# Determine insertion order: [Content_Types].xml, AppxManifest.xml, AppxBlockMap.xml, AppxSignature.p7x, rest
$order = @('[Content_Types].xml','AppxManifest.xml','AppxBlockMap.xml')
$orderedEntries = [System.Collections.Generic.List[object]]::new()
foreach($o in $order){
    $e = $localEntries | Where-Object { $_.Name -eq $o } | Select-Object -First 1
    if ($e) { $orderedEntries.Add($e) }
}
# AppxSignature.p7x goes here (raw bytes = LFH header + payload)
$remainingEntries = $localEntries | Where-Object { $order -notcontains $_.Name }
foreach($e in $remainingEntries){ $orderedEntries.Add($e) }

# Build the new ZIP
$outStream = New-Object System.IO.MemoryStream
$offsets = [System.Collections.Generic.List[long]]::new()

# Write ordered existing entries
foreach($e in $orderedEntries){
    $offsets.Add([long]$outStream.Length)
    $outStream.Write($e.LFH,0,$e.LFH.Length)
}

# Write AppxSignature.p7x as stored entry at position 3 (after AppxBlockMap)
# Insert it between AppxBlockMap and remaining entries
# Rebuild properly in a new list
$outStream2 = New-Object System.IO.MemoryStream
$allNewEntries = [System.Collections.Generic.List[hashtable]]::new()

foreach($o in $order){
    $e = $localEntries | Where-Object { $_.Name -eq $o } | Select-Object -First 1
    if ($e) { $allNewEntries.Add($e) }
}

# Sig entry (virtual - we'll add it as raw bytes)
$allNewEntries.Add(@{ Name='AppxSignature.p7x'; Method=0; CRC=$crcSig; CS=$p7xBytes.Length; US=$p7xBytes.Length; NL=$sigNameBytes.Length; EL=0; LFH=($sigLFH+$p7xBytes) })

foreach($e in $remainingEntries){
    $allNewEntries.Add($e)
}

$offsets2 = [System.Collections.Generic.List[long]]::new()
foreach($e in $allNewEntries){
    $offsets2.Add([long]$outStream2.Length)
    $outStream2.Write($e.LFH,0,$e.LFH.Length)
}

# Central Directory
$cdStart = [long]$outStream2.Length
foreach($idx in 0..($allNewEntries.Count-1)){
    $e = $allNewEntries[$idx]
    $localOff = $offsets2[$idx]
    $cdnBytes = [System.Text.Encoding]::UTF8.GetBytes($e.Name)
    $cdfh = New-Object byte[] (46+$cdnBytes.Length)
    [BitConverter]::GetBytes([uint32]0x02014b50).CopyTo($cdfh,0)
    [BitConverter]::GetBytes([uint16]20).CopyTo($cdfh,4)
    [BitConverter]::GetBytes([uint16]20).CopyTo($cdfh,6)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,8)
    [BitConverter]::GetBytes([uint16]$e.Method).CopyTo($cdfh,10)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,12)
    [BitConverter]::GetBytes([uint16]((2026-1980)*512+32+1)).CopyTo($cdfh,14)
    [BitConverter]::GetBytes([uint32]$e.CRC).CopyTo($cdfh,16)
    [BitConverter]::GetBytes([uint32]$e.CS).CopyTo($cdfh,20)
    [BitConverter]::GetBytes([uint32]$e.US).CopyTo($cdfh,24)
    [BitConverter]::GetBytes([uint16]$cdnBytes.Length).CopyTo($cdfh,28)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,30)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,32)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,34)
    [BitConverter]::GetBytes([uint16]0).CopyTo($cdfh,36)
    [BitConverter]::GetBytes([uint32]0).CopyTo($cdfh,38)
    [BitConverter]::GetBytes([uint32]$localOff).CopyTo($cdfh,42)
    $cdnBytes.CopyTo($cdfh,46)
    $outStream2.Write($cdfh,0,$cdfh.Length)
}

$cdSize = [long]$outStream2.Length - $cdStart
$eocd = New-Object byte[] 22
[BitConverter]::GetBytes([uint32]0x06054b50).CopyTo($eocd,0)
[BitConverter]::GetBytes([uint16]0).CopyTo($eocd,4)
[BitConverter]::GetBytes([uint16]0).CopyTo($eocd,6)
[BitConverter]::GetBytes([uint16]$allNewEntries.Count).CopyTo($eocd,8)
[BitConverter]::GetBytes([uint16]$allNewEntries.Count).CopyTo($eocd,10)
[BitConverter]::GetBytes([uint32]$cdSize).CopyTo($eocd,12)
[BitConverter]::GetBytes([uint32]$cdStart).CopyTo($eocd,16)
[BitConverter]::GetBytes([uint16]0).CopyTo($eocd,20)
$outStream2.Write($eocd,0,22)

$finalBytes = $outStream2.ToArray()
[System.IO.File]::WriteAllBytes($appxPath,$finalBytes)
Write-Host "   Written: $appxPath ($([Math]::Round($finalBytes.Length/1024,1)) KB)"

# -----------------------------------------------------------------------
# Step 6: Verify
# -----------------------------------------------------------------------
Write-Host "5. Final verification..."
$vBytes = [System.IO.File]::ReadAllBytes($appxPath)
$vPos=0; $vProbs=0
while($vPos-lt $vBytes.Length-4){
    $vSig=[BitConverter]::ToUInt32($vBytes,$vPos)
    if($vSig-ne 0x04034b50){break}
    $vNl=[BitConverter]::ToUInt16($vBytes,$vPos+26)
    $vEl=[BitConverter]::ToUInt16($vBytes,$vPos+28)
    $vCs=[BitConverter]::ToUInt32($vBytes,$vPos+18)
    $vUs=[BitConverter]::ToUInt32($vBytes,$vPos+22)
    $vNm=[System.Text.Encoding]::UTF8.GetString($vBytes,$vPos+30,$vNl)
    if($vCs-gt $vUs){Write-Host "  FAIL: $vNm comp=$vCs uncomp=$vUs" -ForegroundColor Red;$vProbs++}
    $vPos+=30+$vNl+$vEl+$vCs
}
if($vProbs-eq 0){Write-Host "   All entries: CompressedSize <= UncompressedSize" -ForegroundColor Green}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipV=[System.IO.Compression.ZipFile]::OpenRead($appxPath)
$seV=$zipV.Entries|Where-Object{$_.FullName-eq'AppxSignature.p7x'}
$bufV=New-Object byte[]([int]$seV.Length);$sV=$seV.Open();$sV.Read($bufV,0,$bufV.Length)|Out-Null;$sV.Close()
$cmsV=New-Object System.Security.Cryptography.Pkcs.SignedCms
$cmsV.Decode($bufV[4..($bufV.Length-1)])
Write-Host "   AppxSignature.p7x Signers=$($cmsV.SignerInfos.Count)  Cert=$($cmsV.Certificates[0].Subject)" -ForegroundColor Green
$zipV.Dispose()

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "DONE! Upload to Device Portal:" -ForegroundColor Green
Write-Host "  $appxPath"
Write-Host "==========================================" -ForegroundColor Cyan
