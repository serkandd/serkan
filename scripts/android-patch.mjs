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
  '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
];
for (const p of perms) if (!m.includes(p)) m = m.replace('</manifest>', `    ${p}\n</manifest>`);
// Ekran açık kalsın ve döndürmede etkinlik yeniden başlamasın
m = m.replace(/android:configChanges="([^"]*)"/, (s, v) => (v.includes('screenSize') ? s : `android:configChanges="${v}|screenSize|smallestScreenSize|screenLayout"`));
writeFileSync(manifestPath, m);
console.log('AndroidManifest.xml güncellendi');
