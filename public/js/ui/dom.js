/** Küçük DOM yardımcıları */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(msg, kind = 'info', ms = 3500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
  while (box.children.length > 4) box.firstChild.remove();
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString('tr-TR')} ${t}`;
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.type === 'submit' || el.tagName === 'BUTTON') continue;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

export function fillForm(form, data) {
  for (const el of form.elements) {
    if (!el.name || el.type === 'file' || el.tagName === 'BUTTON') continue;
    const v = data[el.name];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
}

/** Basit onay penceresi (Promise<boolean>) */
export function confirmBox(message, okText = 'Evet') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.innerHTML = `<form method="dialog" class="stack"><p>${esc(message)}</p>
      <div class="row end"><button class="btn" value="no">Vazgeç</button><button class="btn primary" value="yes">${esc(okText)}</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
    d.showModal();
  });
}

/** Parola isteyen pencere (Promise<string|null>) */
export function passwordBox(message) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.innerHTML = `<form method="dialog" class="stack"><p>${esc(message)}</p>
      <input type="password" name="pw" autocomplete="current-password" required>
      <div class="row end"><button class="btn" value="no" formnovalidate>Vazgeç</button><button class="btn primary" value="yes">Onayla</button></div></form>`;
    document.body.appendChild(d);
    d.addEventListener('close', () => {
      resolve(d.returnValue === 'yes' ? d.querySelector('input').value : null);
      d.remove();
    });
    d.showModal();
    d.querySelector('input').focus();
  });
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
