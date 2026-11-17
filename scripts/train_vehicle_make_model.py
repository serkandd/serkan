#!/usr/bin/env python3
"""
Araç marka/model sınıflandırıcısı eğitir ve uygulamanın kullanacağı ONNX'e dönüştürür.

Uygulama bu model olmadan da çalışır (marka/model elle girilir). Model eklendiğinde, plakası okunan
aracın görüntüsünden marka ve model otomatik doldurulur.

1) Veri seti (klasör başına bir sınıf, ad biçimi Marka__Model):
     dataset/train/Renault__Clio/*.jpg   dataset/val/Renault__Clio/*.jpg
     dataset/train/Fiat__Egea/*.jpg      ...
   Kendi kapınızdaki kameradan alınan araç görüntüleri en iyi sonucu verir (sınıf başına 200+ görüntü).

2) Eğitim + dışa aktarma:
     pip install ultralytics onnx onnxslim
     python scripts/train_vehicle_make_model.py --data dataset --epochs 50

3) public/models/vehicle-make/ altına model ve manifest yazılır; `npm run vendor` çalıştırın.
"""
import argparse
import json
import shutil
from pathlib import Path

from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True, help="train/ ve val/ alt klasörlü veri seti")
ap.add_argument("--base", default="yolov8n-cls.pt")
ap.add_argument("--epochs", type=int, default=50)
ap.add_argument("--imgsz", type=int, default=224)
args = ap.parse_args()

model = YOLO(args.base)
res = model.train(data=args.data, epochs=args.epochs, imgsz=args.imgsz, fliplr=0.5)
best = YOLO(str(Path(res.save_dir) / "weights" / "best.pt"))
names = [best.names[i] for i in range(len(best.names))]
onnx = best.export(format="onnx", imgsz=args.imgsz, opset=17, simplify=True, dynamic=False)

root = Path(__file__).resolve().parent.parent / "public/models/vehicle-make"
root.mkdir(parents=True, exist_ok=True)
shutil.copy(onnx, root / "vehicle-make.onnx")
(root / "manifest.json").write_text(json.dumps({
    "_aciklama": "Araç marka/model sınıflandırıcısı (scripts/train_vehicle_make_model.py)",
    "model": "vehicle-make.onnx",
    "inputSize": args.imgsz,
    "minConfidence": 0.6,
    "labels": [n.replace("__", "|").replace("_", " ") for n in names],
}, ensure_ascii=False, indent=2), encoding="utf-8")
print("Kaydedildi:", root)
