/**
 * Simulates what OHIF does when it retrieves an image from the DICOMweb server.
 * Run this AFTER uploading an image to see what the server returns.
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const BASE_URL = process.env.DICOMWEB_STOW_URL.replace('/studies', '');

async function debugRetrieve() {
  console.log('=== DICOMweb Server Retrieve Debug ===\n');
  console.log('Base URL:', BASE_URL);

  // 1. List all studies
  console.log('\n--- QIDO: Searching studies ---');
  const { data: studies } = await axios.get(`${BASE_URL}/studies`, {
    headers: { Accept: 'application/dicom+json' }
  });
  console.log(`Found ${studies.length} studies`);

  if (!studies.length) {
    console.log('No studies found. Upload an image first.');
    return;
  }

  const study = studies[0];
  const studyUID = study['0020000D']?.Value?.[0];
  console.log('Study UID:', studyUID);

  // 2. List series in study
  console.log('\n--- QIDO: Searching series ---');
  const { data: series } = await axios.get(`${BASE_URL}/studies/${studyUID}/series`, {
    headers: { Accept: 'application/dicom+json' }
  });
  console.log(`Found ${series.length} series`);

  const ser = series[0];
  const seriesUID = ser['0020000E']?.Value?.[0];
  console.log('Series UID:', seriesUID);

  // 3. List instances in series
  console.log('\n--- QIDO: Searching instances ---');
  const { data: instances } = await axios.get(
    `${BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances`,
    { headers: { Accept: 'application/dicom+json' } }
  );
  console.log(`Found ${instances.length} instances`);

  const inst = instances[0];
  const instanceUID = inst['00080018']?.Value?.[0];
  console.log('Instance UID:', instanceUID);

  // 4. Check metadata returned by server
  console.log('\n--- WADO-RS: Instance metadata ---');
  const { data: metadata } = await axios.get(
    `${BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances/${instanceUID}/metadata`,
    { headers: { Accept: 'application/dicom+json' } }
  );
  const meta = metadata[0];

  const rows          = meta['00280010']?.Value?.[0];
  const cols          = meta['00280011']?.Value?.[0];
  const samples       = meta['00280002']?.Value?.[0];
  const bitsAlloc     = meta['00280100']?.Value?.[0];
  const photometric   = meta['00280004']?.Value?.[0];
  const transferSyntax = meta['00020010']?.Value?.[0];
  const planarConfig  = meta['00280006']?.Value?.[0];

  console.log('Transfer Syntax :', transferSyntax || 'MISSING ⚠️');
  console.log('Rows            :', rows);
  console.log('Columns         :', cols);
  console.log('Samples/Pixel   :', samples);
  console.log('Bits Allocated  :', bitsAlloc);
  console.log('Photometric     :', photometric);
  console.log('Planar Config   :', planarConfig !== undefined ? planarConfig : 'NOT SET');

  const expectedSize = rows * cols * samples * (bitsAlloc / 8);
  console.log(`\nExpected pixel data: ${rows} × ${cols} × ${samples} × ${bitsAlloc/8} = ${expectedSize} bytes`);

  // 5. Retrieve the actual pixel data frames
  console.log('\n--- WADO-RS: Retrieving frame 1 ---');
  try {
    const frameResp = await axios.get(
      `${BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances/${instanceUID}/frames/1`,
      {
        headers: { Accept: 'multipart/related; type="application/octet-stream"' },
        responseType: 'arraybuffer'
      }
    );
    console.log('Frame response status:', frameResp.status);
    console.log('Frame Content-Type:', frameResp.headers['content-type']);
    console.log('Frame response size:', frameResp.data.byteLength, 'bytes');

    // Save the raw response for inspection
    fs.writeFileSync('./frame-response.bin', Buffer.from(frameResp.data));
    console.log('✓ Saved raw frame response to frame-response.bin');

    // Check if size matches
    if (frameResp.data.byteLength !== expectedSize) {
      console.log(`\n⚠️  SIZE MISMATCH!`);
      console.log(`   Expected: ${expectedSize} bytes`);
      console.log(`   Got:      ${frameResp.data.byteLength} bytes`);
      console.log(`   Ratio:    ${(frameResp.data.byteLength / expectedSize).toFixed(3)}`);
      console.log(`\n   This is the cause of the OHIF rendering error!`);
      console.log(`   The server is returning ${frameResp.data.byteLength} bytes but OHIF`);
      console.log(`   expects ${expectedSize} bytes based on the metadata.`);
    } else {
      console.log(`\n✅ Size matches expected ${expectedSize} bytes`);
    }
  } catch (err) {
    console.error('Frame retrieve error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data?.toString?.().substring(0, 500));
    }
  }

  // 6. Also try retrieving the full DICOM instance
  console.log('\n--- WADO-RS: Retrieving full instance ---');
  try {
    const instResp = await axios.get(
      `${BASE_URL}/studies/${studyUID}/series/${seriesUID}/instances/${instanceUID}`,
      {
        headers: { Accept: 'multipart/related; type="application/dicom"' },
        responseType: 'arraybuffer'
      }
    );
    console.log('Instance response size:', instResp.data.byteLength, 'bytes');
    fs.writeFileSync('./retrieved-instance.bin', Buffer.from(instResp.data));
    console.log('✓ Saved to retrieved-instance.bin');
  } catch (err) {
    console.error('Instance retrieve error:', err.message);
  }
}

debugRetrieve().catch(console.error);
