import { GameClient } from './network/GameClient';
import { WorldCache } from './network/WorldCache';
import { getSession, loginWithEmail, verifyToken, pollLoginStatus, setUsername } from './network/AuthClient';
import { ScreenManager } from './screens/ScreenManager';
import { LoginScreen } from './screens/LoginScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import { ApproveScreen } from './screens/ApproveScreen';
import { UsernameScreen } from './screens/UsernameScreen';
import { OfflineScreen } from './screens/OfflineScreen';
import { CombatScreen } from './screens/CombatScreen';
import { MapScreen } from './screens/MapScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { CharItemsScreen } from './screens/CharItemsScreen';
import { SocialScreen } from './screens/SocialScreen';
import { ClassSelectScreen } from './screens/ClassSelectScreen';
import { SuspensionScreen } from './screens/SuspensionScreen';
import { BottomNav } from './ui/BottomNav';
import { ChatLocalStore } from './network/ChatLocalStore';
import { ChatPopout } from './ui/ChatPopout';
import { PersistentXpBar } from './ui/PersistentXpBar';

const CONNECTION_ERROR = 'Could not connect to server';

export class App {
  private gameClient!: GameClient;
  private worldCache = new WorldCache();
  private chatStore = new ChatLocalStore();
  private screenManager: ScreenManager;
  private loginScreen!: LoginScreen;
  private verifyScreen!: VerifyScreen;
  private usernameScreen!: UsernameScreen;
  private offlineScreen!: OfflineScreen;
  private suspensionScreen!: SuspensionScreen;
  private navEl!: HTMLElement;
  private xpBarEl!: HTMLElement;
  private chatPopout?: ChatPopout;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.screenManager = new ScreenManager();

    // Hide bottom nav + persistent xp bar until logged in
    this.navEl = document.getElementById('bottom-nav')!;
    this.navEl.style.display = 'none';
    this.xpBarEl = document.getElementById('persistent-xp-bar')!;
    this.xpBarEl.style.display = 'none';

    // Splash overlay: minimum 2-second hold, then fade once the window has
    // finished loading. Whichever takes longer wins — fast loads still see
    // a full 2 seconds of brand frame; slow loads get held until ready.
    const startedAt = Date.now();
    const MIN_HOLD_MS = 2000;
    const dismissWhenReady = () => {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, MIN_HOLD_MS - elapsed);
      setTimeout(() => {
        const splash = document.getElementById('splash');
        if (!splash || splash.classList.contains('hidden')) return;
        splash.classList.add('hidden');
        setTimeout(() => splash.remove(), 600);
      }, remaining);
    };
    if (document.readyState === 'complete') {
      dismissWhenReady();
    } else {
      window.addEventListener('load', dismissWhenReady, { once: true });
    }

    // Offline screen
    this.offlineScreen = new OfflineScreen('screen-offline', () => {
      this.retryConnection();
    });
    this.screenManager.register('offline', document.getElementById('screen-offline')!, this.offlineScreen);

    // Suspension screen
    this.suspensionScreen = new SuspensionScreen('screen-suspended');
    this.screenManager.register('suspended', document.getElementById('screen-suspended')!, this.suspensionScreen);

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
      if (session.deactivated) {
        this.showSuspensionScreen(session.email);
        return;
      }
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

      if (result.deactivated) {
        this.showSuspensionScreen(result.email ?? email);
        return;
      }

      if (result.error) {
        this.loginScreen.showError(result.error);
        this.loginScreen.setLoading(false);
        return;
      }

      if (result.mode === 'dev' && result.token) {
        // Dev mode: auto-verify with the returned token
        const verify = await verifyToken(result.token);
        if (verify.deactivated) {
          this.showSuspensionScreen(verify.email ?? email);
          return;
        }
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

    // Listen for account suspension (admin kicked while playing)
    this.gameClient.onSuspension(() => {
      this.showSuspensionScreen();
    });

    // Connect WS first (creates PlayerSession server-side), then load world data
    // (world endpoint requires the player session to exist)
    const connectResult = await this.gameClient.connect();

    if (!connectResult.success) {
      if (connectResult.error === CONNECTION_ERROR) {
        this.screenManager.switchTo('offline');
        return;
      }
      this.screenManager.switchTo('login');
      return;
    }

    // Load world data now that the player session exists server-side
    await this.worldCache.loadWorld().catch(async () => {
      // Retry once after a brief delay (session may not be fully persisted yet)
      await new Promise(r => setTimeout(r, 500));
      await this.worldCache.loadWorld().catch(err => {
        console.warn('[App] Failed to load world data after retry:', err);
      });
    });

    // Check if player needs to select a class (no character yet)
    if (!this.gameClient.lastState?.character) {
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

  private showSuspensionScreen(email?: string): void {
    if (email) {
      localStorage.setItem('suspendedEmail', email);
    }
    this.suspensionScreen.setEmail(email ?? localStorage.getItem('suspendedEmail') ?? '');
    this.navEl.style.display = 'none';
    this.screenManager.switchTo('suspended');
  }

  private enterGame(): void {
    const combatScreen = new CombatScreen('screen-combat', this.gameClient);
    const mapScreen = new MapScreen('screen-map', this.gameClient, this.worldCache);
    const charItemsScreen = new CharItemsScreen('screen-items', this.gameClient);
    const socialScreen = new SocialScreen('screen-social', this.gameClient, this.chatStore);
    const settingsScreen = new SettingsScreen('screen-settings');

    // Wire map username click to social screen popup
    mapScreen.setOnUserClick((username, anchor, tileCol, tileRow) => {
      socialScreen.showUserPopup(username, anchor, tileCol, tileRow);
    });

    // Wire combat screen username click to social screen popup
    combatScreen.setOnUserClick((username, anchor) => {
      socialScreen.showUserPopup(username, anchor);
    });

    // Wire char/items screen "open trade" click to social screen trade modal
    charItemsScreen.setOnOpenTrade((tradeId) => {
      socialScreen.openExistingTrade(tradeId);
    });

    // Listen for world content updates (admin deployed a new version)
    this.gameClient.onWorldUpdate(async () => {
      console.log('[App] World updated — reloading world data');
      await this.worldCache.loadWorld();
      mapScreen.refreshWorld();
    });

    this.screenManager.register('combat', document.getElementById('screen-combat')!, combatScreen);
    this.screenManager.register('map', document.getElementById('screen-map')!, mapScreen);
    this.screenManager.register('items', document.getElementById('screen-items')!, charItemsScreen);
    this.screenManager.register('social', document.getElementById('screen-social')!, socialScreen);
    this.screenManager.register('settings', document.getElementById('screen-settings')!, settingsScreen);

    // Show bottom nav + persistent XP bar
    this.navEl.style.display = '';
    this.xpBarEl.style.display = '';

    // Persistent XP bar above nav — visible on every screen
    new PersistentXpBar(this.gameClient);

    // Chat popout — global overlay, toggled from the Chat nav tab
    this.chatPopout = new ChatPopout(this.gameClient);

    // Migrate any legacy 'character' saved screen to the merged 'items' tab.
    let savedScreen = sessionStorage.getItem('activeScreen') ?? 'combat';
    if (savedScreen === 'character') savedScreen = 'items';

    // Nav icons render as <img> tags (no emoji). Drop PNGs into
    // data/nav-icons/{id}.png and add an Express mount at /nav-icons in
    // server/src/index.ts. Missing art falls through to a placehold.co stub.
    const navImg = (id: string, label: string) => {
      const placeholder = `https://placehold.co/24x24/2a2a40/e8e8e8/png?text=${encodeURIComponent(label.slice(0, 4))}`;
      return `<img class="nav-icon-img" src="/nav-icons/${id}.png" alt="${label}"`
        + ` onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${placeholder}';}else{this.style.display='none';}" />`;
    };
    const nav = new BottomNav(
      [
        { id: 'combat', label: 'Combat', icon: navImg('combat', 'Fight') },
        { id: 'map', label: 'Map', icon: navImg('map', 'Map') },
        { id: 'items', label: 'Char', icon: navImg('items', 'Char') },
        // Social opens a fly-out submenu with the three sub-views; the
        // pill bar inside the screen is gone in favor of this.
        {
          id: 'social',
          label: 'Social',
          icon: navImg('social', 'Soc'),
          mode: 'submenu',
          submenu: [
            { id: 'party', label: 'Party', badge: 'party-invites' },
            { id: 'guild', label: 'Guild' },
            { id: 'users', label: 'Leaderboard', badge: 'friend-requests' },
          ],
        },
        { id: 'settings', label: 'Settings', icon: navImg('settings', 'Set') },
        // Chat is pinned to the far right as a square overlay button. The
        // icon is a chevron (▲ when closed → "open me upward", ▼ when open
        // → "tap to close") so it visually reads as a separate widget, not
        // another nav destination. CSS swaps the chevron via .overlay-active.
        {
          id: 'chat',
          label: 'Chat',
          icon: '<span class="nav-chat-chevron"><span class="nav-chat-chevron-up">▲</span><span class="nav-chat-chevron-down">▼</span></span>',
          mode: 'overlay',
        },
      ],
      savedScreen,
      (tabId, wasActive) => {
        this.screenManager.switchTo(tabId);
        // Re-click on Map → recenter on player (the only "tap again" gesture
        // wired so far; other tabs ignore wasActive).
        if (tabId === 'map' && wasActive) {
          mapScreen.recenterOnPlayer();
        }
      },
      this.gameClient,
      (tabId, active) => {
        if (tabId === 'chat') {
          if (active) this.chatPopout?.open(); else this.chatPopout?.close();
        }
      },
      (tabId, itemId) => {
        if (tabId === 'social') {
          socialScreen.setSubTab(itemId);
          this.screenManager.switchTo('social');
          nav.setActive('social');
          sessionStorage.setItem('activeScreen', 'social');
        }
      },
    );

    // Wire popout → nav so closing the popout from its own button clears the
    // overlay-active state, and unread mail lights up the Chat tab badge.
    this.chatPopout.setOnClose(() => nav.setOverlayActive('chat', false));
    this.chatPopout.setOnUnreadChange((hasUnread) => nav.setChatUnread(hasUnread));

    // Restore chat open/closed from the previous session on this browser.
    if (this.chatPopout.wasOpen()) {
      this.chatPopout.open();
      nav.setOverlayActive('chat', true);
    }

    // Switch to saved screen (or combat by default)
    this.screenManager.switchTo(savedScreen);
  }
}
