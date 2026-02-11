import { GameClient } from './network/GameClient';
import { ScreenManager } from './screens/ScreenManager';
import { LoginScreen } from './screens/LoginScreen';
import { CombatScreen } from './screens/CombatScreen';
import { MapScreen } from './screens/MapScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { BottomNav } from './ui/BottomNav';

export class App {
  private gameClient: GameClient;
  private screenManager: ScreenManager;

  constructor() {
    // 1. Shared WebSocket client (does not connect until login)
    this.gameClient = new GameClient();

    // 2. Screen manager
    this.screenManager = new ScreenManager();

    // 3. Hide bottom nav until logged in
    const navEl = document.getElementById('bottom-nav')!;
    navEl.style.display = 'none';

    // 4. Login screen
    const loginScreen = new LoginScreen('screen-login', (username) => {
      this.handleLogin(username, loginScreen, navEl);
    });

    this.screenManager.register('login', document.getElementById('screen-login')!, loginScreen);
    this.screenManager.switchTo('login');
  }

  private async handleLogin(username: string, loginScreen: LoginScreen, navEl: HTMLElement): Promise<void> {
    loginScreen.setLoading(true);

    const result = await this.gameClient.login(username);

    if (!result.success) {
      loginScreen.showError(result.error ?? 'Login failed');
      loginScreen.setLoading(false);
      return;
    }

    // Login succeeded — build the game UI
    const combatScreen = new CombatScreen('screen-combat', this.gameClient);
    const mapScreen = new MapScreen('screen-map', this.gameClient);
    const partyScreen = new PlaceholderScreen('screen-party', 'Party', '👤');
    const itemsScreen = new PlaceholderScreen('screen-items', 'Items', '🎒');
    const settingsScreen = new PlaceholderScreen('screen-settings', 'Settings', '⚙');

    this.screenManager.register('combat', document.getElementById('screen-combat')!, combatScreen);
    this.screenManager.register('map', document.getElementById('screen-map')!, mapScreen);
    this.screenManager.register('party', document.getElementById('screen-party')!, partyScreen);
    this.screenManager.register('items', document.getElementById('screen-items')!, itemsScreen);
    this.screenManager.register('settings', document.getElementById('screen-settings')!, settingsScreen);

    // Show bottom nav
    navEl.style.display = '';

    new BottomNav(
      [
        { id: 'combat', label: 'Combat', icon: '⚔' },
        { id: 'map', label: 'Map', icon: '🗺' },
        { id: 'party', label: 'Party', icon: '👤' },
        { id: 'items', label: 'Items', icon: '🎒' },
        { id: 'settings', label: 'Settings', icon: '⚙' },
      ],
      'combat',
      (tabId) => this.screenManager.switchTo(tabId),
      this.gameClient,
    );

    // Switch to combat screen
    this.screenManager.switchTo('combat');
  }
}
