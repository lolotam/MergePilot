/* global localStorage, document */
// Applies a saved Arabic choice before the first paint, so the page never flashes LTR.
try {
  if (localStorage.getItem('mergepilot_lang') === 'ar') {
    document.documentElement.lang = 'ar';
    document.documentElement.dir = 'rtl';
  }
} catch {
  // Storage blocked: keep the English default.
}
