import { GameClient } from './network/GameClient';
import { ScreenManager } from './screens/ScreenManager';
import { LoginScreen } from './screens/LoginScreen';
import { OfflineScreen } from './screens/OfflineScreen';
import { CombatScreen } from './screens/CombatScreen';
import { MapScreen } from './screens/MapScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { BottomNav } from './ui/BottomNav';

const CONNECTION_ERROR = 'Could not connect to server';

export class App {
  private gameClient: GameClient;
  private screenManager: ScreenManager;
  private loginScreen!: LoginScreen;
  private offlineScreen!: OfflineScreen;
  private navEl!: HTMLElement;
  private pendingUsername: string | null = null;

  constructor() {
    // 1. Shared WebSocket client (does not connect until login)
    this.gameClient = new GameClient();

    // 2. Screen manager
    this.screenManager = new ScreenManager();

    // 3. Hide bottom nav until logged in
    this.navEl = document.getElementById('bottom-nav')!;
    this.navEl.style.display = 'none';

    // 4. Offline screen (registered but not shown by default)
    this.offlineScreen = new OfflineScreen('screen-offline', () => {
      this.retryConnection();
    });
    this.screenManager.register('offline', document.getElementById('screen-offline')!, this.offlineScreen);

    // 5. Login screen
    this.loginScreen = new LoginScreen('screen-login', (username) => {
      this.handleLogin(username);
    });
    this.screenManager.register('login', document.getElementById('screen-login')!, this.loginScreen);

    this.screenManager.switchTo('login');
  }

  private async handleLogin(username: string): Promise<void> {
    this.loginScreen.setLoading(true);
    this.pendingUsername = username;

    const result = await this.gameClient.login(username);

    if (!result.success) {
      if (result.error === CONNECTION_ERROR) {
        this.screenManager.switchTo('offline');
        return;
      }
      this.loginScreen.showError(result.error ?? 'Login failed');
      this.loginScreen.setLoading(false);
      return;
    }

    this.enterGame();
  }

  private async retryConnection(): Promise<void> {
    if (!this.pendingUsername) {
      this.screenManager.switchTo('login');
      this.loginScreen.setLoading(false);
      return;
    }

    // Destroy old client and create a fresh one
    this.gameClient.destroy();
    this.gameClient = new GameClient();

    const result = await this.gameClient.login(this.pendingUsername);

    if (!result.success) {
      this.offlineScreen.setRetrying(false);
      return;
    }

    this.enterGame();
  }

  private enterGame(): void {
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
    this.navEl.style.display = '';

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
