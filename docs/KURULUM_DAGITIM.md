# Kurulum ve Dağıtım

## 1. Gereksinimler

| Bileşen | Gereksinim |
|---|---|
| Telefon | Samsung Galaxy (Android 10+), güncel **Chrome** (önerilen: 120+) |
| Bağlantı | **HTTPS** zorunludur (kamera ve Web Crypto API yalnızca güvenli bağlamda çalışır) |
| Geliştirme | Node.js 18+ (yalnızca kurulum/yerel sunucu için), isteğe bağlı Python 3.10+ (model eğitimi) |

## 2. Kaynaktan kurulum

```bash
git clone <depo-adresi> && cd serkan
npm install        # postinstall: kütüphaneleri ve modelleri public/vendor, public/models altına kopyalar
npm test           # birim testleri
npm start          # https://0.0.0.0:8443 (kendinden imzalı sertifika .cert/ altında üretilir)
```

`public/` klasörü depoda **hazır** (kütüphaneler ve modeller dahil) olarak bulunur; `npm install` yalnızca
güncelleme/yeniden üretim için gereklidir. Her değişiklikten sonra `npm run vendor` çalıştırmak, service worker
önbellek listesini (`precache-manifest.json`) yeniler ve telefonlara güncellemeyi iletir.

## 3. Yayınlama (kalıcı HTTPS)

`public/` derleme gerektirmeyen statik bir sitedir. Seçenekler:

### a) Kurum içi sunucu (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name guvenlik.kurum.local;
  ssl_certificate     /etc/ssl/kurum/fullchain.pem;
  ssl_certificate_key /etc/ssl/kurum/privkey.pem;
  root /opt/guvenlik-asistani/public;

  add_header Cross-Origin-Opener-Policy "same-origin" always;
  add_header Cross-Origin-Embedder-Policy "require-corp" always;
  add_header Cross-Origin-Resource-Policy "same-origin" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=(self), microphone=()" always;

  types { application/wasm wasm; application/manifest+json webmanifest; text/javascript mjs; }
  location ~ ^/(vendor|models)/ { add_header Cache-Control "public, max-age=604800"; add_header Cross-Origin-Embedder-Policy "require-corp" always; add_header Cross-Origin-Opener-Policy "same-origin" always; }
  location = /sw.js { add_header Cache-Control "no-cache"; }
  # .gz dosyaları (Tesseract dil verisi) Content-Encoding OLMADAN, olduğu gibi sunulmalıdır
  location ~ \.gz$ { gzip off; default_type application/octet-stream; }
}
```

Kurum içi CA ile imzalanmış sertifika kullanılıyorsa, CA sertifikasını telefonlara (Ayarlar → Biyometrik ve
güvenlik → Diğer güvenlik ayarları → Cihaz depolamasından yükle) yükleyin.

### b) Statik barındırma (Cloudflare Pages, Netlify, GitHub Pages)

Yayın klasörü olarak `public/` seçin. Bu servisler geçerli HTTPS sertifikası sağlar. Özel başlık
eklenemese bile service worker COOP/COEP başlıklarını kendisi ekler (ilk açılışta sayfa bir kez yenilenir).
Netlify / Cloudflare için `public/_headers` dosyası oluşturarak başlıkları doğrudan da verebilirsiniz:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
```

> Not: İnternete açık yayınlarda uygulama kodu herkese açıktır, ancak **veriler** yalnızca her cihazın kendi
> şifreli veritabanındadır. Kurum politikası gereği iç ağ yayını tercih edilebilir.

### c) Saha testi için hızlı yöntem

`npm start` → telefonda `https://<bilgisayar-ip>:8443` → sertifika uyarısını geçin. Kendinden imzalı sertifikada
service worker kaydı Chrome tarafından reddedilebilir; bu durumda uygulama çalışır ancak çevrimdışı mod ve
çok iş parçacığı devre dışı kalır (Tanılama ekranında görünür). Kalıcı kullanım için (a) veya (b) önerilir.

Alternatif: USB ile bağlayıp `chrome://inspect` → *Port forwarding* (8443 → localhost:8443) kullanın; telefon
`https://localhost:8443` adresini açar.

## 4. Samsung telefon ayarları

1. **Chrome ile açın** (Samsung Internet değil). Menü → *Ana ekrana ekle / Uygulamayı yükle*.
2. Kamera izni: ilk "Başlat"ta *İzin ver*. Reddedildiyse: adres çubuğu kilit simgesi → İzinler → Kamera.
3. **Pil optimizasyonu**: Ayarlar → Uygulamalar → Chrome → Pil → *Kısıtlanmamış*. (Aksi halde uzun çalışmada
   sistem Chrome'u yavaşlatabilir.)
4. Ekran zaman aşımı: Uygulama kamera açıkken ekranı açık tutar (Wake Lock). Güç tasarrufu modu açıksa
   analiz hızı düşer.
5. Uzun süreli kullanımda telefonu şarja takılı ve serin (doğrudan güneş almayan) bir tutucuda kullanın.
6. Uzak mesafe için: Kamera seçicisinden **tele lensi** seçin (varsa) veya yakınlaştırma çubuğunu kullanın.
   *Ayarlar → Kamera çözünürlüğü* 1440p/4K ve *Uzak mesafe modu* 10 m için önerilir.

## 5. Güncelleme

1. Yeni sürümü sunucuya kopyalayın (`npm run vendor` çalıştırılmış olmalı).
2. Telefonda uygulama açıkken "Yeni sürüm hazır" bildirimi görünür; uygulamayı kapatıp açınca etkinleşir.
3. Veritabanı şeması geriye uyumludur; kayıtlar korunur. Güncellemeden önce *Ayarlar → Şifreli yedek al*
   önerilir.

## 6. Çok cihazlı kullanım

Her telefonun kendi şifreli veritabanı vardır. Kayıtları başka cihaza taşımak için:
yönetici → *Ayarlar → Şifreli yedek al* → dosyayı diğer cihaza aktarın → *Yedekten geri yükle*.
Yedek, kullanıcı parolalarıyla korunan şifreli veriyi içerir; dosya açık metin içermez.
