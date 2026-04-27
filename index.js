require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const dicomParser = require('dicom-parser');

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

function validateDicomDimensions(dataSet) {
  try {
    const rows = dataSet.uint16('x00280010'); // Rows
    const cols = dataSet.uint16('x00280011'); // Columns
    const samplesPerPixel = dataSet.uint16('x00280002') || 1; // Samples per Pixel
    const bitsAllocated = dataSet.uint16('x00280100'); // Bits Allocated
    const pixelDataElement = dataSet.elements.x7fe00010;
    
    if (!pixelDataElement) {
      throw new Error('No pixel data found');
    }
    
    const pixelDataLength = pixelDataElement.length;
    const expectedSize = rows * cols * samplesPerPixel * (bitsAllocated / 8);
    
    console.log(`DICOM validation: ${rows}x${cols}, ${samplesPerPixel} samples, ${bitsAllocated} bits`);
    console.log(`Pixel data: ${pixelDataLength} bytes, expected: ${expectedSize} bytes`);
    
    // Check if dimensions match
    if (Math.abs(pixelDataLength - expectedSize) > 1) {
      console.warn(`⚠️  Pixel data size mismatch! This may cause rendering issues.`);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Validation error:', err.message);
    return false;
  }
}

async function forwardInstance(instanceId) {
  try {
    // First, check if we need to transcode the image
    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    
    console.log(`\n📋 Processing instance: ${instanceId}`);
    console.log(`   Transfer Syntax: ${tags.TransferSyntaxUID || 'Unknown'}`);
    console.log(`   Dimensions: ${tags.Rows}x${tags.Columns}`);
    console.log(`   Photometric: ${tags.PhotometricInterpretation || 'Unknown'}`);
    
    // Get the DICOM file - try to get uncompressed version
    let dicomBuffer;
    const transferSyntax = tags.TransferSyntaxUID;
    
    // List of compressed transfer syntaxes that might cause issues
    const compressedSyntaxes = [
      '1.2.840.10008.1.2.4.50',  // JPEG Baseline
      '1.2.840.10008.1.2.4.51',  // JPEG Extended
      '1.2.840.10008.1.2.4.57',  // JPEG Lossless
      '1.2.840.10008.1.2.4.70',  // JPEG Lossless First Order
      '1.2.840.10008.1.2.4.80',  // JPEG-LS Lossless
      '1.2.840.10008.1.2.4.81',  // JPEG-LS Lossy
      '1.2.840.10008.1.2.4.90',  // JPEG 2000 Lossless
      '1.2.840.10008.1.2.4.91',  // JPEG 2000
      '1.2.840.10008.1.2.5',     // RLE Lossless
    ];
    
    // If compressed, try to get uncompressed version from Orthanc
    if (compressedSyntaxes.includes(transferSyntax)) {
      console.log(`   ⚙️  Transcoding compressed image to uncompressed...`);
      try {
        // Request uncompressed transfer syntax (Explicit VR Little Endian)
        const { data } = await ORTHANC.post(
          `/instances/${instanceId}/export`,
          { Transcode: '1.2.840.10008.1.2.1' }, // Explicit VR Little Endian
          { responseType: 'arraybuffer' }
        );
        dicomBuffer = Buffer.from(data);
        console.log(`   ✓ Transcoded successfully`);
      } catch (transcodeErr) {
        console.log(`   ⚠️  Transcoding failed, using original: ${transcodeErr.message}`);
        const { data } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
        dicomBuffer = Buffer.from(data);
      }
    } else {
      // Already uncompressed or unknown, use as-is
      const { data } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
      dicomBuffer = Buffer.from(data);
    }
    
    // Validate the DICOM data
    try {
      const dataSet = dicomParser.parseDicom(new Uint8Array(dicomBuffer));
      const isValid = validateDicomDimensions(dataSet);
      if (!isValid) {
        console.warn(`   ⚠️  DICOM validation failed - may not render correctly`);
      }
    } catch (parseErr) {
      console.warn(`   ⚠️  Could not parse DICOM for validation: ${parseErr.message}`);
    }
    
    // Create multipart/related form with proper DICOMweb STOW-RS format
    const form = new FormData();
    
    form.append('file', dicomBuffer, {
      filename: `${instanceId}.dcm`,
      contentType: 'application/dicom',
      knownLength: dicomBuffer.length
    });
    
    // Get form headers and modify Content-Type to multipart/related
    const headers = form.getHeaders();
    const boundary = headers['content-type'].split('boundary=')[1];
    headers['content-type'] = `multipart/related; type="application/dicom"; boundary=${boundary}`;
    headers['accept'] = 'application/dicom+json';
    
    const response = await axios.post(STOW_URL, form, { 
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    
    console.log(`   ✅ Forwarded successfully`);
    if (response.data) {
      console.log(`   Response:`, JSON.stringify(response.data).substring(0, 200));
    }
  } catch (err) {
    console.error(`   ❌ Error forwarding ${instanceId}:`, err.message);
    if (err.response) {
      console.error(`   Server response:`, err.response.status, err.response.statusText);
      if (err.response.data) {
        console.error(`   Response data:`, err.response.data.toString().substring(0, 500));
      }
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
    console.error('Error:', err.message);
  }
}

console.log('Orthanc → DICOMweb forwarder started');
setInterval(poll, POLL_MS);
poll();
