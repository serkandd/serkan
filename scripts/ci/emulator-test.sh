#!/usr/bin/env bash
set -x
adb install -r GuvenlikAsistani.apk
adb shell pm grant com.guvenlik.asistani android.permission.CAMERA || true
adb shell am start -n com.guvenlik.asistani/.MainActivity
sleep 10
node scripts/ci/emulator-test.mjs || true
adb exec-out screencap -p > emulator-screen.png || true
echo "--- Belgeler klasöründeki yedek (uygulama yüklüyken)"
adb shell ls -la /sdcard/Documents/GuvenlikAsistani/ || true
adb uninstall com.guvenlik.asistani || true
echo "--- Uygulama SİLİNDİKTEN sonra yedek hâlâ yerinde mi?"
adb shell ls -la /sdcard/Documents/GuvenlikAsistani/ || true
echo "--- Aynı imzayla güncelleme (silmeden üzerine kurulum) testi"
adb install GuvenlikAsistani.apk && adb install -r GuvenlikAsistani.apk && echo "UZERINE KURULUM BASARILI" || true
adb logcat -d | grep -iE "Capacitor|chromium|tesseract|AndroidRuntime" | tail -200 || true
