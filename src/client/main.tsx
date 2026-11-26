import { render } from 'preact';
import { App } from './app';
import './styles.css';

render(<App />, document.getElementById('app')!);

// iOS pans the page to keep a focused input above the keyboard and can leave it
// shifted afterwards. The page never scrolls on purpose, so put it back.
window.addEventListener('focusout', () => window.scrollTo(0, 0));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
