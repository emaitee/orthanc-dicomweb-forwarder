require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const dcmjs = require('dcmjs');
const { DicomMetaDictionary, DicomDict } = dcmjs.data;

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

async function forwardInstance(instanceId) {
  try {
    // Get instance metadata
    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    
    console.log(`\n📋 Processing instance: ${instanceId}`);
    console.log(`   Transfer Syntax: ${tags.TransferSyntaxUID || 'Missing/Unknown'}`);
    console.log(`   Dimensions: ${tags.Rows}x${tags.Columns}`);
    console.log(`   Photometric: ${tags.PhotometricInterpretation || 'Unknown'}`);
    console.log(`   Bits Allocated: ${tags.BitsAllocated}`);
    console.log(`   Samples Per Pixel: ${tags.SamplesPerPixel}`);
    console.log(`   Planar Configuration: ${tags.PlanarConfiguration !== undefined ? tags.PlanarConfiguration : 'Not set'}`);
    
    // Get the original DICOM file
    const { data: originalData } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
    let dicomBuffer = Buffer.from(originalData);
    
    // If Transfer Syntax is missing, we need to add it
    if (!tags.TransferSyntaxUID || tags.TransferSyntaxUID === 'Unknown') {
      console.log(`   ⚙️  Adding missing Transfer Syntax UID...`);
      
      try {
        // Parse the DICOM file
        const dicomData = dcmjs.data.DicomMessage.readFile(dicomBuffer.buffer);
        const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicomData.dict);
        
        // Determine appropriate Transfer Syntax based on image characteristics
        let transferSyntaxUID;
        
        if (tags.PhotometricInterpretation === 'RGB' || tags.SamplesPerPixel === 3) {
          // RGB images - use Explicit VR Little Endian
          transferSyntaxUID = '1.2.840.10008.1.2.1';
          console.log(`   Setting Transfer Syntax to Explicit VR Little Endian (RGB)`);
        } else if (tags.BitsAllocated === 8) {
          // 8-bit grayscale - Explicit VR Little Endian
          transferSyntaxUID = '1.2.840.10008.1.2.1';
          console.log(`   Setting Transfer Syntax to Explicit VR Little Endian (8-bit)`);
        } else {
          // Default to Explicit VR Little Endian
          transferSyntaxUID = '1.2.840.10008.1.2.1';
          console.log(`   Setting Transfer Syntax to Explicit VR Little Endian (default)`);
        }
        
        // Add/update the Transfer Syntax UID in the meta information
        if (!dataset._meta) {
          dataset._meta = {};
        }
        dataset._meta.TransferSyntaxUID = { Value: [transferSyntaxUID], vr: 'UI' };
        
        // Ensure other required meta information elements are present
        if (!dataset._meta.FileMetaInformationVersion) {
          dataset._meta.FileMetaInformationVersion = { Value: [new Uint8Array([0, 1]).buffer], vr: 'OB' };
        }
        if (!dataset._meta.MediaStorageSOPClassUID && dataset.SOPClassUID) {
          dataset._meta.MediaStorageSOPClassUID = { Value: [dataset.SOPClassUID], vr: 'UI' };
        }
        if (!dataset._meta.MediaStorageSOPInstanceUID && dataset.SOPInstanceUID) {
          dataset._meta.MediaStorageSOPInstanceUID = { Value: [dataset.SOPInstanceUID], vr: 'UI' };
        }
        if (!dataset._meta.ImplementationClassUID) {
          dataset._meta.ImplementationClassUID = { Value: ['1.2.840.10008.5.1.4.1.1.1'], vr: 'UI' };
        }
        
        // Ensure PlanarConfiguration is set correctly for RGB images
        if (tags.PhotometricInterpretation === 'RGB' && tags.SamplesPerPixel === 3) {
          if (!dataset.PlanarConfiguration || dataset.PlanarConfiguration !== 0) {
            console.log(`   Setting PlanarConfiguration to 0 (interleaved)`);
            dataset.PlanarConfiguration = 0;
          }
        }
        
        // Denaturalize and write the corrected DICOM file
        const denaturalizedDataset = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset);
        const dicomDict = new DicomDict(denaturalizedDataset);
        dicomDict.dict = denaturalizedDataset;
        
        const outputBuffer = dicomDict.write();
        dicomBuffer = Buffer.from(outputBuffer);
        
        console.log(`   ✓ Transfer Syntax UID added successfully`);
      } catch (fixErr) {
        console.error(`   ❌ Failed to fix DICOM file: ${fixErr.message}`);
        console.log(`   Using original file (may not render correctly)`);
      }
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
