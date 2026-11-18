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
echo "--- Çöküş tanılama (renderer / bellek / grafik)"
adb logcat -d | grep -iE "RenderProcessGone|renderer|lowmemorykiller|lmkd|Out of memory|OOM|FATAL|signal 11|SIGSEGV|crash|Killing .*guvenlik|isolated not needed|ColorBuffer|onTrimMemory" | grep -v "won't be persisted" | tail -80 || true
adb logcat -d -b crash | tail -60 || true
