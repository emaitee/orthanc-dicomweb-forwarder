require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

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

/**
 * Manually patch the DICOM file binary to inject a proper File Meta Information header
 * with Transfer Syntax UID = 1.2.840.10008.1.2.1 (Explicit VR Little Endian).
 *
 * This is done at the binary level to avoid any library re-encoding the pixel data.
 */
function patchDicomBuffer(inputBuffer, sopClassUID, sopInstanceUID) {
  // DICOM preamble: 128 bytes of zeros + "DICM" magic
  const preamble = Buffer.alloc(132, 0);
  preamble.write('DICM', 128, 'ascii');

  // Helper to encode a DICOM tag + VR + value in Explicit VR Little Endian
  function encodeTag(group, element, vr, value) {
    const valBuf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'ascii');
    // Pad to even length
    let padded = valBuf;
    if (valBuf.length % 2 !== 0) {
      const p = Buffer.alloc(valBuf.length + 1, 0x20); // pad with space
      valBuf.copy(p);
      padded = p;
    }
    const tag = Buffer.alloc(4);
    tag.writeUInt16LE(group, 0);
    tag.writeUInt16LE(element, 2);
    const vrBuf = Buffer.from(vr, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(padded.length, 0);
    return Buffer.concat([tag, vrBuf, len, padded]);
  }

  // (0002,0001) File Meta Information Version
  const metaVersion = encodeTag(0x0002, 0x0001, 'OB', Buffer.from([0x00, 0x01]));

  // (0002,0002) Media Storage SOP Class UID
  const mediaSOPClass = encodeTag(0x0002, 0x0002, 'UI',
    sopClassUID || '1.2.840.10008.5.1.4.1.1.7'); // Secondary Capture as fallback

  // (0002,0003) Media Storage SOP Instance UID
  const mediaSOPInstance = encodeTag(0x0002, 0x0003, 'UI',
    sopInstanceUID || '1.2.840.10008.5.1.4.1.1.7.1');

  // (0002,0010) Transfer Syntax UID = Explicit VR Little Endian
  const transferSyntax = encodeTag(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1');

  // (0002,0012) Implementation Class UID
  const implClassUID = encodeTag(0x0002, 0x0012, 'UI', '1.2.840.10008.5.1.4.1.1.1');

  // (0002,0013) Implementation Version Name
  const implVersion = encodeTag(0x0002, 0x0013, 'SH', 'ORTHANC_FWD_1.0');

  // Build meta group content (without the group length tag itself)
  const metaContent = Buffer.concat([
    metaVersion,
    mediaSOPClass,
    mediaSOPInstance,
    transferSyntax,
    implClassUID,
    implVersion,
  ]);

  // (0002,0000) File Meta Information Group Length
  const groupLenBuf = Buffer.alloc(4);
  groupLenBuf.writeUInt32LE(metaContent.length, 0);
  const groupLenTag = Buffer.alloc(4);
  groupLenTag.writeUInt16LE(0x0002, 0);
  groupLenTag.writeUInt16LE(0x0000, 2);
  const groupLenVR = Buffer.from('UL', 'ascii');
  const groupLenLen = Buffer.alloc(4);
  groupLenLen.writeUInt32LE(4, 0);
  const groupLengthElement = Buffer.concat([groupLenTag, groupLenVR, groupLenLen, groupLenBuf]);

  const fullMeta = Buffer.concat([groupLengthElement, metaContent]);

  // Now strip any existing meta header from the input buffer and keep only the dataset
  let datasetStart = 0;
  if (inputBuffer.slice(128, 132).toString('ascii') === 'DICM') {
    // Has preamble - skip it and read group length to find dataset start
    const existingGroupLen = inputBuffer.readUInt32LE(140); // after tag(4)+VR(2)+len(2) or tag(4)+VR(2)+reserved(2)+len(4)
    // Try to find where group 0002 ends by scanning for first non-0002 tag
    let pos = 132;
    while (pos + 4 <= inputBuffer.length) {
      const grp = inputBuffer.readUInt16LE(pos);
      if (grp !== 0x0002) {
        datasetStart = pos;
        break;
      }
      const elem = inputBuffer.readUInt16LE(pos + 2);
      const vr = inputBuffer.slice(pos + 4, pos + 6).toString('ascii');
      let tagLen, tagHeaderSize;
      if (['OB','OW','SQ','UC','UN','UR','UT'].includes(vr)) {
        tagLen = inputBuffer.readUInt32LE(pos + 8);
        tagHeaderSize = 12;
      } else {
        tagLen = inputBuffer.readUInt16LE(pos + 6);
        tagHeaderSize = 8;
      }
      pos += tagHeaderSize + tagLen;
    }
    if (datasetStart === 0) datasetStart = 132; // fallback
  }
  // else: no preamble, treat entire buffer as dataset

  const dataset = inputBuffer.slice(datasetStart);

  return Buffer.concat([preamble, fullMeta, dataset]);
}

async function forwardInstance(instanceId) {
  try {
    console.log(`\n📋 Processing instance: ${instanceId}`);

    // Get tags to extract SOPClassUID and SOPInstanceUID
    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    const transferSyntax = tags.TransferSyntaxUID;
    const photometric = tags.PhotometricInterpretation;

    console.log(`   Transfer Syntax : ${transferSyntax || 'MISSING'}`);
    console.log(`   Photometric     : ${photometric}`);
    console.log(`   Dimensions      : ${tags.Rows}x${tags.Columns}`);
    console.log(`   Bits Allocated  : ${tags.BitsAllocated}`);
    console.log(`   Samples/Pixel   : ${tags.SamplesPerPixel}`);

    // Download raw DICOM file
    const { data: rawData } = await ORTHANC.get(
      `/instances/${instanceId}/file`,
      { responseType: 'arraybuffer' }
    );
    let dicomBuffer = Buffer.from(rawData);

    // If Transfer Syntax UID is missing, patch the file meta header at binary level
    if (!transferSyntax) {
      console.log(`   ⚙️  Patching missing File Meta Information header...`);
      dicomBuffer = patchDicomBuffer(
        dicomBuffer,
        tags.SOPClassUID,
        tags.SOPInstanceUID
      );
      console.log(`   ✓ Patched. New buffer size: ${dicomBuffer.length} bytes`);
    }

    // Build a proper multipart/related STOW-RS request manually
    const boundary = `DICOMwebBoundary${Date.now()}`;
    const CRLF = '\r\n';

    const partHeader = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Type: application/dicom${CRLF}` +
      `${CRLF}`,
      'utf8'
    );
    const partFooter = Buffer.from(
      `${CRLF}--${boundary}--${CRLF}`,
      'utf8'
    );

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
