require('dotenv').config();
const axios = require('axios');
const FormData = require('form-data');
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

async function forwardInstance(instanceId) {
  // Get the DICOM file from Orthanc
  const { data } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
  
  // Create multipart/related form with proper DICOMweb STOW-RS format
  const form = new FormData();
  const dicomBuffer = Buffer.from(data);
  
  // Append with correct content type for DICOMweb
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
  
  await axios.post(STOW_URL, form, { 
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  
  console.log(`Forwarded: ${instanceId}`);
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
