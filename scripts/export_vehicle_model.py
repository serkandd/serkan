#!/usr/bin/env python3
"""
Araç algılama modelini (COCO ile eğitilmiş YOLOv8n) ONNX'e dönüştürür.
Depoda hazır dönüştürülmüş model bulunur: public/models/vehicle/yolov8n-416.onnx
Bu betik yalnızca modeli yeniden üretmek / farklı giriş boyutu denemek içindir.

Kurulum:  pip install ultralytics onnx onnxslim
Kullanım: python scripts/export_vehicle_model.py --imgsz 416
"""
import argparse
import shutil
from pathlib import Path

from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("--weights", default="yolov8n.pt", help="Ultralytics ağırlık dosyası (ilk çalıştırmada indirilir)")
ap.add_argument("--imgsz", type=int, default=416, help="Giriş boyutu (320 hızlı, 416 dengeli, 640 uzak mesafe)")
args = ap.parse_args()

model = YOLO(args.weights)
out = model.export(format="onnx", imgsz=args.imgsz, opset=17, simplify=True, dynamic=False)
dst = Path(__file__).resolve().parent.parent / "public/models/vehicle" / f"yolov8n-{args.imgsz}.onnx"
dst.parent.mkdir(parents=True, exist_ok=True)
shutil.copy(out, dst)
print(f"Kaydedildi: {dst}")
if args.imgsz != 416:
    print("Not: public/js/main.js içindeki VEHICLE_MODEL yolunu ve inputSize değerini güncelleyin.")
