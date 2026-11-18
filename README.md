# Güvenlik Asistanı — Gerçek Zamanlı Yüz ve Plaka Analizi

Samsung Android telefonların Chrome tarayıcısında çalışan, mobil öncelikli, **PWA** biçiminde bir güvenlik
görüntü analiz uygulaması. Telefon kamerasından gelen canlı görüntüyü cihaz üzerinde, kesintisiz analiz eder:

- **Yüz algılama ve takip:** Görüntüdeki tüm yüzler bulunur, hareket boyunca takip edilir ve her birine kalıcı
  bir takip numarası (Y1, Y2…) verilir.
- **İzinli personel doğrulama:** Yüz algılamadan **ayrı** bir modüldür. Yalnızca hukuki şartları sağlanmış
  kayıtlı personel şablonlarıyla karşılaştırma yapar. Kayıtlı olmayan kişilere **asla isim atanmaz**.
- **Araç algılama:** YOLOv8n (ONNX Runtime Web) ile otomobil, motosiklet, otobüs, kamyon.
- **Plaka tespiti ve okuma (OCR):** Araç bölgelerinde plaka arama, Tesseract LSTM OCR, **Türk plaka formatı
  doğrulaması** ve konuma duyarlı karakter düzeltmesi, kareler arası oylama.
- **Kayıtlı araç karşılaştırması:** *Kayıtlı ve yetkili* · *Kayıtlı, yetkisi yok* · *Kayıt bulunamadı* ·
  *Plaka okunamadı* sonuçları ayrı gösterilir. Kayıt bulunamaması "şüpheli" olarak yorumlanmaz.
- **Yönetim paneli:** Personel ve araç kayıtları, kullanıcılar (Yönetici / Güvenlik Görevlisi), ayarlar,
  işlem kayıtları (hash zincirli), şifreli yedekleme, saklama politikası.
- **Gizlilik:** Tüm kayıtlar AES-GCM 256 ile şifrelenir; yüz fotoğrafları saklanmaz (yalnızca 128 boyutlu şablon).
- **Çevrimdışı:** Tüm modeller ve kütüphaneler yerelde; internet olmadan çalışır.

> Yapay zekâ sonuçları **karar destek** amaçlıdır. Kritik uyarılar görevlinin "Doğru – onayla / Hatalı algılama"
> işaretlemesiyle kayda geçer; sistem tek başına güvenlik kararı vermez.

## Telefona Kurulum (Android uygulaması)

**İndir:** https://github.com/serkandd/serkan/releases/download/android-latest/GuvenlikAsistani.apk

1. Linki Samsung telefonda açın, APK iner.
2. İndirilen dosyaya dokunun. "Bilinmeyen kaynaklardan yükleme" izni sorulursa *Ayarlar → Bu kaynaktan izin ver*.
3. *Yükle* → *Aç*. Kamera iznine bir kez *İzin ver* deyin.
4. Uygulama PIN veya şifre sormadan açılır; kamera doğrudan başlar. İsterseniz Ayarlar → Giriş'ten PIN sormayı açabilirsiniz.

**Yüz kaydı:** Kamerada yüz görülünce *Yüzümü kaydet* düğmesine basın; görüntü dondurulur, ad soyad yazıp kaydedin.
**Araçlar:** Okunan her yeni plaka araç fotoğrafı, rengi ve türüyle *Araçlar* listesine otomatik eklenir ("Bilgi bekliyor").
Kayda dokunup plakayı düzeltebilir, aracı kullananı, şirketi, marka ve modeli girebilirsiniz. Düzeltilen eski okuma da aynı araçla eşleşir.
Marka, model, kasa tipi ve renk araç fotoğrafından CLIP modeliyle otomatik tahmin edilir; yalnızca yeterince eminse yazılır ve "otomatik tahmin" olarak işaretlenir. Araç listesi `scripts/build_vehicle_clip.py` içinde genişletilebilir.

APK, depoya her yeni sürüm gönderildiğinde GitHub Actions tarafından otomatik derlenir (`.github/workflows/android.yml`).

## Hızlı Başlangıç (web)

```bash
npm install          # bağımlılıkları kurar ve kütüphaneleri/modelleri public/ altına kopyalar
npm start            # https://<bilgisayar-ip>:8443 adresinde HTTPS sunucusu
```

1. Telefon ve bilgisayar aynı Wi-Fi ağında olsun. Telefonda Chrome ile ekrandaki `https://192.168.x.x:8443`
   adresini açın (kendinden imzalı sertifika uyarısında *Gelişmiş → Devam et*).
2. İlk açılışta yönetici hesabını oluşturun. **Parola unutulursa şifreli veriler kurtarılamaz.**
3. *Araçlar* ve *Personel* sekmelerinden kayıtları ekleyin.
4. *Canlı* sekmesinde **Başlat**'a basın.
5. Chrome menüsü → *Ana ekrana ekle* ile uygulamayı yükleyin (tam ekran, çevrimdışı).

Kalıcı kurulum için uygulamayı geçerli sertifikalı bir HTTPS adresinde yayınlayın: bkz.
[docs/KURULUM_DAGITIM.md](docs/KURULUM_DAGITIM.md). `public/` klasörü derleme gerektirmeyen statik bir sitedir.

## Testler

```bash
npm test         # 32 birim testi: plaka formatı, OCR düzeltme, takip, oylama, eşleştirme, plaka bulucu, şifreleme, roller
npm run e2e      # Headless Chromium'da gerçek modellerle uçtan uca test (sahte kamera akışı)
```

Uçtan uca test; kurulum, model yükleme, araç/personel kaydı, canlı plaka okuma ve karşılaştırma, 4 kişilik
sahnede tek kayıtlı kişinin doğrulanması ve diğerlerine isim atanmaması, takip numarası kararlılığı, tekrar
bildirim engelleme ve mobil yerleşimi doğrular. Ekran görüntüleri `test-results/` altına yazılır.

**Gerçek cihaz testleri** (Samsung telefon, 5 m / 10 m, 30 dakika kesintisiz çalışma, hata oranı ölçümü)
sahada yapılmalıdır: prosedür ve kabul formu [docs/TEST_PLANI.md](docs/TEST_PLANI.md) içindedir. Uygulamadaki
*Kayıtlar → Saha testi raporu* bölümü işaretlemelerden doğruluk oranlarını hesaplar ve CSV verir.

## Dokümantasyon

| Belge | İçerik |
|---|---|
| [docs/MIMARI.md](docs/MIMARI.md) | Teknik mimari, modüller, iş parçacıkları, veri akışı |
| [docs/KURULUM_DAGITIM.md](docs/KURULUM_DAGITIM.md) | Kurulum, HTTPS yayınlama, Samsung ayarları, güncelleme |
| [docs/VERITABANI.md](docs/VERITABANI.md) | Veritabanı yapısı, şifreleme, roller, saklama, yedekleme |
| [docs/MODELLER.md](docs/MODELLER.md) | Yapay zekâ modelleri, lisanslar, plaka modeli eğitimi |
| [docs/TEST_PLANI.md](docs/TEST_PLANI.md) | Kabul kriterleri, 5/10 m saha testleri, dayanıklılık testi |
| [docs/KVKK_UYUM.md](docs/KVKK_UYUM.md) | Biyometrik veri, aydınlatma, saklama ve insan denetimi |

## Proje Yapısı

```
public/                      Statik uygulama (doğrudan yayınlanabilir)
  index.html, css/, icons/, manifest.webmanifest, sw.js
  js/
    main.js                  Arayüz denetleyicisi
    camera/camera.js         Kamera yöneticisi (çözünürlük, lens, zoom, fener, yeniden bağlanma)
    detection/               face-engine (algılama+şablon), face-match (eşleştirme),
                             yolo-detector (araç/plaka ONNX), plate-localizer (modelsiz plaka bulucu)
    ocr/                     plate-ocr (Tesseract), plate-preprocess, turkish-plate (format+düzeltme)
    tracking/                tracker (çoklu nesne takibi), consensus (oylama, tekrar engelleme)
    pipeline/                analyzer (yüz ve plaka döngüleri), perf-monitor (uyarlanabilir FPS, ısı, pil, bellek)
    storage/                 db (IndexedDB), crypto (AES-GCM/PBKDF2), auth (roller), repos (kayıtlar)
    workers/plate-worker.js  Plaka arama ve OCR ön işleme (Web Worker)
    ui/                      overlay (çerçeve çizimi), alerts (ses/titreşim), dom
  vendor/                    face-api (TF.js), tesseract.js, onnxruntime-web  (npm run vendor)
  models/                    face/ (face-api), vehicle/yolov8n-416.onnx, plate/ (isteğe bağlı)
scripts/                     vendor.mjs, serve.mjs (HTTPS), export_vehicle_model.py, train_plate_model.py
tests/unit, tests/e2e        Birim ve uçtan uca testler
```

## Bilinen Sınırlar

- Veriler **cihaz üzerinde** tutulur (sunucu yoktur). Birden fazla cihaz için kayıtlar şifreli yedekle taşınır.
  Merkezi yönetim gerekiyorsa bir sunucu bileşeni eklenmelidir (bkz. MIMARI.md → Genişletme).
- Yerleşik plaka bulucu modelsizdir; zor koşullar için Türk plaka verisiyle eğitilmiş YOLO plaka modeli
  eklenmesi önerilir (`scripts/train_plate_model.py`). Uygulama modeli otomatik algılar.
- 10 m mesafede başarı; kamera çözünürlüğü, optik yakınlaştırma, ışık ve hedefin piksel boyutuna bağlıdır.
  Ayrıntılı hesap: docs/TEST_PLANI.md → Mesafe ve piksel bütçesi.
- Tarayıcılar cihaz sıcaklığını doğrudan vermez; ısınma, Compute Pressure API ve işlem süresi artışından
  dolaylı olarak tespit edilir.
