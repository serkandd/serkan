# Yapay Zekâ Modelleri

Tüm modeller `public/models/` ve `public/vendor/` altında yereldir; çalışma sırasında internet gerekmez.

| Görev | Model | Çalışma ortamı | Boyut | Kaynak / Lisans |
|---|---|---|---|---|
| Yüz algılama (hızlı) | TinyFaceDetector | TF.js WebGL | 190 KB | @vladmandic/face-api — MIT |
| Yüz algılama (doğru) + kalite | SSD MobileNet v1 | TF.js WebGL | 5.4 MB | @vladmandic/face-api — MIT |
| Yüz işaret noktaları | FaceLandmark68Net | TF.js WebGL | 350 KB | @vladmandic/face-api — MIT |
| Yüz şablonu (128B) | FaceRecognitionNet (ResNet-34 tabanlı) | TF.js WebGL | 6.2 MB | @vladmandic/face-api — MIT |
| Araç algılama | YOLOv8n COCO, 416×416, ONNX opset 17 | ONNX Runtime Web (WASM SIMD, çok iş parçacığı) | 12 MB | Ultralytics — **AGPL-3.0** |
| Plaka tespiti (yerleşik) | Klasik CV (Sobel + morfoloji + doğrulama) | Web Worker | — | Bu proje |
| Plaka tespiti (isteğe bağlı) | YOLO tek sınıf "plate" | ONNX Runtime Web | ~12 MB | `scripts/train_plate_model.py` ile üretilir |
| Plaka OCR | Tesseract 5 LSTM `eng` (best_int) | Tesseract.js worker (WASM) | 2.9 MB | Apache-2.0 |

> **Lisans notu:** Ultralytics YOLO modelleri AGPL-3.0 lisanslıdır. Kurum içi kullanımda sorun teşkil etmez;
> ancak uygulamanın üçüncü taraflara dağıtılması veya ticari ürünleştirilmesi durumunda Ultralytics kurumsal
> lisansı ya da Apache/MIT lisanslı bir alternatif (ör. RT-DETR, YOLOX) değerlendirilmelidir.

## Yüz doğrulama eşikleri

| Ayar | Varsayılan | Etki |
|---|---|---|
| Eşleşme mesafe eşiği | 0.45 | Düşürmek yanlış eşleşmeyi azaltır, doğrulanamama oranını artırır |
| Belirsizlik payı | 0.06 | En yakın iki kişi bu kadar yakınsa sonuç verilmez |
| En küçük yüz | 72 px | Daha küçük yüzlerde kimlik sonucu verilmez (yalnızca anonim takip) |
| En düşük algılama güveni | 0.75 | Kalite kapısı |
| Gereken kare | 3 | Kesin sonuç için tutarlı kare sayısı |

Saha testinde yanlış eşleşme görülürse önce eşiği **0.40**'a düşürün ve personel başına 2-3 farklı açıdan
şablon ekleyin.

## Plaka okuma eşikleri

| Ayar | Varsayılan | Etki |
|---|---|---|
| Gereken okuma | 3 | Aynı izde aynı metnin okunduğu kare sayısı |
| En düşük OCR güveni | 0.40 | Okumaların ortalama karakter güveni alt sınırı |
| Karakter düzeltme | en fazla 2 | Türk formatına göre konumsal düzeltme; daha fazlası reddedilir |

## Türk plaka verisiyle plaka modeli eğitimi (önerilen)

Yerleşik plaka bulucu düz, iyi aydınlatılmış ve kameraya dik plakalarda iyi çalışır. Açılı, kirli, gece veya
kalabalık sahnelerde başarıyı artırmak için tek sınıflı bir YOLO plaka modeli ekleyin:

```bash
python -m venv .venv && source .venv/bin/activate
pip install ultralytics onnx onnxslim
# dataset/data.yaml hazırlayın (YOLO formatı, tek sınıf: plate) — ayrıntı betiğin başında
python scripts/train_plate_model.py --data dataset/data.yaml --epochs 100 --imgsz 640
npm run vendor   # çevrimdışı önbellek listesini güncelle
```

Betik `public/models/plate/plate-yolo.onnx` dosyasını ve `manifest.json`'u yazar. Uygulama açılışta manifest'i
okur ve modeli yükler; *Ayarlar → Sistem Tanılama → Plaka modeli* "hazır" gösterir. Model kutuları yerleşik
adaylarla birleştirilir; OCR, format doğrulama ve oylama aynı şekilde uygulanır.

Veri seti önerisi: kendi giriş kapınızda, hedef mesafede (5-10 m), gündüz/gece/yağmur koşullarında, farklı açılarda
en az 1.500 etiketli görüntü. Görüntülerin toplanması ve kullanımı KVKK kapsamında değerlendirilmelidir.

## Araç modelini yeniden üretme

```bash
python scripts/export_vehicle_model.py --imgsz 416    # 320: daha hızlı, 640: daha uzak araçlar
```
