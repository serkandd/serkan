# Kişisel Verilerin Korunması — Uygulama Notları

> Bu belge hukuki görüş değildir. Uygulamanın devreye alınmasından önce kurumun hukuk birimi / veri sorumlusu
> temsilcisi tarafından değerlendirilmelidir.

## 1. İşlenen veriler

| Veri | Niteliği | Uygulamadaki karşılığı |
|---|---|---|
| Canlı kamera görüntüsü | Kişisel veri (görüntü) | Yalnızca bellekte işlenir, **kaydedilmez** |
| Yüz şablonu (128 sayı) | **Özel nitelikli kişisel veri** (biyometrik, KVKK m.6) | Yalnızca kayıtlı personel için, şifreli |
| Personel adı, numarası, yetki durumu | Kişisel veri | Şifreli |
| Plaka, araç sahibi/şirket | Kişisel veri | Şifreli |
| Algılama olayları, plaka küçük resmi | Kişisel veri | Şifreli, saklama süreli |
| İşlem kayıtları | Kişisel veri (kullanıcı adı) | Şifreli, hash zincirli |

## 2. Uygulamada yerleşik güvenceler

1. **Ayrık modüller**: Yüz *algılama* (anonim, kimlik içermez) ile kimlik *doğrulama* ayrıdır. Kayıtlı şablon
   yoksa doğrulama hiç çalışmaz.
2. **Yalnızca izinli kayıtlar**: Biyometrik şablon, personel formunda "aydınlatma yapıldı ve hukuki şartlar
   sağlandı" onayı ve hukuki dayanak/rıza belge referansı girilmeden çıkarılamaz ve kaydedilemez.
3. **Kayıtsız kişiler**: Tahmin yapılmaz, isim atanmaz; yalnızca geçici takip numarası gösterilir. Takip
   numaraları kalıcı değildir, kişiyle ilişkilendirilmez.
4. **Veri minimizasyonu**: Kayıt fotoğrafları şablon çıkarıldıktan sonra bellekten atılır. Canlı görüntüden
   yüz resmi kaydedilmez. Plaka küçük resmi ayardan kapatılabilir.
5. **Şifreleme**: AES-GCM 256, parola türevli anahtar sarma (bkz. VERITABANI.md).
6. **Erişim kontrolü**: Yönetici / görevli rolleri, hareketsizlikte kilit, hatalı girişte bekleme.
7. **Saklama ve imha**: Olaylar, işlem kayıtları ve personel kayıtları için süre sınırı; süresi dolanlar
   otomatik silinir ve silme işlem kaydına yazılır.
8. **İnsan denetimi**: Sonuçlar karar destek niteliğindedir; görevli her uyarıyı onaylar ya da "hatalı algılama"
   olarak işaretler. Sistem otomatik kapı açma/engelleme gibi bir işlem yapmaz.
9. **Hesap verebilirlik**: Tüm yönetim işlemleri (kayıt ekleme/silme, ayar değişikliği, giriş/çıkış, dışa
   aktarma) değiştirilemezliği doğrulanabilen işlem kaydına yazılır.
10. **Görüntü cihaz dışına çıkmaz**: Analiz telefonda yapılır; bulut servisi kullanılmaz.

## 3. Kurumun yapması gerekenler (kontrol listesi)

- [ ] Biyometrik veri işleme için hukuki dayanağın belirlenmesi (KVKK m.6: açık rıza veya kanunda öngörülme).
      Açık rızanın özgür iradeyle verilebilmesi için **alternatif doğrulama yöntemi** (kart, görevli kontrolü)
      sunulmalıdır.
- [ ] Personele ve ziyaretçilere aydınlatma metni; alana kamera/plaka tanıma bilgilendirme levhası.
- [ ] VERBİS kaydının güncellenmesi, veri işleme envanterine eklenmesi.
- [ ] Saklama ve imha politikasında sürelerin belirlenmesi ve uygulamadaki ayarlarla eşleştirilmesi.
- [ ] Kişisel veri işleme etki değerlendirmesi (özellikle biyometrik veri için).
- [ ] Kullanıcı (görevli) eğitimi: sonuçların karar destek niteliği, hatalı algılamanın işaretlenmesi.
- [ ] Cihaz güvenliği: ekran kilidi, cihaz şifrelemesi, kayıp cihaz prosedürü (uzaktan silme).
- [ ] İlgili kişi başvurularında (silme, bilgi talebi) personel kaydının silinmesi — *Personel → Kaydı Sil*.
