import { render } from 'preact';
import { App } from './app';
import './styles.css';

render(<App />, document.getElementById('app')!);

// iOS pans the page to keep a focused input above the keyboard and can leave it
// shifted afterwards. The page never scrolls on purpose, so put it back.
window.addEventListener('focusout', () => window.scrollTo(0, 0));

// The app is a fixed-size game board, so zooming only ever breaks the layout.
// iOS Safari ignores the viewport's user-scalable=no; cancelling its pinch gesture
// events (and ctrl/cmd + wheel on desktop) is what actually stops it.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}
document.addEventListener('wheel', (event) => { if (event.ctrlKey) event.preventDefault(); }, { passive: false });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
