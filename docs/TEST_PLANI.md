# Test Planı ve Kabul Kriterleri

## 1. Otomatik testler (geliştirme ortamında yapıldı)

| Komut | Kapsam | Son sonuç |
|---|---|---|
| `npm test` | 32 birim testi: Türk plaka formatı ve konumsal düzeltme, belirsiz/aşırı düzeltmede tahmin yapmama, takip numarası kararlılığı, titreşim yumuşatma, çoklu nesne, oylama, tekrar bildirim, yüz eşleştirme (kayıtsız kişiye isim atanmaması, belirsiz eşleşme), plaka bulucu (sentetik sahne, uzak/küçük plaka, boş sahne), OCR ön işleme ve kalite kapısı, şifreleme, roller, hukuki onay zorunluluğu, hash zinciri kurcalama tespiti | 32/32 ✔ |
| `npm run e2e` | Headless Chromium + gerçek modeller + sahte kamera akışı (4 kişilik gerçek fotoğraf + hareketli Türk plakası) | 22/22 ✔ |

Uçtan uca testte doğrulananlar: service worker ile çapraz köken izolasyonu, tüm modellerin yüklenmesi,
araç kaydı ve geçersiz plaka reddi, hukuki onay olmadan şablon çıkarılmaması, fotoğraftan şablon çıkarma,
canlı plaka okuma (`34 ABC 123`, ~6 sn) ve *Kayıtlı ve yetkili* sonucu, 4 yüzün eşzamanlı takibi, kayıtlı kişinin
doğrulanması ve diğer 3 kişiye isim atanmaması, hareketli plakada takip numarasının korunması, aynı plakanın tek
kez kaydedilmesi, plaka olmayan desenlerin (jaluzi) olay üretmemesi, 412 px genişlikte taşma olmaması.

> Bu testler yazılımın doğru çalıştığını gösterir; **gerçek kamera, gerçek mesafe ve gerçek plaka koşullarındaki
> başarımı göstermez.** Aşağıdaki saha testleri Samsung cihazda yapılmalıdır.

## 2. Mesafe ve piksel bütçesi

Başarıyı belirleyen mesafe değil, hedefin görüntüde kapladığı **piksel** sayısıdır.

Yatay görüş açısı θ olan kamerada, d mesafesinde görüntü genişliği `W = 2·d·tan(θ/2)` metredir.
Hedefin piksel genişliği: `p = (hedef genişliği / W) × yatay çözünürlük`.

Tipik Samsung ana kamera (θ ≈ 70°), Türk plakası 52 cm, yüz ≈ 16 cm:

| Mesafe | Çözünürlük | Plaka genişliği | Karakter yüksekliği | Yüz genişliği |
|---|---|---|---|---|
| 5 m | 1080p (1920) | ~143 px | ~20 px | ~44 px |
| 5 m | 4K (3840) | ~285 px | ~40 px | ~88 px |
| 10 m | 1080p | ~71 px | ~10 px | ~22 px |
| 10 m | 4K | ~143 px | ~20 px | ~44 px |
| 10 m | 1080p + 3× tele lens | ~214 px | ~30 px | ~66 px |

Gereksinimler (uygulama varsayılanları): OCR için karakter yüksekliği **≥ 15-20 px**, kimlik doğrulama için
yüz genişliği **≥ 72 px**, yalnızca yüz algılama için **≥ ~20 px** (uzak mesafe modu ile).

Sonuç: 5 m'de 1080p ile plaka okunur, yüz algılanır; kimlik doğrulama için 4K veya yakınlaştırma gerekir.
10 m'de plaka ve kimlik için **tele lens (optik yakınlaştırma)** veya 4K + uzak mesafe modu gerekir. Dijital
yakınlaştırma piksel eklemez; yalnızca model girişine düşen ölçeği iyileştirir.

## 3. Saha testi prosedürü (Samsung + Chrome)

### Hazırlık
- Uygulama geçerli HTTPS adresinden açılmış, *Ana ekrana ekle* ile yüklenmiş olmalı.
- *Ayarlar → Sistem Tanılama*: tüm modeller "hazır", *Çapraz köken izolasyonu: etkin*.
- 3 test personeli (aydınlatılmış, açık rızalı) ve 5 test aracı kaydedilmiş olmalı; en az 1 araç *yetkisiz*.
- Telefon tripod/tutucuda, 1,5 m yükseklikte; mesafeler şerit metreyle işaretlenmiş.
- Önceki olaylar temizlenmiş (*Ayarlar → Tüm olayları sil*).

### T1 — Yüz, 5 m ve T2 — Yüz, 10 m (ayrı ayrı)
1. Çözünürlük 1080p, ardından 4K; her biri için uzak mesafe modu kapalı/açık.
2. Her test kişisi işaretli noktada 10 sn önden, 10 sn 30° açıyla durur; ardından yürüyerek geçer.
3. 2 kayıtsız kişi aynı adımları tekrarlar. Bir turda 2-3 kişi aynı anda kadraja girer.
4. Görevli her olayı *Doğru – onayla* / *Hatalı algılama* ile işaretler.
5. Ölç: algılama oranı (kutu çıkan kişi / toplam), doğrulama oranı, **yanlış eşleşme** (kayıtsız kişiye isim
   veya yanlış isim — hedef: **0**), takip numarası değişimi (yürüyüş boyunca).

### T3 — Plaka, 5 m ve T4 — Plaka, 10 m (ayrı ayrı)
1. 5 kayıtlı + 3 kayıtsız araç; duran araç (10 sn) ve 10-20 km/s geçiş.
2. Gündüz, alacakaranlık, gece (far açık) ve mümkünse yağmurda tekrar.
3. Ölç: tespit oranı, doğru okuma oranı, **yanlış okuma** (format geçerli ama yanlış plaka — hedef: ≤ %1),
   "okunamadı" oranı, ilk okuma süresi, aynı aracın tekrar kaydı (hedef: 0).

### T5 — 30 dakika kesintisiz çalışma
1. Şarj takılı ve takılı değil olarak iki ayrı test. Arka kamera, 1080p, yüz + plaka açık.
2. Her 5 dakikada *Tanılama* ekranından not alın: yüz/plaka süreleri, JS bellek, TF.js tensör sayısı, pil
   yüzdesi, işlemci baskısı uyarıları.
3. Kabul: uygulama çökmez/donmaz; TF.js tensör sayısı sabit kalır (bellek sızıntısı yok); JS belleği sürekli
   artmaz; ısınma uyarısında analiz hızı düşer ama durmaz.

### T6 — Hata durumları
| Senaryo | Beklenen |
|---|---|
| Kamera iznini reddet | Anlaşılır uyarı, uygulama çalışır |
| Çalışırken başka uygulamada kamerayı aç | "Bağlantı koptu → yeniden bağlanılıyor", sonra devam |
| Uçak modu | "Çevrimdışı" rozeti, analiz sürer |
| Lensi değiştir / ön kameraya geç | Kutular aynalı görüntüde doğru konumda |
| Telefonu yan çevir | Kutular kaymaz |
| Uygulamayı arka plana al, geri dön | Analiz durur, geri dönünce devam eder |

## 4. Ölçüm ve raporlama

*Kayıtlar → Saha testi raporu* görevli işaretlemelerinden plaka doğruluğu ve yüz doğruluğunu hesaplar;
*CSV olarak dışa aktar* ile tüm olaylar (sonuç, güven, takip no, inceleme) tabloya aktarılır.

Önerilen metrikler:
- **Plaka doğru okuma oranı** = doğru / (doğru + yanlış okuma)
- **Yanlış eşleşme oranı (FMR)** = kayıtsız kişiye/yanlış kişiye verilen kimlik sonucu / toplam kimlik sonucu
- **Doğrulama oranı** = doğrulanan kayıtlı personel geçişi / toplam kayıtlı personel geçişi

## 5. Kabul formu

| # | Kriter | 5 m | 10 m | Not |
|---|---|---|---|---|
| 1 | Samsung + Chrome'da açılıyor, PWA olarak yükleniyor | ☐ | | |
| 2 | Kamera canlı görüntü veriyor (ön/arka, lens seçimi) | ☐ | | |
| 3 | Yüzler gerçek zamanlı algılanıyor, çerçeve hareketle izliyor | ☐ | ☐ | |
| 4 | Plakalar gerçek zamanlı algılanıyor | ☐ | ☐ | |
| 5 | Türk plakaları doğru okunuyor (oran: ____ %) | ☐ | ☐ | |
| 6 | Kayıtlı araç karşılaştırması 4 sonucu doğru gösteriyor | ☐ | ☐ | |
| 7 | İzinli personel doğrulaması çalışıyor (oran: ____ %) | ☐ | ☐ | |
| 8 | Kayıtsız kişilere isim atanmıyor (yanlış eşleşme: ____ ) | ☐ | ☐ | |
| 9 | Birden fazla yüz ve plaka eşzamanlı işleniyor | ☐ | ☐ | |
| 10 | 30 dk kesintisiz çalışma (şarjda / pilde) | ☐ | | |
| 11 | Hata durumları (T6) | ☐ | | |
