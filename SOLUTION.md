# Solution: Use Orthanc's Built-in DICOMweb Peer

The issue you're experiencing is that your DICOM files are missing the Transfer Syntax UID in their metadata, which causes OHIF viewer to fail when rendering them.

## Recommended Solution: Configure Orthanc DICOMweb Peer

Instead of writing custom forwarding code, use Orthanc's built-in DICOMweb peer functionality which properly handles DICOM encoding.

### Step 1: Configure Orthanc

Edit your Orthanc configuration file (usually `orthanc.json` or via environment variables):

```json
{
  "DicomWeb": {
    "Enable": true,
    "Root": "/dicom-web/",
    "EnableWado": true,
    "WadoRoot": "/wado",
    "Ssl": false,
    "StowMaxInstances": 10,
    "StowMaxSize": 10
  },
  
  "DicomWebServers": {
    "remote-server": {
      "Url": "https://api.oumchealth.org/dicom/",
      "HasDelete": false
    }
  }
}
```

### Step 2: Use Orthanc's Auto-Routing

Configure Orthanc to automatically forward new instances:

```json
{
  "AutoRoutingRules": [
    {
      "Description": "Forward all to remote DICOMweb",
      "Conditions": {},
      "Actions": {
        "DicomWebStore": "remote-server"
      }
    }
  ]
}
```

### Step 3: Or Use Orthanc's REST API

If you prefer programmatic control, use Orthanc's `/dicom-web/servers/{name}/stow` endpoint:

```javascript
// Forward a specific instance
await ORTHANC.post(`/dicom-web/servers/remote-server/stow`, {
  Resources: [instanceId],
  Synchronous: true
});
```

## Alternative: Fix DICOM Files Before Upload

If you must use custom code, the issue is that your DICOM files need proper Transfer Syntax UID. Use DCMTK tools:

```bash
# Install DCMTK
brew install dcmtk  # macOS
# or
apt-get install dcmtk  # Linux

# Fix a DICOM file
dcmodify --insert-tuid --insert "(0002,0010)=1.2.840.10008.1.2.1" input.dcm

# Or use Orthanc's modify endpoint
curl -X POST http://localhost:8042/instances/{id}/modify \
  -H "Content-Type: application/json" \
  -d '{
    "Replace": {
      "TransferSyntaxUID": "1.2.840.10008.1.2.1"
    },
    "Force": true
  }'
```

## Why This Happens

1. Your DICOM files are missing Transfer Syntax UID (0002,0010)
2. This is required by DICOM Part 10 File Format
3. Without it, OHIF/Cornerstone can't determine how to decode pixel data
4. The error "model.size is not a multiple of model.numberOfComponents" occurs because the viewer makes wrong assumptions about pixel data layout

## Testing

1. Start Orthanc with the new configuration
2. Upload a DICOM image
3. Check that it appears in your remote DICOMweb server
4. Open it in OHIF viewer - it should now render correctly

The key is letting Orthanc handle the DICOM encoding rather than trying to manipulate the files yourself.
