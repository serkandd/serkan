#!/usr/bin/env node
/**
 * `npx cap add android` sonrası Android projesine kamera izni ve ekran ayarlarını ekler.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let m = readFileSync(manifestPath, 'utf8');
const perms = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.VIBRATE" />',
  '<uses-permission android:name="android.permission.WAKE_LOCK" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  // Android 9 ve öncesinde Belgeler klasörüne yedek yazmak için (10+ sürümlerde gerekmez)
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
];
for (const p of perms) if (!m.includes(p)) m = m.replace('</manifest>', `    ${p}\n</manifest>`);
// Ekran açık kalsın ve döndürmede etkinlik yeniden başlamasın
m = m.replace(/android:configChanges="([^"]*)"/, (s, v) => (v.includes('screenSize') ? s : `android:configChanges="${v}|screenSize|smallestScreenSize|screenLayout"`));
// Android 10'da ortak Belgeler klasörüne erişim için
if (!m.includes('requestLegacyExternalStorage')) m = m.replace('<application', '<application android:requestLegacyExternalStorage="true"');
writeFileSync(manifestPath, m);
console.log('AndroidManifest.xml güncellendi');
