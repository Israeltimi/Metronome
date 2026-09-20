const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT_DIR = __dirname;
const OUT_DIR = path.join(ROOT_DIR, '..', 'Release');
const BLOCK_SIZE = 65536; // 64 KB blocks

if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
}

// 1. Gather all files in MetronomeUWP
function getAllFiles(dir, baseDir = dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllFiles(filePath, baseDir));
        } else {
            const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
            // Skip existing generated blockmap / appx files
            if (relPath !== 'AppxBlockMap.xml' && relPath !== '[Content_Types].xml' && !relPath.endsWith('.appx') && !relPath.endsWith('.js')) {
                results.push({ fullPath: filePath, relPath: relPath, size: stat.size });
            }
        }
    });
    return results;
}

// 2. Generate [Content_Types].xml
const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="wav" ContentType="audio/wav" />
  <Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml" />
  <Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml" />
  <Override PartName="/[Content_Types].xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml" />
</Types>`;

fs.writeFileSync(path.join(ROOT_DIR, '[Content_Types].xml'), contentTypesXml, 'utf8');

// 3. Compute BlockMap
function computeFileBlocks(filePath) {
    const buffer = fs.readFileSync(filePath);
    const blocks = [];
    let offset = 0;
    while (offset < buffer.length) {
        const chunk = buffer.slice(offset, offset + BLOCK_SIZE);
        const hash = crypto.createHash('sha256').update(chunk).digest('base64');
        blocks.push({ hash, size: chunk.length });
        offset += BLOCK_SIZE;
    }
    if (buffer.length === 0) {
        const hash = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('base64');
        blocks.push({ hash, size: 0 });
    }
    return blocks;
}

const files = getAllFiles(ROOT_DIR);
// Add [Content_Types].xml to file list
files.unshift({
    fullPath: path.join(ROOT_DIR, '[Content_Types].xml'),
    relPath: '[Content_Types].xml',
    size: fs.statSync(path.join(ROOT_DIR, '[Content_Types].xml')).size
});

let blockMapXml = `<?xml version="1.0" encoding="utf-8"?>
<BlockMap HashMethod="http://www.w3.org/2001/04/xmlenc#sha256" xmlns="http://schemas.microsoft.com/appx/2010/blockmap">
`;

files.forEach(f => {
    // LfhSize is local file header size: 30 bytes + length of relPath
    const lfhSize = 30 + Buffer.byteLength(f.relPath, 'utf8');
    const blocks = computeFileBlocks(f.fullPath);
    blockMapXml += `  <File Name="${f.relPath}" Size="${f.size}" LfhSize="${lfhSize}">\n`;
    blocks.forEach(b => {
        blockMapXml += `    <Block Hash="${b.hash}" Size="${b.size}"/>\n`;
    });
    blockMapXml += `  </File>\n`;
});

blockMapXml += `</BlockMap>`;
fs.writeFileSync(path.join(ROOT_DIR, 'AppxBlockMap.xml'), blockMapXml, 'utf8');

// 4. Create standard zip/appx package
const archiver = require('archiver');
const outAppxPath = path.join(OUT_DIR, 'Metronome_1.0.0.0_Lumia.appx');
const output = fs.createWriteStream(outAppxPath);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
    console.log(`Successfully built APPX package: ${outAppxPath} (${archive.pointer()} total bytes)`);
});

archive.on('error', function (err) {
    throw err;
});

archive.pipe(output);

// Add files to archive with [Content_Types].xml, AppxManifest.xml, and AppxBlockMap.xml first
archive.file(path.join(ROOT_DIR, '[Content_Types].xml'), { name: '[Content_Types].xml' });
archive.file(path.join(ROOT_DIR, 'AppxManifest.xml'), { name: 'AppxManifest.xml' });
archive.file(path.join(ROOT_DIR, 'AppxBlockMap.xml'), { name: 'AppxBlockMap.xml' });

files.forEach(f => {
    if (f.relPath !== '[Content_Types].xml' && f.relPath !== 'AppxManifest.xml' && f.relPath !== 'AppxBlockMap.xml') {
        archive.file(f.fullPath, { name: f.relPath });
    }
});

archive.finalize();
