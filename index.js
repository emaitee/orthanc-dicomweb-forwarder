require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const sharp = require('sharp');

const ORTHANC = axios.create({
  baseURL: process.env.ORTHANC_URL,
  auth: { username: process.env.ORTHANC_USER, password: process.env.ORTHANC_PASS },
});

const STOW_URL = process.env.DICOMWEB_STOW_URL;
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 5000;
const STATE_FILE = './last-change.txt';

// Remote server body limit is ~1MB (fastify default).
// We target 800KB for the full DICOM file to stay safely under.
const MAX_PIXEL_BYTES = 800 * 1024;

function loadLastChange() {
  try { return parseInt(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return 0; }
}

function saveLastChange(seq) {
  fs.writeFileSync(STATE_FILE, String(seq));
}

// Write a DICOM tag in Explicit VR Little Endian format
function writeTag(group, element, vr, valueBuffer) {
  let val = valueBuffer;
  if (val.length % 2 !== 0) {
    const padByte = (vr === 'UI') ? 0x00 : 0x20;
    val = Buffer.concat([val, Buffer.from([padByte])]);
  }
  const tag = Buffer.alloc(4);
  tag.writeUInt16LE(group, 0);
  tag.writeUInt16LE(element, 2);
  const vrBuf = Buffer.from(vr, 'ascii');
  const longVRs = ['OB', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT'];
  if (longVRs.includes(vr)) {
    const reserved = Buffer.alloc(2, 0);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(val.length, 0);
    return Buffer.concat([tag, vrBuf, reserved, len, val]);
  } else {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(val.length, 0);
    return Buffer.concat([tag, vrBuf, len, val]);
  }
}

const writeUI = (g, e, v) => writeTag(g, e, 'UI', Buffer.from(v, 'ascii'));
const writeUS = (g, e, v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return writeTag(g, e, 'US', b); };
const writeUL = (g, e, v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return writeTag(g, e, 'UL', b); };
const writeLO = (g, e, v) => writeTag(g, e, 'LO', Buffer.from(String(v || ''), 'ascii'));
const writeCS = (g, e, v) => writeTag(g, e, 'CS', Buffer.from(String(v || '').trim(), 'ascii'));
const writeDA = (g, e, v) => writeTag(g, e, 'DA', Buffer.from(String(v || ''), 'ascii'));
const writeTM = (g, e, v) => writeTag(g, e, 'TM', Buffer.from(String(v || ''), 'ascii'));
const writeSH = (g, e, v) => writeTag(g, e, 'SH', Buffer.from(String(v || ''), 'ascii'));
const writePN = (g, e, v) => writeTag(g, e, 'PN', Buffer.from(String(v || ''), 'ascii'));

/**
 * Build a complete valid DICOM file with UNCOMPRESSED pixel data.
 * Transfer Syntax: Explicit VR Little Endian (1.2.840.10008.1.2.1)
 *
 * The dcmjs-org/dicomweb-server has a bug where it cannot serve encapsulated
 * (JPEG/compressed) pixel data via WADO-RS frames endpoint - it returns ~304 bytes
 * instead of the actual frame. Uncompressed data works correctly.
 */
function buildUncompressedDicom(tags, pixelBuffer, rows, cols, samplesPerPixel, isGrayscale) {
  const sopClassUID    = tags.SOPClassUID    || '1.2.840.10008.5.1.4.1.1.7';
  const sopInstanceUID = tags.SOPInstanceUID || `2.25.${Date.now()}`;
  const studyUID       = tags.StudyInstanceUID  || `2.25.${Date.now()}1`;
  const seriesUID      = tags.SeriesInstanceUID || `2.25.${Date.now()}2`;
  const now            = new Date();
  const dateStr        = now.toISOString().slice(0,10).replace(/-/g,'');
  const timeStr        = now.toISOString().slice(11,19).replace(/:/g,'');

  // Explicit VR Little Endian - uncompressed, works with dcmjs-org/dicomweb-server
  const transferSyntaxUID = '1.2.840.10008.1.2.1';
  const photometric = isGrayscale ? 'MONOCHROME2' : 'RGB';

  // ── File Meta Information ──────────────────────────────────────────────────
  const metaContent = Buffer.concat([
    writeTag(0x0002, 0x0001, 'OB', Buffer.from([0x00, 0x01])),  // Meta Version
    writeUI(0x0002, 0x0002, sopClassUID),                        // Media Storage SOP Class
    writeUI(0x0002, 0x0003, sopInstanceUID),                     // Media Storage SOP Instance
    writeUI(0x0002, 0x0010, transferSyntaxUID),                  // Transfer Syntax UID
    writeUI(0x0002, 0x0012, '1.2.826.0.1.3680043.2.1143.107.104.103.115'), // Impl Class UID
    writeSH(0x0002, 0x0013, 'ORTHANC_FWD'),                     // Impl Version Name
  ]);
  const fullMeta = Buffer.concat([
    writeUL(0x0002, 0x0000, metaContent.length),  // Group Length
    metaContent,
  ]);

  // ── Dataset ────────────────────────────────────────────────────────────────
  const dataset = Buffer.concat([
    // Patient
    writePN(0x0010, 0x0010, tags.PatientName       || 'Anonymous'),
    writeLO(0x0010, 0x0020, tags.PatientID         || 'UNKNOWN'),
    writeDA(0x0010, 0x0030, tags.PatientBirthDate  || ''),
    writeCS(0x0010, 0x0040, tags.PatientSex        || ''),

    // General Study
    writeUI(0x0020, 0x000D, studyUID),
    writeDA(0x0008, 0x0020, tags.StudyDate         || dateStr),
    writeTM(0x0008, 0x0030, tags.StudyTime         || timeStr),
    writeLO(0x0008, 0x1030, tags.StudyDescription  || ''),
    writeLO(0x0020, 0x0010, tags.StudyID           || '1'),

    // General Series
    writeUI(0x0020, 0x000E, seriesUID),
    writeCS(0x0008, 0x0060, tags.Modality          || 'OT'),
    writeDA(0x0008, 0x0021, tags.SeriesDate        || dateStr),
    writeTM(0x0008, 0x0031, tags.SeriesTime        || timeStr),
    writeLO(0x0008, 0x103E, tags.SeriesDescription || ''),
    writeUS(0x0020, 0x0011, parseInt(tags.SeriesNumber) || 1),

    // SOP Common
    writeUI(0x0008, 0x0016, sopClassUID),
    writeUI(0x0008, 0x0018, sopInstanceUID),
    writeCS(0x0008, 0x0008, 'ORIGINAL\\PRIMARY'),
    writeDA(0x0008, 0x0023, tags.ContentDate       || dateStr),
    writeTM(0x0008, 0x0033, tags.ContentTime       || timeStr),
    writeUS(0x0020, 0x0013, parseInt(tags.InstanceNumber) || 1),

    // Image Pixel Module - must exactly match the pixel buffer
    writeUS(0x0028, 0x0002, samplesPerPixel),                    // Samples Per Pixel
    writeCS(0x0028, 0x0004, photometric),                        // Photometric Interpretation
    writeUS(0x0028, 0x0010, rows),                               // Rows
    writeUS(0x0028, 0x0011, cols),                               // Columns
    writeUS(0x0028, 0x0100, 8),                                  // Bits Allocated
    writeUS(0x0028, 0x0101, 8),                                  // Bits Stored
    writeUS(0x0028, 0x0102, 7),                                  // High Bit
    writeUS(0x0028, 0x0103, 0),                                  // Pixel Representation
    ...(isGrayscale ? [] : [writeUS(0x0028, 0x0006, 0)]),        // Planar Config (RGB only)
  ]);

  // ── Pixel Data (OW, uncompressed, fixed length) ────────────────────────────
  // Pad to even length
  let pixPadded = pixelBuffer;
  if (pixelBuffer.length % 2 !== 0) {
    pixPadded = Buffer.concat([pixelBuffer, Buffer.from([0x00])]);
  }
  const pixelDataElement = writeTag(0x7FE0, 0x0010, 'OW', pixPadded);

  // ── Preamble ───────────────────────────────────────────────────────────────
  const preamble = Buffer.alloc(128, 0);
  const magic    = Buffer.from('DICM', 'ascii');

  return Buffer.concat([preamble, magic, fullMeta, dataset, pixelDataElement]);
}

async function forwardInstance(instanceId) {
  try {
    console.log(`\n📋 Processing instance: ${instanceId}`);

    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    let rows    = parseInt(tags.Rows);
    let cols    = parseInt(tags.Columns);
    const samples    = parseInt(tags.SamplesPerPixel);
    const bits       = parseInt(tags.BitsAllocated);
    const photometric = tags.PhotometricInterpretation;
    const isGrayscale = samples === 1;

    console.log(`   Photometric : ${photometric}`);
    console.log(`   Dimensions  : ${rows}x${cols}`);
    console.log(`   Bits        : ${bits}  Samples: ${samples}`);

    // Get raw uncompressed pixel data from Orthanc
    const { data: pixelData } = await ORTHANC.get(
      `/instances/${instanceId}/frames/0/raw`,
      { responseType: 'arraybuffer' }
    );
    let pixelBuffer = Buffer.from(pixelData);
    console.log(`   Raw pixel data: ${pixelBuffer.length} bytes`);

    // Check if we need to downscale to fit under the server's body limit
    const rawSize = rows * cols * samples;
    if (rawSize > MAX_PIXEL_BYTES) {
      // Calculate scale factor to fit within limit
      const scaleFactor = Math.sqrt(MAX_PIXEL_BYTES / rawSize);
      const newRows = Math.floor(rows * scaleFactor / 2) * 2; // keep even
      const newCols = Math.floor(cols * scaleFactor / 2) * 2;

      console.log(`   ⚙️  Downscaling ${rows}x${cols} → ${newRows}x${newCols} to fit server limit`);

      // Use sharp to resize and get raw pixel buffer
      const sharpInput = sharp(pixelBuffer, {
        raw: { width: cols, height: rows, channels: samples }
      });

      pixelBuffer = await sharpInput
        .resize(newCols, newRows)
        .raw()
        .toBuffer();

      rows = newRows;
      cols = newCols;
      console.log(`   Resized pixel data: ${pixelBuffer.length} bytes`);
    }

    // Build complete DICOM file with uncompressed pixel data
    const dicomBuffer = buildUncompressedDicom(tags, pixelBuffer, rows, cols, samples, isGrayscale);
    console.log(`   DICOM file size: ${dicomBuffer.length} bytes`);

    // Send via STOW-RS with proper multipart/related
    const boundary = `DICOMwebBoundary${Date.now()}`;
    const CRLF = '\r\n';
    const partHeader = Buffer.from(
      `--${boundary}${CRLF}Content-Type: application/dicom${CRLF}${CRLF}`,
      'utf8'
    );
    const partFooter = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
    const body = Buffer.concat([partHeader, dicomBuffer, partFooter]);

    const response = await axios.post(STOW_URL, body, {
      headers: {
        'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
        'Accept': 'application/dicom+json',
        'Content-Length': body.length,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    console.log(`   ✅ Forwarded successfully (${dicomBuffer.length} bytes)`);
    if (response.data) {
      console.log(`   Response:`, JSON.stringify(response.data).substring(0, 300));
    }
  } catch (err) {
    console.error(`   ❌ Error forwarding ${instanceId}:`, err.message);
    if (err.response) {
      console.error(`   HTTP ${err.response.status}:`, JSON.stringify(err.response.data).substring(0, 500));
    }
  }
}

async function poll() {
  let since = loadLastChange();
  try {
    const { data } = await ORTHANC.get(`/changes?since=${since}&limit=100`);
    for (const change of data.Changes) {
      if (change.ChangeType === 'NewInstance') {
        await forwardInstance(change.ID);
      }
      since = change.Seq;
    }
    if (data.Changes.length > 0) saveLastChange(since);
  } catch (err) {
    console.error('Poll error:', err.message);
  }
}

console.log('Orthanc → DICOMweb forwarder started');
setInterval(poll, POLL_MS);
poll();
