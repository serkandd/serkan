#!/usr/bin/env python3
"""
Türk plakaları için YOLO plaka tespit modeli eğitir ve tarayıcıda kullanılacak ONNX'e dönüştürür.

Uygulama bu model olmadan da çalışır (yerleşik klasik plaka bulucu + OCR + format doğrulama).
Model eklendiğinde zor koşullarda (açılı, kirli, gece, kalabalık sahne) plaka tespiti belirgin iyileşir.

1) Veri seti hazırlayın (YOLO formatı, tek sınıf: plate):
     dataset/
       data.yaml          → path: ., train: images/train, val: images/val, names: {0: plate}
       images/train/*.jpg  labels/train/*.txt
       images/val/*.jpg    labels/val/*.txt
   Kendi kameranızla çekilmiş, 5-10 m mesafede, farklı ışık koşullarında Türk plakası görüntüleri
   en iyi sonucu verir. (Görüntülerin toplanması ve kullanımı KVKK kapsamında değerlendirilmelidir.)

2) Eğitim + dışa aktarma:
     pip install ultralytics onnx onnxslim
     python scripts/train_plate_model.py --data dataset/data.yaml --epochs 100 --imgsz 640

3) Betik modeli public/models/plate/plate-yolo.onnx olarak kaydeder ve manifest.json'u günceller.
   Uygulamayı yeniden yükleyin: Ayarlar → Sistem Tanılama'da "Plaka modeli: hazır" görünür.
"""
import argparse
import json
import shutil
from pathlib import Path

from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True, help="YOLO data.yaml yolu")
ap.add_argument("--base", default="yolov8n.pt", help="Başlangıç ağırlıkları (yolov8n.pt / yolo11n.pt)")
ap.add_argument("--epochs", type=int, default=100)
ap.add_argument("--imgsz", type=int, default=640, help="Eğitim boyutu")
ap.add_argument("--export-imgsz", type=int, default=416, help="Tarayıcı modeli giriş boyutu")
ap.add_argument("--weights", default=None, help="Eğitimi atla, bu .pt dosyasını dışa aktar")
args = ap.parse_args()

if args.weights:
    best = args.weights
else:
    model = YOLO(args.base)
    res = model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz, patience=20,
                      hsv_v=0.5, degrees=8, perspective=0.0005, mosaic=1.0, fliplr=0.0)  # plakada ayna çevirme kapalı
    best = Path(res.save_dir) / "weights" / "best.pt"

onnx = YOLO(str(best)).export(format="onnx", imgsz=args.export_imgsz, opset=17, simplify=True, dynamic=False)
root = Path(__file__).resolve().parent.parent / "public/models/plate"
root.mkdir(parents=True, exist_ok=True)
shutil.copy(onnx, root / "plate-yolo.onnx")
manifest = {
    "_aciklama": "YOLO plaka tespit modeli (scripts/train_plate_model.py ile üretildi)",
    "model": "plate-yolo.onnx",
    "inputSize": args.export_imgsz,
    "classes": {"0": "Plaka"},
}
(root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print("Kaydedildi:", root / "plate-yolo.onnx")
print("Ardından 'npm run vendor' çalıştırarak çevrimdışı önbellek listesini güncelleyin.")
