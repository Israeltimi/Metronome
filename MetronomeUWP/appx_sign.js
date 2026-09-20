/**
 * appx_sign.js - APPX Authenticode signer
 * Uses PowerShell + .NET SignedCms to produce a valid PKCS#7 signature (Signers=1).
 */
'use strict';

const fs  = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os  = require('os');

function buildAppxSignature(srcDir, outputP7xPath) {
    const tmpCer = path.join(os.tmpdir(), 'appx_sign_cert_b64.txt');
    const tmpPs1 = path.join(os.tmpdir(), 'appx_sign_tmp.ps1');

    // Build PowerShell script as array of lines (no template literal backtick issues)
    const lines = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Security',
        '',
        '# --- DER helpers ---',
        'function DER-Len([int]$n) {',
        '    if ($n -lt 0x80)   { return [byte[]]$n }',
        '    if ($n -le 0xFF)   { return [byte[]](0x81, $n) }',
        '    if ($n -le 0xFFFF) { return [byte[]](0x82, ($n -shr 8), ($n -band 0xFF)) }',
        '    return [byte[]](0x83,(($n-shr 16)-band 0xFF),(($n-shr 8)-band 0xFF),($n-band 0xFF))',
        '}',
        'function DER-TLV([byte]$tag,[byte[]]$value){ ([byte[]]$tag)+(DER-Len $value.Length)+$value }',
        'function DER-SEQ([byte[]]$v){ DER-TLV 0x30 $v }',
        'function DER-NULL { [byte[]](0x05,0x00) }',
        'function DER-OCTET([byte[]]$v){ DER-TLV 0x04 $v }',
        'function DER-INT-Num([int]$n){',
        '    $h = "{0:X}" -f $n; if($h.Length%2){$h="0"+$h}',
        '    $b=[byte[]]($h-split"(?<=\\G..)(?=.)" | ForEach-Object{[Convert]::ToByte($_,16)})',
        '    if($b[0]-band 0x80){$b=[byte[]](0x00)+$b}',
        '    DER-TLV 0x02 $b',
        '}',
        'function DER-OID([string]$d){',
        '    $pts=$d.Split(".")|ForEach-Object{[int]$_}',
        '    $bytes=New-Object "System.Collections.Generic.List[byte]"',
        '    $bytes.Add([byte](40*$pts[0]+$pts[1]))',
        '    for($i=2;$i-lt$pts.Length;$i++){',
        '        $v=$pts[$i];$seg=New-Object "System.Collections.Generic.List[byte]"',
        '        $seg.Add([byte]($v-band 0x7F));$v=$v-shr 7',
        '        while($v-gt 0){$seg.Insert(0,[byte](($v-band 0x7F)-bor 0x80));$v=$v-shr 7}',
        '        $bytes.AddRange($seg)',
        '    }',
        '    DER-TLV 0x06 $bytes.ToArray()',
        '}',
        '',
        '# --- Get or create signing cert ---',
        '$subj = "CN=PhilippBobek"',
        '$cert = Get-ChildItem "Cert:\\CurrentUser\\My" |',
        '    Where-Object { $_.Subject -eq $subj -and $_.HasPrivateKey } |',
        '    Select-Object -First 1',
        'if (-not $cert) {',
        '    $cert = New-SelfSignedCertificate -Type Custom -Subject $subj \\',
        '        -KeyUsage DigitalSignature -FriendlyName "Metronome Lumia" \\',
        '        -CertStoreLocation "Cert:\\CurrentUser\\My" \\',
        '        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3","2.5.29.19={text}")',
        '}',
        '# Export cert DER as base64',
        '[System.IO.File]::WriteAllText("' + tmpCer.replace(/\\/g, '\\\\') + '", [Convert]::ToBase64String($cert.RawData))',
        '',
        '# --- Compute APPX Ax digest ---',
        '$sha = [System.Security.Cryptography.SHA256]::Create()',
        'function SHA256-F([string]$p){ $sha.ComputeHash([System.IO.File]::ReadAllBytes($p)) }',
        '$sd = "' + srcDir.replace(/\\/g, '\\\\') + '"',
        '$ms=[System.IO.MemoryStream]::new(); $bw=[System.IO.BinaryWriter]::new($ms)',
        '$bw.Write([uint32]28)',
        '$bw.Write([uint32]0x58505041)',
        '$bw.Write([uint32]0x00020000)',
        '$bw.Write([uint32]3)',
        '$bw.Write([uint32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)',
        '$bw.Write([uint32]0x43505841); $bw.Write([uint32]32); $bw.Write((SHA256-F "$sd\\[Content_Types].xml"))',
        '$bw.Write([uint32]0x4D425841); $bw.Write([uint32]32); $bw.Write((SHA256-F "$sd\\AppxBlockMap.xml"))',
        '$bw.Write([uint32]0x54435841); $bw.Write([uint32]32); $bw.Write((SHA256-F "$sd\\AppxManifest.xml"))',
        '$bw.Flush()',
        '$axDigest = $sha.ComputeHash($ms.ToArray())',
        '',
        '# --- Build SpcIndirectDataContent DER ---',
        '$zeros16=[byte[]](0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)',
        '$sipInfo=DER-SEQ((DER-INT-Num 65536)+(DER-OCTET $zeros16)+(DER-INT-Num 0)+(DER-INT-Num 0)+(DER-INT-Num 0))',
        '$data   =DER-SEQ((DER-OID "1.3.6.1.4.1.311.2.1.28")+$sipInfo)',
        '$algId  =DER-SEQ((DER-OID "2.16.840.1.101.3.4.2.1")+(DER-NULL))',
        '$dInfo  =DER-SEQ($algId+(DER-OCTET $axDigest))',
        '$spc    =DER-SEQ($data+$dInfo)',
        '',
        '# --- Sign with .NET SignedCms ---',
        '$ci=New-Object System.Security.Cryptography.Pkcs.ContentInfo(',
        '    [System.Security.Cryptography.Oid]::new("1.3.6.1.4.1.311.2.1.4"),[byte[]]$spc)',
        '$scms=New-Object System.Security.Cryptography.Pkcs.SignedCms($ci,$false)',
        '$sgr=New-Object System.Security.Cryptography.Pkcs.CmsSigner($cert)',
        '$sgr.DigestAlgorithm=[System.Security.Cryptography.Oid]::new("2.16.840.1.101.3.4.2.1")',
        '$sgr.IncludeOption=[System.Security.Cryptography.X509Certificates.X509IncludeOption]::EndCertOnly',
        '$scms.ComputeSignature($sgr,$true)',
        '$p7b=$scms.Encode()',
        '',
        '# --- Write PKCX + PKCS#7 ---',
        '$pkcx=[byte[]](0x50,0x4B,0x43,0x58)',
        '$out=$pkcx+$p7b',
        '[System.IO.File]::WriteAllBytes("' + outputP7xPath.replace(/\\/g, '\\\\') + '",$out)',
        'Write-Host "SIGNERS:$($scms.SignerInfos.Count):DONE"',
    ];

    const script = lines.join('\r\n');
    fs.writeFileSync(tmpPs1, script, 'utf8');

    let stdout = '';
    try {
        stdout = execSync(
            `powershell.exe -ExecutionPolicy Bypass -NonInteractive -File "${tmpPs1}"`,
            { encoding: 'utf8', timeout: 30000 }
        );
    } catch (e) {
        throw new Error(`PowerShell signing failed:\n${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`);
    } finally {
        try { fs.unlinkSync(tmpPs1); } catch {}
    }

    const m = stdout.match(/SIGNERS:(\d+):DONE/);
    const signers = m ? parseInt(m[1]) : 0;
    console.log(`  PowerShell SignedCms: Signers=${signers}`);
    if (signers === 0) throw new Error('SignedCms produced 0 signers');

    const certB64 = fs.readFileSync(tmpCer, 'utf8').trim();
    try { fs.unlinkSync(tmpCer); } catch {}
    return Buffer.from(certB64, 'base64');
}

module.exports = { buildAppxSignature };

if (require.main === module) {
    const SRC_DIR = __dirname;
    const OUT_DIR = path.join(__dirname, '..', 'Release');
    const sigPath  = path.join(SRC_DIR, 'AppxSignature.p7x');
    const cerPath  = path.join(OUT_DIR, 'Metronome_TestCert.cer');
    const certDer = buildAppxSignature(SRC_DIR, sigPath);
    fs.writeFileSync(cerPath, certDer);
    console.log(`Done. p7x=${fs.statSync(sigPath).size}B  cer=${cerPath}`);
}
