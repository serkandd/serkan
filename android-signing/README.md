# APK imza anahtarı

Android, bir uygulamanın yeni sürümünü **yalnızca aynı anahtarla imzalanmışsa** eskisinin üzerine kurar
(veriler korunur). Bu anahtar her derlemede aynı olsun diye depoda tutulur; CI (`.github/workflows/android.yml`)
derlemeden önce onu `~/.android/debug.keystore` olarak kullanır.

- Tür: Android hata ayıklama (debug) anahtarı biçimi — parola `android`, takma ad `androiddebugkey`
- Bu bir **dağıtım güvenliği** anahtarı değildir: depo herkese açık olduğundan başkası da bu anahtarla APK
  imzalayabilir. Uygulamayı yalnızca bu deponun Sürümler (Releases) sayfasından indirin.
- Google Play'e yüklenecekse ayrı, gizli bir yükleme anahtarı oluşturulmalı ve GitHub Secrets'ta saklanmalıdır.
