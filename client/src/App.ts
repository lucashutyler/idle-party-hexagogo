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
import { CraftingScreen } from './screens/CraftingScreen';
import { ClassSelectScreen } from './screens/ClassSelectScreen';
import { SuspensionScreen } from './screens/SuspensionScreen';
import { BottomNav } from './ui/BottomNav';
import type { NavTabConfig } from './ui/BottomNav';
import { UtilityStrip } from './ui/UtilityStrip';
import { ChatPopout } from './ui/ChatPopout';
import { ChatStrip } from './ui/ChatStrip';
import { QuestLog } from './ui/QuestLog';
import { PersistentXpBar } from './ui/PersistentXpBar';
import { TopHud } from './ui/TopHud';
import { NotificationCenter } from './ui/NotificationCenter';
import { RecapModal } from './ui/RecapModal';
import { BestiaryModal, MasteryToasts } from './ui/BestiaryModal';
import { OPEN_OPTIONS_ATTR } from './ui/ForecastChip';
import { chatFocusTracker } from './network/ChatFocusTracker';
import { forgetMissingAssets } from './ui/assets';
import { dismissModals } from './ui/ModalStack';
import { runStepsWhenIdle, saveDataRequested } from './ui/idleSteps';
import {
  ACTIVE_SCREEN_KEY,
  DEFAULT_SCREEN,
  initNavigation,
  installBackHandler,
  installEscapeHandler,
  installNavDelegate,
  navigate,
} from './ui/navigate';

const CONNECTION_ERROR = 'Could not connect to server';

const NAV_TABS: readonly NavTabConfig[] = [
  { id: 'map', label: 'Map', glyph: '🗺️' },
  { id: 'items', label: 'Hero', glyph: '🎒' },
  { id: 'combat', label: 'Battle', glyph: '⚔️' },
  { id: 'craft', label: 'Craft', glyph: '🔨' },
  { id: 'social', label: 'Social', glyph: '👥' },
  { id: 'quests', label: 'Quests', glyph: '📜', railOnly: true },
  { id: 'chat', label: 'Chat', glyph: '💬', railOnly: true },
  { id: 'settings', label: 'Settings', glyph: '⚙️', railOnly: true },
];
const RETIRED_STORAGE_KEYS = ['chat_messages', 'chat_filters', 'chatPopoutGeometry', 'chatPopoutDesktopMax', 'mapZoom'];
const PREBUILT_SCREENS = ['items', 'craft'];

export class App {
  private gameClient!: GameClient;
  private worldCache = new WorldCache();
  private screenManager: ScreenManager;
  private loginScreen!: LoginScreen;
  private verifyScreen!: VerifyScreen;
  private usernameScreen!: UsernameScreen;
  private offlineScreen!: OfflineScreen;
  private suspensionScreen!: SuspensionScreen;
  private navEl!: HTMLElement;
  private xpBarEl!: HTMLElement;
  private stripEl!: HTMLElement;
  private topHudEl!: HTMLElement;
  private topHud?: TopHud;
  private xpBar?: PersistentXpBar;
  private chatPopout?: ChatPopout;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private recapModal?: RecapModal;
  private masteryToasts?: MasteryToasts;
  private openOptionsDelegate?: (e: MouseEvent) => void;
  private removeShellListeners?: () => void;
  private cancelPrebuild?: () => void;

  constructor() {
    this.screenManager = new ScreenManager();

    this.navEl = document.getElementById('bottom-nav')!;
    this.navEl.style.display = 'none';
    this.xpBarEl = document.getElementById('persistent-xp-bar')!;
    this.xpBarEl.style.display = 'none';
    this.stripEl = document.getElementById('utility-strip')!;
    this.stripEl.style.display = 'none';
    this.topHudEl = document.getElementById('top-hud')!;
    this.topHudEl.style.display = 'none';

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
    chatFocusTracker.init(this.gameClient);

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
      const classScreen = new ClassSelectScreen('screen-class-select', this.gameClient, this.worldCache, () => {
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
    this.stripEl.style.display = 'none';
    this.topHudEl.style.display = 'none';
    this.topHud?.setVisible(false);
    this.xpBar?.setVisible(false);
    this.chatPopout?.close();
    this.removeShellListeners?.();
    this.removeShellListeners = undefined;
    this.cancelPrebuild?.();
    initNavigation(null);
    this.screenManager.switchTo('suspended');
  }

  private enterGame(): void {
    RETIRED_STORAGE_KEYS.forEach(key => localStorage.removeItem(key));

    const combatScreen = new CombatScreen('screen-combat', this.gameClient, this.worldCache);
    const mapScreen = new MapScreen('screen-map', this.gameClient, this.worldCache);
    const charItemsScreen = new CharItemsScreen('screen-items', this.gameClient, this.worldCache);
    const socialScreen = new SocialScreen('screen-social', this.gameClient, this.worldCache);
    const craftingScreen = new CraftingScreen('screen-craft', this.gameClient, this.worldCache);
    const settingsScreen = new SettingsScreen('screen-settings', this.gameClient);

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

    this.gameClient.onResume(() => forgetMissingAssets());

    // Listen for world content updates (admin deployed a new version)
    this.gameClient.onWorldUpdate(async () => {
      console.log('[App] World updated — reloading world data');
      forgetMissingAssets();
      await this.worldCache.loadWorld();
      mapScreen.refreshWorld();
    });

    this.screenManager.register('combat', document.getElementById('screen-combat')!, combatScreen);
    this.screenManager.register('map', document.getElementById('screen-map')!, mapScreen);
    this.screenManager.register('items', document.getElementById('screen-items')!, charItemsScreen);
    this.screenManager.register('social', document.getElementById('screen-social')!, socialScreen);
    this.screenManager.register('craft', document.getElementById('screen-craft')!, craftingScreen);
    this.screenManager.register('settings', document.getElementById('screen-settings')!, settingsScreen);

    this.navEl.style.display = '';
    this.stripEl.style.display = '';

    this.xpBar = new PersistentXpBar(this.gameClient);
    this.topHud = new TopHud(this.gameClient, this.worldCache);

    const questLog = new QuestLog(this.gameClient, this.worldCache, (roomId) => {
      navigate('map');
      mapScreen.focusRoom(roomId);
    });

    const chatPopout = new ChatPopout(this.gameClient, this.worldCache);
    this.chatPopout = chatPopout;
    chatPopout.setOnUserClick((username, anchor) => {
      socialScreen.showUserPopup(username, anchor);
    });

    const nav = new BottomNav(NAV_TABS, DEFAULT_SCREEN, (tabId, wasActive) => {
      if (tabId === 'quests') {
        questLog.open();
      } else if (tabId === 'chat') {
        chatPopout.toggle();
        nav.setOverlayActive('chat', chatPopout.isVisible());
      } else {
        navigate(tabId);
        if (tabId === 'map' && wasActive) mapScreen.recenterOnPlayer();
      }
    }, this.gameClient);

    const openChat = (): void => {
      chatPopout.open();
      nav.setOverlayActive('chat', true);
    };

    const strip = new UtilityStrip(this.gameClient, {
      onOpenChat: openChat,
      onOpenQuests: () => questLog.open(),
    });

    const chatStrip = new ChatStrip(document.getElementById('chat-strip-slot')!, openChat);
    chatPopout.setOnClose(() => nav.setOverlayActive('chat', false));
    chatPopout.setOnPreviewChange((preview) => chatStrip.render(preview));
    chatPopout.setOnUnreadChange((count) => {
      nav.setChatUnread(count);
      strip.setChatUnread(count);
    });

    socialScreen.setOnDmRequest((username) => {
      dismissModals();
      chatPopout.openDm(username);
      nav.setOverlayActive('chat', true);
    });

    // TopHud must exist first: the bell looks up its slot once, on construction.
    const notifications = new NotificationCenter(this.gameClient, (target) => {
      switch (target.kind) {
        case 'party':
          navigate('social', 'party');
          break;
        case 'friend_requests':
          navigate('social', 'friends');
          break;
        case 'dm_reply':
          socialScreen.startDm(target.username);
          break;
        case 'options':
          settingsScreen.openPlayerOptions();
          break;
        case 'none':
          break;
      }
    });

    let shellReady = false;
    initNavigation({
      getScreen: (id) => this.screenManager.get(id),
      switchTo: (id) => this.screenManager.switchTo(id),
      getActiveScreenId: () => this.screenManager.getActiveScreenId(),
      setActiveTab: (id) => nav.setActive(id),
      closeTransient: () => {
        notifications.closeDropdown();
        questLog.close();
        if (shellReady) chatPopout.closeIfCovering();
      },
    });

    this.removeShellListeners?.();
    const shellListeners = [
      installNavDelegate(),
      installEscapeHandler(),
      installBackHandler(() => {
        if (!chatPopout.isLandscapeColumn()) return false;
        chatPopout.close();
        return true;
      }),
    ];
    this.removeShellListeners = () => shellListeners.forEach(remove => remove());

    if (chatPopout.wasOpen()) {
      chatPopout.open();
      nav.setOverlayActive('chat', true);
    }

    navigate(sessionStorage.getItem(ACTIVE_SCREEN_KEY) ?? DEFAULT_SCREEN);
    shellReady = true;

    this.cancelPrebuild?.();
    if (!saveDataRequested()) this.cancelPrebuild = runStepsWhenIdle(this.screenManager.prebuildSteps(PREBUILT_SCREENS));

    if (this.openOptionsDelegate) document.removeEventListener('click', this.openOptionsDelegate, true);
    this.openOptionsDelegate = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`[${OPEN_OPTIONS_ATTR}]`)) settingsScreen.openPlayerOptions();
    };
    document.addEventListener('click', this.openOptionsDelegate, true);

    this.masteryToasts?.destroy();
    const bestiaryModal = new BestiaryModal(this.gameClient);
    this.masteryToasts = new MasteryToasts(this.gameClient, () => bestiaryModal.open());

    this.recapModal?.destroy();
    this.recapModal = new RecapModal(this.gameClient, {
      onOpenMap: () => navigate('map'),
    });
  }
}
