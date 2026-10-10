/* eslint-disable no-undef */
// Pre-paint theme: this runs as a blocking script in <head>, before the app
// bundle and the first frame, so a saved dark room never flashes light. The
// key and values stay in step with THEME_KEY in src/App.tsx (any value other
// than "dark" means light, which is the palette's default).
try {
  if (localStorage.getItem('airtext-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark'
    document.querySelector('meta[name="theme-color"]').setAttribute('content', '#191d1b')
  }
} catch {
  /* private mode: light is the correct default */
}
