import './styles/pixel-theme.css';
import { App } from './App';

new App();

// Resize #app when the mobile virtual keyboard opens/closes.
// visualViewport shrinks when the keyboard appears; we match #app to it
// so the bottom nav and chat input stay visible above the keyboard.
if (window.visualViewport) {
  const app = document.getElementById('app')!;
  const onViewportResize = () => {
    const vv = window.visualViewport!;
    app.style.height = `${vv.height}px`;
    // Offset top in case the viewport scrolled (iOS Safari)
    app.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
}
