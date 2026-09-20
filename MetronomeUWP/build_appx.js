/**
 * APPX Builder for Windows 10 Mobile (Lumia)
 * 
 * Produces a spec-compliant signed .appx by:
 * - Writing a raw ZIP with Method=0 (Stored, no compression) for binary files
 * - Excluding footprint files from the BlockMap per the APPX spec
 * - Generating a self-signed Authenticode AppxSignature.p7x
 * - Ordering entries: [Content_Types].xml, AppxManifest.xml, AppxBlockMap.xml,
 *   AppxSignature.p7x, then payload
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');
const { buildAppxSignature } = require('./appx_sign');

const SRC_DIR  = path.join(__dirname);
const OUT_DIR  = path.join(__dirname, '..', 'Release');
const OUT_APPX = path.join(OUT_DIR, 'Metronome_1.0.0.0_Lumia.appx');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Files that go in the archive but NOT in the blockmap
const FOOTPRINT = new Set(['[Content_Types].xml', 'AppxBlockMap.xml', 'AppxSignature.p7x']);

// Extensions that must be STORED (Method=0) - already-compressed binary formats
const STORE_EXT = new Set(['.png', '.wav', '.jpg', '.jpeg', '.mp3', '.ogg', '.m4a', '.zip', '.appx', '.p7x']);

// Build tool files to exclude entirely
const EXCLUDE_NAMES = new Set([
    'build_appx.ps1', 'build_appx.js', 'build_package.js', 'appx_sign.js',
    'package.json', 'package-lock.json', 'node_modules'
]);
const EXCLUDE_EXT = new Set(['.pfx', '.appx', '.cer', '.ps1']);

// --- CRC32 table ---
const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- Deflate compress ---
function deflateSync(buf) {
    // Use raw deflate (no zlib header) - ZIP uses raw deflate
    return zlib.deflateRawSync(buf, { level: 9 });
}

// --- Write little-endian integers ---
function writeUint16LE(buf, offset, val) {
    buf[offset]     = val & 0xFF;
    buf[offset + 1] = (val >>> 8) & 0xFF;
}
function writeUint32LE(buf, offset, val) {
    buf[offset]     = val & 0xFF;
    buf[offset + 1] = (val >>> 8) & 0xFF;
    buf[offset + 2] = (val >>> 16) & 0xFF;
    buf[offset + 3] = (val >>> 24) & 0xFF;
}

// --- Collect all files ---
function getAllFiles(dir, base = dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (EXCLUDE_NAMES.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...getAllFiles(fullPath, base));
        } else {
            const ext = path.extname(entry.name).toLowerCase();
            if (EXCLUDE_EXT.has(ext)) continue;
            if (EXCLUDE_NAMES.has(entry.name)) continue;
            const relPath = path.relative(base, fullPath).replace(/\\/g, '/');
            results.push({ fullPath, relPath, name: entry.name });
        }
    }
    return results;
}

// -----------------------------------------------------------------------
// Step 1: Generate [Content_Types].xml
// -----------------------------------------------------------------------
console.log('1. Generating [Content_Types].xml...');
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\r\n  <Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml" />\r\n  <Default Extension="png" ContentType="image/png" />\r\n  <Default Extension="html" ContentType="text/html" />\r\n  <Default Extension="css" ContentType="text/css" />\r\n  <Default Extension="js" ContentType="application/javascript" />\r\n  <Default Extension="wav" ContentType="audio/wav" />\r\n  <Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml" />\r\n  <Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml" />\r\n</Types>`;
fs.writeFileSync(path.join(SRC_DIR, '[Content_Types].xml'), contentTypesXml, 'utf8');

// -----------------------------------------------------------------------
// Step 2: Collect and prepare payload files
// -----------------------------------------------------------------------
console.log('2. Collecting payload files...');

const allFiles = getAllFiles(SRC_DIR);

// Payload = all files except footprint (they are separately controlled)
// Footprint files added to archive explicitly
const payloadFiles = allFiles
    .filter(f => !FOOTPRINT.has(f.name) && f.name !== 'AppxManifest.xml')
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

// -----------------------------------------------------------------------
// Step 3: Prepare all ZIP entries
// -----------------------------------------------------------------------

// Entry = { relPath, rawData, compData, method, crc, uncompressedSize, compressedSize }
function prepareEntry(relPath, filePath, forceStore = false) {
    const raw = fs.readFileSync(filePath);
    const ext = path.extname(relPath).toLowerCase();
    const shouldStore = forceStore || STORE_EXT.has(ext);

    let method, compData;
    if (shouldStore) {
        method = 0; // Stored
        compData = raw;
    } else {
        const deflated = deflateSync(raw);
        if (deflated.length < raw.length) {
            method = 8; // Deflated
            compData = deflated;
        } else {
            method = 0; // Stored (deflate made it bigger)
            compData = raw;
        }
    }

    return {
        relPath,
        rawData: raw,
        compData,
        method,
        crc: crc32(raw),
        uncompressedSize: raw.length,
        compressedSize: compData.length
    };
}

// Build ordered entry list for archive
const entries = [];

// Footprint files first (not in blockmap)
entries.push(prepareEntry('[Content_Types].xml', path.join(SRC_DIR, '[Content_Types].xml'), false));

// AppxManifest.xml (footprint, not in blockmap)
const manifestFile = allFiles.find(f => f.name === 'AppxManifest.xml');
if (manifestFile) {
    entries.push(prepareEntry('AppxManifest.xml', manifestFile.fullPath, false));
}

// We'll add AppxBlockMap.xml after generating it
// First collect payload entries so we know LfhSizes
const payloadEntries = payloadFiles.map(f => prepareEntry(f.relPath, f.fullPath));

// -----------------------------------------------------------------------
// Step 4: Generate AppxBlockMap.xml
// -----------------------------------------------------------------------
console.log('3. Generating AppxBlockMap.xml...');

const BLOCK_SIZE = 65536;

// LfhSize in blockmap = 30 + byteLength(relPath in UTF-8) + 0 (no extra field)
// This must exactly match the ZIP local file header size we'll write
function computeLfhSize(relPath) {
    return 30 + Buffer.byteLength(relPath, 'utf8');
}

// Block hashes are computed on UNCOMPRESSED (raw) data
function computeBlockHashes(rawData) {
    const blocks = [];
    let offset = 0;
    if (rawData.length === 0) {
        const h = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64');
        blocks.push({ hash: h, size: 0 });
    } else {
        while (offset < rawData.length) {
            const chunk = rawData.slice(offset, offset + BLOCK_SIZE);
            const h = crypto.createHash('sha256').update(chunk).digest('base64');
            blocks.push({ hash: h, size: chunk.length });
            offset += BLOCK_SIZE;
        }
    }
    return blocks;
}

// Build blockmap XML - only payload entries, NOT footprint files
let blockMapXml = `<?xml version="1.0" encoding="utf-8"?>\r\n<BlockMap HashMethod="http://www.w3.org/2001/04/xmlenc#sha256" xmlns="http://schemas.microsoft.com/appx/2010/blockmap">\r\n`;

// AppxManifest.xml is a footprint file - it IS listed in the blockmap
// per spec: AppxManifest.xml IS included in blockmap; [Content_Types].xml and AppxBlockMap.xml are NOT
if (manifestFile) {
    const me = entries.find(e => e.relPath === 'AppxManifest.xml');
    if (me) {
        const lfh = computeLfhSize('AppxManifest.xml');
        const blocks = computeBlockHashes(me.rawData);
        blockMapXml += `  <File Name="AppxManifest.xml" Size="${me.uncompressedSize}" LfhSize="${lfh}">\r\n`;
        for (const b of blocks) blockMapXml += `    <Block Hash="${b.hash}" Size="${b.size}"/>\r\n`;
        blockMapXml += `  </File>\r\n`;
    }
}

for (const pe of payloadEntries) {
    const lfh = computeLfhSize(pe.relPath);
    const blocks = computeBlockHashes(pe.rawData);
    blockMapXml += `  <File Name="${pe.relPath}" Size="${pe.uncompressedSize}" LfhSize="${lfh}">\r\n`;
    for (const b of blocks) blockMapXml += `    <Block Hash="${b.hash}" Size="${b.size}"/>\r\n`;
    blockMapXml += `  </File>\r\n`;
}
blockMapXml += `</BlockMap>`;

const blockMapPath = path.join(SRC_DIR, 'AppxBlockMap.xml');
fs.writeFileSync(blockMapPath, blockMapXml, 'utf8');

// Now add AppxBlockMap.xml entry
entries.push(prepareEntry('AppxBlockMap.xml', blockMapPath, false));

// Add all payload entries
entries.push(...payloadEntries);

// -----------------------------------------------------------------------
// Step 5: Write raw ZIP file
// -----------------------------------------------------------------------
console.log('4. Building APPX (raw ZIP)...');

// DOS time encoding (use a fixed date for reproducibility: 2026-01-01 00:00:00)
const DOS_TIME = 0x0000; // midnight
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01

const chunks = [];
let totalOffset = 0;
const centralDir = [];

for (const e of entries) {
    const nameBytes = Buffer.from(e.relPath, 'utf8');
    const lfhSize = 30 + nameBytes.length; // no extra field

    // Local File Header
    const lfh = Buffer.alloc(30 + nameBytes.length);
    writeUint32LE(lfh, 0, 0x04034b50);           // signature
    writeUint16LE(lfh, 4, 20);                    // version needed: 2.0
    writeUint16LE(lfh, 6, 0);                     // general purpose bit flag: 0 (no data descriptor)
    writeUint16LE(lfh, 8, e.method);              // compression method
    writeUint16LE(lfh, 10, DOS_TIME);             // last mod time
    writeUint16LE(lfh, 12, DOS_DATE);             // last mod date
    writeUint32LE(lfh, 14, e.crc);                // CRC-32
    writeUint32LE(lfh, 18, e.compressedSize);     // compressed size
    writeUint32LE(lfh, 22, e.uncompressedSize);   // uncompressed size
    writeUint16LE(lfh, 26, nameBytes.length);     // file name length
    writeUint16LE(lfh, 28, 0);                    // extra field length
    nameBytes.copy(lfh, 30);

    // Central Directory entry info
    centralDir.push({
        relPath: e.relPath,
        nameBytes,
        method: e.method,
        crc: e.crc,
        compressedSize: e.compressedSize,
        uncompressedSize: e.uncompressedSize,
        localHeaderOffset: totalOffset
    });

    chunks.push(lfh);
    chunks.push(e.compData);
    totalOffset += lfhSize + e.compressedSize;

    console.log(`  + ${e.relPath.padEnd(55)} method=${e.method===0?'Store':'Deflate'} size=${e.uncompressedSize}`);
}

// Central Directory
const cdStart = totalOffset;
for (const cd of centralDir) {
    const cdfh = Buffer.alloc(46 + cd.nameBytes.length);
    writeUint32LE(cdfh, 0, 0x02014b50);              // signature
    writeUint16LE(cdfh, 4, 20);                       // version made by
    writeUint16LE(cdfh, 6, 20);                       // version needed
    writeUint16LE(cdfh, 8, 0);                        // general purpose bit flag
    writeUint16LE(cdfh, 10, cd.method);               // compression method
    writeUint16LE(cdfh, 12, DOS_TIME);                // last mod time
    writeUint16LE(cdfh, 14, DOS_DATE);                // last mod date
    writeUint32LE(cdfh, 16, cd.crc);                  // CRC-32
    writeUint32LE(cdfh, 20, cd.compressedSize);       // compressed size
    writeUint32LE(cdfh, 24, cd.uncompressedSize);     // uncompressed size
    writeUint16LE(cdfh, 28, cd.nameBytes.length);     // file name length
    writeUint16LE(cdfh, 30, 0);                       // extra field length
    writeUint16LE(cdfh, 32, 0);                       // file comment length
    writeUint16LE(cdfh, 34, 0);                       // disk number start
    writeUint16LE(cdfh, 36, 0);                       // internal file attributes
    writeUint32LE(cdfh, 38, 0);                       // external file attributes
    writeUint32LE(cdfh, 42, cd.localHeaderOffset);    // relative offset of local header
    cd.nameBytes.copy(cdfh, 46);
    chunks.push(cdfh);
    totalOffset += cdfh.length;
}

// End of Central Directory
const cdSize = totalOffset - cdStart;
const eocd = Buffer.alloc(22);
writeUint32LE(eocd, 0, 0x06054b50);        // signature
writeUint16LE(eocd, 4, 0);                 // disk number
writeUint16LE(eocd, 6, 0);                 // disk with CD start
writeUint16LE(eocd, 8, entries.length);    // entries on this disk
writeUint16LE(eocd, 10, entries.length);   // total entries
writeUint32LE(eocd, 12, cdSize);           // CD size
writeUint32LE(eocd, 16, cdStart);          // CD offset
writeUint16LE(eocd, 20, 0);               // comment length
chunks.push(eocd);

fs.writeFileSync(OUT_APPX, Buffer.concat(chunks));

// -----------------------------------------------------------------------
// Step 6: Verify LfhSize values match
// -----------------------------------------------------------------------
console.log('\n5. Verifying blockmap LfhSize vs ZIP...');
const zipBytes = fs.readFileSync(OUT_APPX);
let pos = 0;
const actualLfh = {};
while (pos < zipBytes.length - 4) {
    const sig = zipBytes.readUInt32LE(pos);
    if (sig !== 0x04034b50) break;
    const nl = zipBytes.readUInt16LE(pos + 26);
    const el = zipBytes.readUInt16LE(pos + 28);
    const cs = zipBytes.readUInt32LE(pos + 18);
    const nm = zipBytes.slice(pos + 30, pos + 30 + nl).toString('utf8');
    actualLfh[nm] = 30 + nl + el;
    pos += 30 + nl + el + cs;
}

// Parse blockmap
const bmLines = fs.readFileSync(blockMapPath, 'utf8');
const fileMatches = [...bmLines.matchAll(/File Name="([^"]+)"[^>]+LfhSize="(\d+)"/g)];
let allOk = true;
for (const m of fileMatches) {
    const nm = m[1]; const bmLfh = parseInt(m[2]);
    const zipLfh = actualLfh[nm];
    const ok = zipLfh === bmLfh;
    if (!ok) { console.log(`  MISMATCH: ${nm}  blockmap=${bmLfh}  zip=${zipLfh}`); allOk = false; }
}
console.log(allOk ? '  ✓ All LfhSize values match' : '  ✗ LfhSize mismatches found!');

// Summary
const sz = fs.statSync(OUT_APPX).size;
console.log(`\n==========================================`);
console.log(`BUILD COMPLETE!`);
console.log(`APPX: ${OUT_APPX}`);
console.log(`Size: ${(sz/1024).toFixed(1)} KB`);
console.log(`==========================================`);
