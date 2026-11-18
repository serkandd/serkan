# Yapay Zekâ Modelleri

Tüm modeller `public/models/` ve `public/vendor/` altında yereldir; çalışma sırasında internet gerekmez.

| Görev | Model | Boyut | Kaynak / Lisans |
|---|---|---|---|
| Yüz algılama + 5 yüz noktası | SCRFD-500M (InsightFace buffalo_s) | 2.5 MB | InsightFace — **ticari olmayan araştırma lisansı** |
| Yüz tanıma (512B şablon) | ArcFace MobileFaceNet, WebFace600K (InsightFace buffalo_s) | 13.6 MB | InsightFace — **ticari olmayan araştırma lisansı** |
| Araç algılama | YOLOv8n COCO, 416×416 | 12 MB | Ultralytics — AGPL-3.0 |
| Plaka algılama | YOLOv9-t license-plate end2end, 384×384 | 7.8 MB | open-image-models — MIT |
| Plaka OCR | fast-plate-ocr CCT-S v2 global (Türkiye dahil 60+ ülke) | 5.3 MB | fast-plate-ocr — MIT |
| Araç marka/model, kasa tipi, renk | CLIP ViT-B/32 görüntü kodlayıcı (int8), sıfır-atış; 212 marka-model, 12 kasa tipi, 14 renk | 88 MB | OpenAI CLIP — MIT (ONNX: Jina AI) |
| Yedek yüz motoru | face-api (TinyFaceDetector, SSD, FaceRecognitionNet) | 12 MB | MIT |
| Yedek plaka okuma | Klasik plaka bulucu + Tesseract LSTM | 3 MB | Apache-2.0 |

Tüm modeller ONNX Runtime Web ile çalışır. Cihazda **WebGPU** varsa (güncel Android System WebView + Chrome) modeller
GPU'da, yoksa WASM SIMD ile işlemcide çalışır (Ayarlar → Sistem Tanılama → Hesaplama).

> **Lisans uyarısı:** InsightFace'in hazır eğitilmiş yüz modelleri yalnızca ticari olmayan araştırma amaçlı
> kullanıma izin verir. Uygulama ticari bir ürün/hizmet olarak kullanılacaksa InsightFace'ten ticari lisans
> alınmalı veya modeller lisansı uygun eşdeğerleriyle değiştirilmelidir (`models/face-onnx/`). Ultralytics
> YOLOv8 AGPL-3.0'dır (bkz. aşağıdaki not).

## Nasıl çalışır (özet)

**Plaka:** Araçlar bulunur → en büyük iki aracın plaka bölgesi ve dönüşümlü olarak görüntünün tamamı / yarıları
plaka modeline yakınlaştırılarak verilir (uzaktaki küçük plakalar modele büyük girer) → plaka takip edilir →
derin öğrenme OCR her karakter yuvası için olasılık verir → kareler arasında olasılıklar ağırlıklı toplanır
(yakın/büyük plaka daha ağır) → **Türk plaka kalıbına göre en olası plaka** seçilir (il kodu 01-81, harf/rakam
grupları; 0/O, 8/B, 1/I konuma göre çözülür). Formata uymayan veya düşük güvenli okuma kesinleştirilmez.

**Yüz:** SCRFD yüzü ve 5 yüz noktasını bulur → yüz 112×112 standart pozisyona hizalanır → ArcFace yüz ve aynası
için 512 boyutlu şablon üretir → kayıtlı şablonlarla kosinüs benzerliği → 2 karelik oylama. Güçlü eşleşmede tek
kare yeterlidir. *Uyarlanabilir öğrenme* açıksa, kişi çok yüksek güvenle tanındığında farklı ışık/açıdaki
görünümü yeni şablon olarak eklenir (kişi başı en çok 12-16 şablon).

Geliştirme ortamında ölçülen ayırt edicilik (6 fotoğraftaki 22 yüz): aynı kişinin küçültülmüş + karartılmış +
bulanık kopyası 0.71–0.91 benzerlik; farklı kişi çiftlerinin (231 çift) ortalaması 0.03, en yüksek değerleri
0.59 (muhtemelen iki fotoğrafta da bulunan aynı kişi), ardından 0.36. Varsayılan eşik 0.42'dir.

## Yüz doğrulama eşikleri

| Ayar | Varsayılan | Etki |
|---|---|---|
| Eşleşme benzerlik eşiği | 0.42 | Yükseltmek yanlış eşleşmeyi azaltır, tanınmama oranını artırır |
| Belirsizlik payı | 0.07 | En yakın iki kişi bu kadar yakınsa sonuç verilmez |
| En küçük yüz | 56 px | Daha küçük yüzlerde kimlik sonucu verilmez (yalnızca anonim takip) |
| En düşük algılama güveni | 0.6 | Kalite kapısı |
| Gereken kare | 2 | Kesin sonuç için tutarlı kare sayısı |

Saha testinde yanlış eşleşme görülürse eşiği **0.48**'e yükseltin; kayıtlı kişi zor tanınıyorsa farklı ışık ve
açılardan 2-3 kez "Yüzümü kaydet" ile şablon ekleyin.

## Plaka okuma eşikleri

| Ayar | Varsayılan | Etki |
|---|---|---|
| Gereken okuma | 2 | Kesin sonuç için en az OCR okuması (çok net plakada 1) |
| En düşük OCR güveni | 0.50 | Birleştirilmiş olasılıklardan hesaplanan plaka güveni alt sınırı |

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
