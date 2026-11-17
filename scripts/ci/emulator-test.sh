#!/usr/bin/env bash
set -x
adb install -r GuvenlikAsistani.apk
adb shell pm grant com.guvenlik.asistani android.permission.CAMERA || true
adb shell am start -n com.guvenlik.asistani/.MainActivity
sleep 10
node scripts/ci/emulator-test.mjs || true
adb exec-out screencap -p > emulator-screen.png || true
adb logcat -d | grep -iE "Capacitor|chromium|tesseract|AndroidRuntime" | tail -200 || true
