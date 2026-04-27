require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const ORTHANC = axios.create({
  baseURL: process.env.ORTHANC_URL,
  auth: { username: process.env.ORTHANC_USER, password: process.env.ORTHANC_PASS },
});

async function diagnose() {
  const instanceId = 'be6b75df-fde6ab0b-c3f456e4-6a1697b2-5f63fd9b';
  
  console.log('=== DICOM File Diagnostic ===\n');
  
  // Get full tags (not simplified)
  const { data: fullTags } = await ORTHANC.get(`/instances/${instanceId}/tags`);
  
  console.log('Transfer Syntax UID:', fullTags['0002,0010']?.Value || 'MISSING');
  console.log('Rows:', fullTags['0028,0010']?.Value);
  console.log('Columns:', fullTags['0028,0011']?.Value);
  console.log('Samples Per Pixel:', fullTags['0028,0002']?.Value);
  console.log('Photometric Interpretation:', fullTags['0028,0004']?.Value);
  console.log('Planar Configuration:', fullTags['0028,0006']?.Value || 'NOT SET');
  console.log('Bits Allocated:', fullTags['0028,0100']?.Value);
  console.log('Bits Stored:', fullTags['0028,0101']?.Value);
  console.log('High Bit:', fullTags['0028,0102']?.Value);
  console.log('Pixel Representation:', fullTags['0028,0103']?.Value);
  
  // Check pixel data
  const pixelData = fullTags['7fe0,0010'];
  if (pixelData) {
    console.log('\nPixel Data VR:', pixelData.vr);
    console.log('Pixel Data Length:', pixelData.Value?.[0]?.length || 'Unknown');
  } else {
    console.log('\n⚠️  NO PIXEL DATA FOUND!');
  }
  
  // Calculate expected size
  const rows = parseInt(fullTags['0028,0010']?.Value?.[0]);
  const cols = parseInt(fullTags['0028,0011']?.Value?.[0]);
  const samples = parseInt(fullTags['0028,0002']?.Value?.[0]);
  const bitsAlloc = parseInt(fullTags['0028,0100']?.Value?.[0]);
  
  const expectedSize = rows * cols * samples * (bitsAlloc / 8);
  console.log(`\nExpected pixel data size: ${expectedSize} bytes`);
  console.log(`Formula: ${rows} × ${cols} × ${samples} × (${bitsAlloc}/8) = ${expectedSize}`);
  
  // Download file and check actual size
  const { data: fileData } = await ORTHANC.get(`/instances/${instanceId}/file`, { responseType: 'arraybuffer' });
  console.log(`\nActual DICOM file size: ${fileData.byteLength} bytes`);
  
  // Save for manual inspection
  fs.writeFileSync('./diagnostic.dcm', Buffer.from(fileData));
  console.log('\n✓ Saved as diagnostic.dcm for manual inspection');
  
  console.log('\n=== Recommendation ===');
  console.log('The issue is that this DICOM file is missing the Transfer Syntax UID.');
  console.log('This is required by the DICOM standard and OHIF viewer.');
  console.log('\nPossible solutions:');
  console.log('1. Re-export the image from the original source with proper DICOM encoding');
  console.log('2. Use DCMTK tools to fix the file: dcmodify --insert-tuid diagnostic.dcm');
  console.log('3. Configure Orthanc to add Transfer Syntax on import');
}

diagnose().catch(console.error);
