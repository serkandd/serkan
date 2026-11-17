# Veritabanı Yapısı ve Veri Güvenliği

## 1. Depolama

Tarayıcının **IndexedDB** veritabanı (`guvenlik-asistani`, şema sürümü 1). Uygulama ilk girişte kalıcı depolama
(`navigator.storage.persist()`) ister; böylece tarayıcı veriyi kendiliğinden silmez.

| Depo | Anahtar | Alanlar | İçerik |
|---|---|---|---|
| `meta` | `key` | `value` | Kurulum bilgisi, ayarlar, işlem kaydı zincir başı, hatalı giriş sayaçları |
| `users` | `id` | `username`, `role`, `wrap{salt,wrapped,iterations}`, `disabled`, `createdAt` | Kullanıcılar |
| `personnel` | `id` | `enc{iv,ct}`, `updatedAt` | **Şifreli** personel kaydı |
| `vehicles` | `id` | `enc{iv,ct}`, `updatedAt` | **Şifreli** araç kaydı |
| `events` | `id` | `ts`(indeks), `kind`, `enc`, `thumb{iv,ct}?` | **Şifreli** algılama olayları |
| `audit` | `id` | `ts`(indeks), `enc`, `prev`, `hash` | **Şifreli**, hash zincirli işlem kayıtları |

### Şifreli içerik şemaları

**Personel** (`personnel.enc` çözülmüş hâli)
```json
{
  "employeeNo": "P-001", "fullName": "Ad Soyad", "department": "Güvenlik",
  "status": "authorized | unauthorized",
  "consent": { "informed": true, "legalBasis": "KVKK m.6 açık rıza, belge 2026/145", "recordedAt": 0, "by": "yonetici" },
  "retentionUntil": "2027-12-31",
  "descriptors": [[128 sayı], ...],
  "createdAt": 0, "createdBy": "yonetici"
}
```
Yüz şablonu (128 boyutlu sayı dizisi) ve canlı kayıtta çekilen küçük yüz resmi (`photo`, ~160 px) şifreli tutulur.
Personel formundan yüklenen tam boy fotoğraflar saklanmaz.

**Araç**
```json
{ "plate": "34 ABC 123", "plateKey": "34ABC123", "owner": "", "company": "", "description": "",
  "status": "authorized | unauthorized", "validUntil": "2027-01-31 | null", "createdAt": 0, "createdBy": "" }
```

**Olay**
```json
{ "kind": "plate | face", "result": "authorized | registered-unauthorized | not-registered | unreadable |
  verified-authorized | verified-unauthorized | unregistered", "label": "", "trackId": "P3", "confidence": 92,
  "plate": "34ABC123", "plateFormatted": "34 ABC 123", "vehicleId": "", "owner": "", "company": "",
  "personId": "", "employeeNo": "", "fullName": "",
  "review": { "decision": "confirmed | rejected", "by": "", "at": 0, "note": "" } }
```
Olaylarda isteğe bağlı küçük görüntü (`thumb`, şifreli JPEG): plaka kırpıntısı veya ~128 px yüz resmi.
Her ikisi de Ayarlar'dan kapatılabilir. Araç kayıtları araç fotoğrafını (`photo`, ~480 px), plaka görüntüsünü,
renk/tür/marka/modeli, görülme sayısını ve elle düzeltilmiş plakaların eski okumalarını (`aliases`) içerir.

**İşlem kaydı (audit)**: `{ action, target, details, user, role }` — `hash = SHA256(prev + ts + iv + ct)`.
Kayıtlardan biri silinir veya değiştirilirse *Ayarlar → İşlem Kayıtları → Zinciri doğrula* tutarsızlığı bildirir.

## 2. Şifreleme

```
PIN (4 hane) ──PBKDF2-SHA256 (310.000 tur, 16 bayt rastgele tuz)──► KEK (AES-KW 256)
                                                             │ wrap / unwrap
Rastgele DEK (AES-GCM 256) ◄─────────────────────────────────┘
   │
   └──► Her kayıt: AES-GCM, kayıt başına 12 bayt rastgele IV
```

- Her kullanıcının kaydında DEK, **o kullanıcının parolasıyla** sarılmış olarak durur. Parola saklanmaz.
- Giriş = DEK'in çözülebilmesi. DEK yalnızca oturum açıkken bellekte tutulur; görevli oturumlarında
  dışa aktarılamaz (`extractable: false`).
- Hatalı girişlerde 3. denemeden sonra artan bekleme (15 sn'den 15 dk'ya kadar).
- **Uyarı:** 4 haneli PIN yalnızca 10.000 olasılıktır. Uygulama içinde bekleme süreleri tahmini engeller, ancak
  telefonun dosyalarına doğrudan erişen biri şifreli veritabanını bilgisayarda kısa sürede çözebilir. Telefonun
  ekran kilidi ve cihaz şifrelemesi açık tutulmalıdır.
- **Parola kurtarma yoktur**: tüm yönetici parolaları unutulursa veriler çözülemez. En az iki yönetici hesabı
  ve düzenli şifreli yedek önerilir.

## 3. Roller

| Yetki | Yönetici | Güvenlik Görevlisi |
|---|:-:|:-:|
| Canlı analiz, olay listesi, olay onay/red | ✔ | ✔ |
| Personel kayıtları (ekle/düzenle/sil, şablon) | ✔ | — |
| Araç kayıtları | ✔ | — |
| Kullanıcı yönetimi, ayarlar, işlem kayıtları | ✔ | — |
| Yedek alma / geri yükleme, toplu silme | ✔ | — |

Görevli, karşılaştırma yapılabilmesi için kayıtları **okuyabilir** (bellekte çözülür) ancak yönetim
ekranlarına erişemez. Yönetim ekranları hareketsizlik sonrası yeniden parola ister; kamera kapalıyken oturum
tamamen kilitlenir (varsayılan 5 dk).

## 4. Saklama ve Silme Politikası

| Veri | Varsayılan | Ayar |
|---|---|---|
| Algılama olayları | 30 gün | Ayarlar → Gizlilik ve saklama |
| İşlem kayıtları | 365 gün | Ayarlar → Gizlilik ve saklama |
| Personel kaydı + şablonlar | Kayıttaki "Veri saklama bitiş tarihi" | Personel formu |
| Araç yetkisi | "Yetki bitiş tarihi" geçince *yetkisiz* sayılır (kayıt silinmez) | Araç formu |

Saklama politikası her girişte otomatik uygulanır; *Saklama politikasını uygula* ile elle de çalıştırılabilir.
Silme işlemleri işlem kaydına yazılır. Personel silindiğinde tüm biyometrik şablonları da silinir.

## 5. Yedekleme

*Ayarlar → Şifreli yedek al* JSON dosyası üretir: kullanıcılar (sarılmış anahtarlarla), şifreli personel ve araç
kayıtları, ayarlar. Dosya açık metin içermez. Geri yüklemede mevcut kayıtlar, olaylar ve işlem kayıtları
temizlenir; yedekteki kullanıcı parolalarıyla yeniden giriş yapılır.
