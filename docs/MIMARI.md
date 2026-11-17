# Teknik Mimari

## 1. Genel Bakış

Uygulama, derleme adımı gerektirmeyen ES modülleriyle yazılmış bir **istemci tarafı PWA**'dır. Tüm görüntü
işleme ve yapay zekâ çıkarımı telefonun üzerinde yapılır; görüntü hiçbir sunucuya gönderilmez.

```
┌──────────────────────────── Ana iş parçacığı (UI) ────────────────────────────┐
│  Kamera (MediaDevices) ─► <video>                                              │
│        │                                                                       │
│        ├─► YÜZ DÖNGÜSÜ (uyarlanabilir FPS)                                     │
│        │     face-api TinyFaceDetector/SSD  ──[WebGL GPU]──► Yüz takipçisi     │
│        │     └─► (kayıtlı şablon varsa, kalite yeterliyse)                     │
│        │          68 nokta + 128B şablon ─► face-match ─► Oylama ─► Sonuç      │
│        │                                                                       │
│        ├─► PLAKA DÖNGÜSÜ (≤5 FPS, uyarlanabilir)                               │
│        │     YOLOv8n araç ──[ONNX Runtime proxy worker, WASM SIMD+thread]──┐   │
│        │     createImageBitmap ──► [Plaka Worker] ◄── araç bölgeleri ──────┘   │
│        │                            plaka adayı + OCR ön işleme + kalite       │
│        │     Plaka takipçisi ──► [Tesseract worker(lar)] OCR                   │
│        │     ──► Türk format doğrulama/düzeltme ──► Oylama ──► Araç kaydı      │
│        │                                                                       │
│        └─► OVERLAY (requestAnimationFrame) — takipçilerin öngörülen kutuları   │
│                                                                               │
│  Olaylar ─► Şifreli IndexedDB ─► Arayüz listeleri, ses/titreşim uyarısı        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### İş parçacıkları

| İş parçacığı | Görev |
|---|---|
| Ana (UI) | Kamera, yüz modeli (TF.js WebGL — iş GPU'da yürür), takip, karar, çizim |
| ONNX Runtime proxy worker | Araç (ve isteğe bağlı plaka) YOLO çıkarımı; `crossOriginIsolated` ise 2-4 WASM iş parçacığı |
| Plaka Worker (`workers/plate-worker.js`) | Kare okuma, plaka adayı arama, OCR ön işleme, PNG/JPEG kodlama |
| Tesseract worker(lar) | LSTM OCR (8+ çekirdekli cihazda 2 adet) |
| Service Worker | Çevrimdışı önbellek, COOP/COEP başlıkları |

Analiz ve görüntüleme birbirinden bağımsızdır: Overlay, analiz kaç FPS'de çalışırsa çalışsın ekran yenileme
hızında, takipçinin hız tahminiyle öngördüğü kutuyu çizer.

## 2. Modüller

### Kamera — `js/camera/camera.js`
- `getUserMedia` ile 720p–4K arası istenen çözünürlük; reddedilirse kademeli düşürme.
- Lens seçimi (Samsung'da tele/geniş açı lensler ayrı `deviceId` olarak görünebilir), `zoom`, `torch`,
  sürekli odak/pozlama/beyaz dengesi kısıtları.
- Bağlantı koparsa (`ended`) 5 kez artan beklemeyle yeniden bağlanma.
- İzin reddi, cihaz meşgul, HTTPS yok gibi durumlar anlaşılır Türkçe mesaja çevrilir.

### Yüz algılama — `js/detection/face-engine.js`
- `detect()`: **anonim** algılama. TinyFaceDetector (hızlı) veya SSD MobileNet (doğru).
  *Uzak mesafe modu*: kare örtüşen iki karoya bölünüp her biri tam model çözünürlüğünde analiz edilir.
- `describe()`: Yalnızca kalite kapısını geçen yüz için, tam çözünürlükten kırpılan bölgede 68 nokta +
  128 boyutlu şablon. Kalite: en küçük boyut, algılama güveni, netlik (Laplace varyansı), yüz açısı.
- `enrollFromImage()`: Kayıt fotoğrafında tam olarak 1 net, önden yüz şartı. Fotoğraf saklanmaz.

### Kimlik doğrulama — `js/detection/face-match.js`
- Öklid mesafesi; eşik (varsayılan 0.45 — face-api'nin genel 0.6 eşiğinden belirgin şekilde katı).
- **Belirsizlik payı**: En yakın iki kişi arasındaki fark payın altındaysa sonuç verilmez.
- Yüz izi üzerinde **oylama** (varsayılan 3 tutarlı kare) → ancak sonra "Doğrulandı" gösterilir.
- Eşleşme yoksa sonuç "Kayıtlı personelle eşleşmedi" olur ve iz anonim kalır.

### Plaka — `js/detection/plate-localizer.js`, `js/ocr/*`, `js/workers/plate-worker.js`
1. **Araç bölgeleri**: YOLOv8n (COCO) araç kutuları; plaka aramasını daraltır, yanlış adayları azaltır.
   Her 3 döngüde bir tam karede de arama yapılır (araç tamamen görünmeden yakın plakalar için).
2. **Aday bulucu (modelsiz)**: Sobel-X → uyarlanabilir eşik → yatay morfolojik kapama → bağlı bileşenler →
   satır birleştirme → en-boy/doluluk/geçiş sayısı/zemin parlaklığı ile puanlama.
3. **İsteğe bağlı YOLO plaka modeli**: `models/plate/manifest.json` bir model gösteriyorsa yüklenir ve
   adaylarla birleştirilir.
4. **Ön işleme**: Mavi TR bandını kırpma, kontrast germe, ölçekleme, Otsu, çerçeve/vida/gölge temizliği,
   kenar boşluğu. Kalite yetersizse (küçük, bulanık, düşük kontrast, karakter yok) **OCR çalıştırılmaz**.
5. **OCR**: Tesseract LSTM, tek satır (PSM 7), yalnızca plaka karakterleri, sözlük kapalı.
6. **Türk plaka doğrulama** (`turkish-plate.js`): il kodu 01-81; 1 harf+4/5 rakam, 2 harf+3/4 rakam,
   3 harf+2/3 rakam; Q/W/X ve Türkçe harfler yok. Konuma göre en fazla 2 karakter düzeltmesi
   (ör. rakam konumunda O→0, harf konumunda 8→B). Belirsiz veya formata uymayan sonuç **reddedilir**.
7. **Oylama**: Aynı izde varsayılan 3 tutarlı okuma ve güven/uzlaşı eşikleri → kesin sonuç.
8. **Karşılaştırma**: Kayıtlı araç listesinde arama; yetki bitiş tarihi kontrolü.

Plakaya benzer metin hiç üretmeyen adaylar (tabela, jaluzi, desen) reddedilir ve gösterilmez; plakaya benzeyen
ama okunamayan (bulanık/kapalı) adaylar "Plaka okunamadı" olarak işaretlenir.

### Takip — `js/tracking/tracker.js`
SORT benzeri çoklu nesne takipçisi: IoU + merkez mesafesi maliyetiyle açgözlü eşleştirme, alfa-beta filtresiyle
konum/boyut yumuşatma ve hız tahmini, `minHits` ile onay (tek karelik yanlış tespit numara almaz), `maxAge`
ile kısa kayıplarda numara korunması. Yüz, plaka ve araç için ayrı takipçi örnekleri kullanılır.

### Tekrar bildirim engelleme — `js/tracking/consensus.js`
`Deduplicator`: Aynı plaka veya aynı personel için ayarlanabilir süre (varsayılan 60 sn) boyunca tek olay.
Nesne görünmeye devam ettikçe pencere uzar.

### Performans ve pil — `js/pipeline/perf-monitor.js`
- Her döngü kendi işlem süresini ölçer; bir sonraki analiz, süre / 0.7 aralığından önce başlamaz
  (işlemci tek döngüye kilitlenmez).
- Yük çarpanı: Compute Pressure API (`serious` ×1.8, `critical` ×3), düşük pil (×1.5), işlem süresinin
  başlangıca göre 2.2 kat uzaması — termal kısıtlama belirtisi (×1.5), JS belleği %85 üstü (×1.5).
- Sekme arka plandayken analiz durur; ekran açık tutma (Wake Lock) yalnızca kamera açıkken etkindir.

### Depolama ve güvenlik — `js/storage/*`
Bkz. [VERITABANI.md](VERITABANI.md).

## 3. Hata Yönetimi

| Durum | Davranış |
|---|---|
| Kamera izni yok / HTTPS yok / kamera meşgul | Anlaşılır mesaj, uygulama çalışmaya devam eder |
| Kamera bağlantısı koptu | Otomatik yeniden bağlanma (5 deneme), sonra kullanıcıya bildirim |
| İnternet yok | Service worker önbelleği; durum çubuğunda "Çevrimdışı" |
| Model yüklenemedi | İlgili modül devre dışı, diğerleri çalışır; Tanılama ekranında neden görünür |
| OCR hatası / kuyruk dolu | İş atlanır, sonraki karede tekrar denenir; izde başarısızlık olarak sayılır |
| Düşük görüntü kalitesi | OCR/şablon çıkarımı yapılmaz; kutu üzerinde neden gösterilir |
| Aynı plaka tekrar | Takip numarası + Deduplicator |
| Çok sayıda yüz | Hepsi takip edilir; şablon çıkarımı sırayla (döngü başına bir yüz) |
| Isınma / pil / bellek | Analiz hızı otomatik düşer, uyarı bandı gösterilir |
| Döngü hatası | Döngü çökmez; ardışık hatalarda durum "hata" olur ve beklemeyle tekrar denenir |

## 4. Genişletme

- **Merkezi sunucu**: `storage/repos.js` arayüzü korunarak bir REST/WebSocket senkronizasyon katmanı
  eklenebilir. Biyometrik şablonların sunucuya taşınması ayrı bir hukuki değerlendirme gerektirir.
- **WebGPU**: `onnxruntime-web` WebGPU yürütücüsü (`ort.webgpu.min.mjs` + JSEP wasm) eklenerek araç/plaka
  modelleri GPU'ya taşınabilir.
- **Daha güçlü OCR**: Türk plakalarıyla eğitilmiş bir CRNN/PARSeq ONNX modeli `ocr/plate-ocr.js` ile aynı
  arayüzü (read → {plate, confidence}) sağlayarak takılabilir.
