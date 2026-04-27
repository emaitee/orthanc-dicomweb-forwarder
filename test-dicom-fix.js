require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const ORTHANC = axios.create({
  baseURL: process.env.ORTHANC_URL,
  auth: { username: process.env.ORTHANC_USER, password: process.env.ORTHANC_PASS },
});

async function testFix() {
  // Get the problematic instance ID
  const instanceId = 'be6b75df-fde6ab0b-c3f456e4-6a1697b2-5f63fd9b';
  
  console.log('Downloading original DICOM file...');
  const { data: originalData } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
  fs.writeFileSync('./original.dcm', Buffer.from(originalData));
  console.log('✓ Saved as original.dcm');
  
  console.log('\nTrying Orthanc anonymize endpoint to fix Transfer Syntax...');
  try {
    const { data: anonymized } = await ORTHANC.post(
      `/instances/${instanceId}/anonymize`,
      {
        Replace: {},
        Keep: ['PatientName', 'PatientID', 'StudyDescription', 'SeriesDescription'],
        Force: true
      },
      { responseType: 'arraybuffer' }
    );
    fs.writeFileSync('./fixed-anonymize.dcm', Buffer.from(anonymized));
    console.log('✓ Saved as fixed-anonymize.dcm');
  } catch (err) {
    console.error('✗ Anonymize failed:', err.message);
  }
  
  console.log('\nTrying to reconstruct with proper metadata...');
  try {
    // Get tags
    const { data: tags } = await ORTHANC.get(`/instances/${instanceId}/tags?simplify`);
    
    // Create a new instance with explicit transfer syntax
    const modifyPayload = {
      Replace: {
        TransferSyntaxUID: '1.2.840.10008.1.2.1' // Explicit VR Little Endian
      },
      Force: true,
      KeepSource: false
    };
    
    const { data: modifiedResponse } = await ORTHANC.post(
      `/instances/${instanceId}/modify`,
      modifyPayload
    );
    
    if (modifiedResponse.ID) {
      const { data: modifiedData } = await ORTHANC.get(
        `/instances/${modifiedResponse.ID}/file`,
        { responseType: 'arraybuffer' }
      );
      fs.writeFileSync('./fixed-modify.dcm', Buffer.from(modifiedData));
      console.log('✓ Saved as fixed-modify.dcm');
      
      // Clean up
      await ORTHANC.delete(`/instances/${modifiedResponse.ID}`);
    }
  } catch (err) {
    console.error('✗ Modify failed:', err.message);
  }
  
  console.log('\nTest complete. Upload one of the fixed files to your DICOMweb server manually to test.');
}

testFix().catch(console.error);
