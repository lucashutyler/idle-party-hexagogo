import { GameClient } from './network/GameClient';
import { getSession, loginWithEmail, verifyToken, pollLoginStatus, setUsername } from './network/AuthClient';
import { ScreenManager } from './screens/ScreenManager';
import { LoginScreen } from './screens/LoginScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import { ApproveScreen } from './screens/ApproveScreen';
import { UsernameScreen } from './screens/UsernameScreen';
import { OfflineScreen } from './screens/OfflineScreen';
import { CombatScreen } from './screens/CombatScreen';
import { MapScreen } from './screens/MapScreen';
import { PlaceholderScreen } from './screens/PlaceholderScreen';
import { CharacterScreen } from './screens/CharacterScreen';
import { ItemsScreen } from './screens/ItemsScreen';
import { SocialScreen } from './screens/SocialScreen';
import { ClassSelectScreen } from './screens/ClassSelectScreen';
import { BottomNav } from './ui/BottomNav';

const CONNECTION_ERROR = 'Could not connect to server';

export class App {
  private gameClient!: GameClient;
  private screenManager: ScreenManager;
  private loginScreen!: LoginScreen;
  private verifyScreen!: VerifyScreen;
  private usernameScreen!: UsernameScreen;
  private offlineScreen!: OfflineScreen;
  private navEl!: HTMLElement;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.screenManager = new ScreenManager();

    // Hide bottom nav until logged in
    this.navEl = document.getElementById('bottom-nav')!;
    this.navEl.style.display = 'none';

    // Offline screen
    this.offlineScreen = new OfflineScreen('screen-offline', () => {
      this.retryConnection();
    });
    this.screenManager.register('offline', document.getElementById('screen-offline')!, this.offlineScreen);

    // Verify screen (magic link landing)
    this.verifyScreen = new VerifyScreen('screen-verify', (token) => {
      this.handleVerify(token);
    });
    this.screenManager.register('verify', document.getElementById('screen-verify')!, this.verifyScreen);

    // Login screen (now email-based)
    this.loginScreen = new LoginScreen('screen-login', (email) => {
      this.handleEmailLogin(email);
    });
    this.screenManager.register('login', document.getElementById('screen-login')!, this.loginScreen);

    // Username choice screen
    this.usernameScreen = new UsernameScreen('screen-username', (username) => {
      this.handleUsernameChoice(username);
    });
    this.screenManager.register('username', document.getElementById('screen-username')!, this.usernameScreen);

    // Check existing session on startup
    this.checkSession();
  }

  private async checkSession(): Promise<void> {
    // Magic link approval landing: /approve?token=...
    if (window.location.pathname === '/approve') {
      const approveScreen = new ApproveScreen('screen-approve');
      this.screenManager.register('approve', document.getElementById('screen-approve')!, approveScreen);
      this.screenManager.switchTo('approve');
      return;
    }

    // Legacy verify landing (dev mode): /verify?token=...
    if (window.location.pathname === '/verify') {
      this.screenManager.switchTo('verify');
      return;
    }

    try {
      const session = await getSession();
      if (session.authenticated && session.username) {
        // Already fully logged in — connect WS and enter game
        await this.connectAndEnterGame();
      } else if (session.authenticated && !session.username) {
        // Authenticated but needs username
        this.screenManager.switchTo('username');
      } else {
        // Not authenticated — show login
        this.screenManager.switchTo('login');
      }
    } catch {
      // Server unreachable
      this.screenManager.switchTo('login');
    }
  }

  private async handleEmailLogin(email: string): Promise<void> {
    this.loginScreen.setLoading(true);

    try {
      const result = await loginWithEmail(email);

      if (result.error) {
        this.loginScreen.showError(result.error);
        this.loginScreen.setLoading(false);
        return;
      }

      if (result.mode === 'dev' && result.token) {
        // Dev mode: auto-verify with the returned token
        const verify = await verifyToken(result.token);
        if (verify.success) {
          if (verify.username) {
            await this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
        } else {
          this.loginScreen.showError(verify.error ?? 'Verification failed');
          this.loginScreen.setLoading(false);
        }
        return;
      }

      // Production mode: email sent, poll for approval
      if (result.loginId) {
        this.loginScreen.showCheckEmail(() => {
          this.stopPolling();
          this.loginScreen.onActivate();
        });
        this.startPolling(result.loginId);
      }
    } catch {
      this.loginScreen.showError('Could not connect to server');
      this.loginScreen.setLoading(false);
    }
  }

  private async handleVerify(token: string): Promise<void> {
    try {
      const result = await verifyToken(token);

      // Clean the URL so /verify?token=... doesn't linger
      history.replaceState(null, '', '/');

      if (result.error) {
        this.verifyScreen.showError(result.error);
        return;
      }

      if (result.success) {
        // Validate the session cookie was actually set by calling /auth/session
        let sessionCheck: Record<string, unknown> | null = null;
        try {
          sessionCheck = await getSession() as unknown as Record<string, unknown>;
        } catch {
          sessionCheck = { error: 'Failed to reach /auth/session' };
        }

        const debug = {
          verifyResponse: result as Record<string, unknown>,
          sessionCheck,
          cookiesEnabled: navigator.cookieEnabled,
          documentCookie: document.cookie,
        };

        const proceed = () => {
          if (result.username) {
            this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
        };

        this.verifyScreen.showSuccess(debug, proceed);
      } else {
        this.verifyScreen.showError('Verification failed. Please try again.');
      }
    } catch {
      this.verifyScreen.showError('Could not connect to server.');
    }
  }

  private async handleUsernameChoice(username: string): Promise<void> {
    this.usernameScreen.setLoading(true);

    try {
      const result = await setUsername(username);

      if (result.error) {
        this.usernameScreen.showError(result.error);
        this.usernameScreen.setLoading(false);
        return;
      }

      await this.connectAndEnterGame();
    } catch {
      this.usernameScreen.showError('Could not connect to server');
      this.usernameScreen.setLoading(false);
    }
  }

  private async connectAndEnterGame(): Promise<void> {
    this.gameClient = new GameClient();
    const result = await this.gameClient.connect();

    if (!result.success) {
      if (result.error === CONNECTION_ERROR) {
        this.screenManager.switchTo('offline');
        return;
      }
      this.screenManager.switchTo('login');
      return;
    }

    // Check if player needs to select a class (new player or reset Adventurer)
    if (this.gameClient.lastState?.character.className === 'Adventurer') {
      const classScreen = new ClassSelectScreen('screen-class-select', this.gameClient, () => {
        this.enterGame();
      });
      this.screenManager.register('class-select', document.getElementById('screen-class-select')!, classScreen);
      this.screenManager.switchTo('class-select');
      return;
    }

    this.enterGame();
  }

  private async retryConnection(): Promise<void> {
    // Re-check session (cookie may still be valid) and retry WS
    try {
      const session = await getSession();
      if (!session.authenticated || !session.username) {
        this.screenManager.switchTo('login');
        return;
      }

      await this.connectAndEnterGame();
    } catch {
      this.offlineScreen.setRetrying(false);
    }
  }

  private startPolling(loginId: string): void {
    this.stopPolling();

    this.pollTimer = setInterval(async () => {
      try {
        const result = await pollLoginStatus(loginId);

        if (result.status === 'approved') {
          this.stopPolling();
          if (result.username) {
            await this.connectAndEnterGame();
          } else {
            this.screenManager.switchTo('username');
          }
          return;
        }

        if (result.status === 'expired') {
          this.stopPolling();
          this.loginScreen.showExpired();
          return;
        }
      } catch {
        // Network error during poll: keep trying silently
      }
    }, 2000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private enterGame(): void {
    const combatScreen = new CombatScreen('screen-combat', this.gameClient);
    const mapScreen = new MapScreen('screen-map', this.gameClient);
    const characterScreen = new CharacterScreen('screen-character', this.gameClient);
    const itemsScreen = new ItemsScreen('screen-items', this.gameClient);
    const socialScreen = new SocialScreen('screen-social', this.gameClient);
    const settingsScreen = new PlaceholderScreen('screen-settings', 'Settings', '⚙');

    // Wire map chat button to social screen DM
    mapScreen.setOnChat((username) => {
      this.screenManager.switchTo('social');
      socialScreen.startDm(username);
    });

    this.screenManager.register('combat', document.getElementById('screen-combat')!, combatScreen);
    this.screenManager.register('map', document.getElementById('screen-map')!, mapScreen);
    this.screenManager.register('character', document.getElementById('screen-character')!, characterScreen);
    this.screenManager.register('items', document.getElementById('screen-items')!, itemsScreen);
    this.screenManager.register('social', document.getElementById('screen-social')!, socialScreen);
    this.screenManager.register('settings', document.getElementById('screen-settings')!, settingsScreen);

    // Show bottom nav
    this.navEl.style.display = '';

    const savedScreen = sessionStorage.getItem('activeScreen') ?? 'combat';

    new BottomNav(
      [
        { id: 'combat', label: 'Combat', icon: '⚔' },
        { id: 'map', label: 'Map', icon: '🗺' },
        { id: 'character', label: 'Char', icon: '👤' },
        { id: 'items', label: 'Items', icon: '🎒' },
        { id: 'social', label: 'Social', icon: '💬' },
        { id: 'settings', label: 'Settings', icon: '⚙' },
      ],
      savedScreen,
      (tabId) => this.screenManager.switchTo(tabId),
      this.gameClient,
    );

    // Switch to saved screen (or combat by default)
    this.screenManager.switchTo(savedScreen);
  }
}
