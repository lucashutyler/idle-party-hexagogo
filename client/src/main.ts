import './styles/pixel-theme.css';
import './styles/charitems.css';
import './styles/crafting.css';
import './styles/mobile-theme.css';
import './styles/combat.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/chat.css';
import './styles/map.css';
import './styles/hero.css';
import './styles/social.css';
import './styles/popups.css';
import { App } from './App';
import { registerServiceWorker } from './network/PushNotifications';

new App();
registerServiceWorker();

// Keeps the chat composer above the phone keyboard.
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
