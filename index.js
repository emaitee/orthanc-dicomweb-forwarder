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

function loadLastChange() {
  try { return parseInt(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return 0; }
}

function saveLastChange(seq) {
  fs.writeFileSync(STATE_FILE, String(seq));
}

// Write a DICOM tag in Explicit VR Little Endian format
function writeTag(group, element, vr, valueBuffer) {
  // Pad value to even length
  let val = valueBuffer;
  if (val.length % 2 !== 0) {
    const padByte = (vr === 'UI') ? 0x00 : 0x20;
    val = Buffer.concat([val, Buffer.from([padByte])]);
  }

  const tag = Buffer.alloc(4);
  tag.writeUInt16LE(group, 0);
  tag.writeUInt16LE(element, 2);

  const vrBuf = Buffer.from(vr, 'ascii');

  // Long VRs (OB, OW, SQ, UC, UN, UR, UT) use 4-byte length with 2 reserved bytes
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

function writeUI(group, element, uid) {
  return writeTag(group, element, 'UI', Buffer.from(uid, 'ascii'));
}

function writeUS(group, element, value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return writeTag(group, element, 'US', buf);
}

function writeUL(group, element, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return writeTag(group, element, 'UL', buf);
}

function writeLO(group, element, str) {
  return writeTag(group, element, 'LO', Buffer.from(str, 'ascii'));
}

function writeCS(group, element, str) {
  return writeTag(group, element, 'CS', Buffer.from(str.trim(), 'ascii'));
}

function writeDA(group, element, str) {
  return writeTag(group, element, 'DA', Buffer.from(str, 'ascii'));
}

function writeTM(group, element, str) {
  return writeTag(group, element, 'TM', Buffer.from(str, 'ascii'));
}

function writeSH(group, element, str) {
  return writeTag(group, element, 'SH', Buffer.from(str, 'ascii'));
}

function writePN(group, element, str) {
  return writeTag(group, element, 'PN', Buffer.from(str, 'ascii'));
}

/**
 * Build a complete, valid DICOM file from scratch using JPEG-compressed pixel data.
 * Transfer Syntax: JPEG Baseline (1.2.840.10008.1.2.4.50)
 * This keeps file size small enough for the remote server's body limit.
 */
async function buildJpegDicom(tags, jpegBuffer) {
  const sopClassUID   = tags.SOPClassUID   || '1.2.840.10008.5.1.4.1.1.7'; // Secondary Capture
  const sopInstanceUID = tags.SOPInstanceUID || `2.25.${Date.now()}`;
  const studyUID      = tags.StudyInstanceUID || `2.25.${Date.now()}1`;
  const seriesUID     = tags.SeriesInstanceUID || `2.25.${Date.now()}2`;
  const rows          = parseInt(tags.Rows);
  const cols          = parseInt(tags.Columns);
  const now           = new Date();
  const dateStr       = now.toISOString().slice(0,10).replace(/-/g,'');
  const timeStr       = now.toISOString().slice(11,19).replace(/:/g,'');

  // Transfer Syntax: JPEG Baseline
  const transferSyntaxUID = '1.2.840.10008.1.2.4.50';

  // ── File Meta Information ──────────────────────────────────────────────────
  const metaVersion    = writeTag(0x0002, 0x0001, 'OB', Buffer.from([0x00, 0x01]));
  const mediaSOPClass  = writeUI(0x0002, 0x0002, sopClassUID);
  const mediaSOPInst   = writeUI(0x0002, 0x0003, sopInstanceUID);
  const transferSyntax = writeUI(0x0002, 0x0010, transferSyntaxUID);
  const implClassUID   = writeUI(0x0002, 0x0012, '1.2.826.0.1.3680043.2.1143.107.104.103.115');
  const implVersion    = writeSH(0x0002, 0x0013, 'ORTHANC_FWD');

  const metaContent = Buffer.concat([metaVersion, mediaSOPClass, mediaSOPInst, transferSyntax, implClassUID, implVersion]);

  // (0002,0000) Group Length
  const groupLenVal = Buffer.alloc(4);
  groupLenVal.writeUInt32LE(metaContent.length, 0);
  const groupLen = writeUL(0x0002, 0x0000, metaContent.length);

  const fullMeta = Buffer.concat([groupLen, metaContent]);

  // ── Dataset ────────────────────────────────────────────────────────────────
  const dataset = Buffer.concat([
    // Patient
    writePN(0x0010, 0x0010, tags.PatientName  || 'Anonymous'),
    writeLO(0x0010, 0x0020, tags.PatientID    || 'UNKNOWN'),
    writeDA(0x0010, 0x0030, tags.PatientBirthDate || ''),
    writeCS(0x0010, 0x0040, tags.PatientSex   || ''),

    // Study
    writeUI(0x0020, 0x000D, studyUID),
    writeDA(0x0008, 0x0020, tags.StudyDate    || dateStr),
    writeTM(0x0008, 0x0030, tags.StudyTime    || timeStr),
    writeLO(0x0008, 0x1030, tags.StudyDescription || ''),
    writeLO(0x0020, 0x0010, tags.StudyID      || '1'),

    // Series
    writeUI(0x0020, 0x000E, seriesUID),
    writeCS(0x0008, 0x0060, tags.Modality     || 'OT'),
    writeDA(0x0008, 0x0021, tags.SeriesDate   || dateStr),
    writeTM(0x0008, 0x0031, tags.SeriesTime   || timeStr),
    writeLO(0x0008, 0x103E, tags.SeriesDescription || ''),
    writeUS(0x0020, 0x0011, parseInt(tags.SeriesNumber) || 1),

    // Instance
    writeUI(0x0008, 0x0016, sopClassUID),
    writeUI(0x0008, 0x0018, sopInstanceUID),
    writeCS(0x0008, 0x0008, 'ORIGINAL\\PRIMARY'),
    writeDA(0x0008, 0x0023, tags.ContentDate  || dateStr),
    writeTM(0x0008, 0x0033, tags.ContentTime  || timeStr),
    writeUS(0x0020, 0x0013, parseInt(tags.InstanceNumber) || 1),

    // Image Pixel Module
    writeUS(0x0028, 0x0002, 3),                    // Samples Per Pixel
    writeCS(0x0028, 0x0004, 'YBR_FULL_422'),       // Photometric (JPEG uses YBR)
    writeUS(0x0028, 0x0010, rows),                 // Rows
    writeUS(0x0028, 0x0011, cols),                 // Columns
    writeUS(0x0028, 0x0100, 8),                    // Bits Allocated
    writeUS(0x0028, 0x0101, 8),                    // Bits Stored
    writeUS(0x0028, 0x0102, 7),                    // High Bit
    writeUS(0x0028, 0x0103, 0),                    // Pixel Representation (unsigned)
    writeUS(0x0028, 0x0006, 0),                    // Planar Configuration (interleaved)
  ]);

  // ── Pixel Data (encapsulated for compressed transfer syntax) ───────────────
  // Encapsulated pixel data: (7FE0,0010) OB with undefined length
  // Format: Item tag (FFFE,E000) + length + jpeg bytes, then Sequence Delimiter
  const pixelDataTag = Buffer.alloc(4);
  pixelDataTag.writeUInt16LE(0x7FE0, 0);
  pixelDataTag.writeUInt16LE(0x0010, 2);
  const pixelVR = Buffer.from('OB', 'ascii');
  const pixelReserved = Buffer.alloc(2, 0);
  const pixelUndefinedLen = Buffer.alloc(4, 0xFF); // 0xFFFFFFFF = undefined length

  // Basic Offset Table item (empty)
  const botTag = Buffer.alloc(4);
  botTag.writeUInt16LE(0xFFFE, 0);
  botTag.writeUInt16LE(0xE000, 2);
  const botLen = Buffer.alloc(4, 0);

  // JPEG fragment item
  const fragTag = Buffer.alloc(4);
  fragTag.writeUInt16LE(0xFFFE, 0);
  fragTag.writeUInt16LE(0xE000, 2);
  const fragLen = Buffer.alloc(4);
  // Pad JPEG to even length if needed
  let jpegPadded = jpegBuffer;
  if (jpegBuffer.length % 2 !== 0) {
    jpegPadded = Buffer.concat([jpegBuffer, Buffer.from([0x00])]);
  }
  fragLen.writeUInt32LE(jpegPadded.length, 0);

  // Sequence Delimiter
  const seqDelimTag = Buffer.alloc(4);
  seqDelimTag.writeUInt16LE(0xFFFE, 0);
  seqDelimTag.writeUInt16LE(0xE0DD, 2);
  const seqDelimLen = Buffer.alloc(4, 0);

  const pixelData = Buffer.concat([
    pixelDataTag, pixelVR, pixelReserved, pixelUndefinedLen,
    botTag, botLen,
    fragTag, fragLen, jpegPadded,
    seqDelimTag, seqDelimLen,
  ]);

  // ── Preamble ───────────────────────────────────────────────────────────────
  const preamble = Buffer.alloc(128, 0);
  const magic = Buffer.from('DICM', 'ascii');

  return Buffer.concat([preamble, magic, fullMeta, dataset, pixelData]);
}

async function forwardInstance(instanceId) {
  try {
    console.log(`\n📋 Processing instance: ${instanceId}`);

    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    const rows    = parseInt(tags.Rows);
    const cols    = parseInt(tags.Columns);
    const samples = parseInt(tags.SamplesPerPixel);
    const bits    = parseInt(tags.BitsAllocated);
    const photometric = tags.PhotometricInterpretation;

    console.log(`   Photometric : ${photometric}`);
    console.log(`   Dimensions  : ${rows}x${cols}`);
    console.log(`   Bits        : ${bits}  Samples: ${samples}`);

    // Get raw pixel data from Orthanc (uncompressed bitmap)
    const { data: pixelData } = await ORTHANC.get(
      `/instances/${instanceId}/frames/0/raw`,
      { responseType: 'arraybuffer' }
    );
    const pixelBuffer = Buffer.from(pixelData);
    console.log(`   Raw pixel data: ${pixelBuffer.length} bytes`);

    // Convert raw pixel data to JPEG using sharp
    let jpegBuffer;
    if (samples === 3 && photometric === 'RGB') {
      // RGB image
      jpegBuffer = await sharp(pixelBuffer, {
        raw: { width: cols, height: rows, channels: 3 }
      })
        .jpeg({ quality: 90 })
        .toBuffer();
    } else if (samples === 1) {
      // Grayscale image
      jpegBuffer = await sharp(pixelBuffer, {
        raw: { width: cols, height: rows, channels: 1 }
      })
        .jpeg({ quality: 90 })
        .toBuffer();
    } else {
      throw new Error(`Unsupported image: ${samples} samples, ${photometric}`);
    }

    console.log(`   JPEG size: ${jpegBuffer.length} bytes (was ${pixelBuffer.length})`);

    // Build a complete valid DICOM file with JPEG pixel data
    const dicomBuffer = await buildJpegDicom(tags, jpegBuffer);
    console.log(`   DICOM file size: ${dicomBuffer.length} bytes`);

    // Send via STOW-RS
    const boundary = `DICOMwebBoundary${Date.now()}`;
    const CRLF = '\r\n';
    const partHeader = Buffer.from(`--${boundary}${CRLF}Content-Type: application/dicom${CRLF}${CRLF}`, 'utf8');
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

    console.log(`   ✅ Forwarded successfully`);
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
