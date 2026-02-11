import type { GameClient } from '../network/GameClient';

interface NavTabConfig {
  id: string;
  label: string;
  icon: string;
}

export class BottomNav {
  private container: HTMLElement;
  private tabButtons = new Map<string, HTMLElement>();
  private activeId: string;

  constructor(
    tabs: NavTabConfig[],
    defaultTab: string,
    onTabChange: (tabId: string) => void,
    gameClient: GameClient,
  ) {
    this.activeId = defaultTab;
    this.container = document.getElementById('bottom-nav')!;

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.className = `nav-tab${tab.id === defaultTab ? ' active' : ''}`;
      button.dataset.screen = tab.id;

      button.innerHTML = `
        <span class="nav-icon">${tab.icon}</span>
        <span class="nav-label">${tab.label}</span>
      `;

      button.addEventListener('click', () => {
        this.setActive(tab.id);
        onTabChange(tab.id);
      });

      this.container.appendChild(button);
      this.tabButtons.set(tab.id, button);
    }

    // Subscribe to game state for status indicators
    this.wireStatusIndicators(gameClient);
  }

  setActive(id: string): void {
    if (this.activeId === id) return;

    const prev = this.tabButtons.get(this.activeId);
    if (prev) prev.classList.remove('active');

    const next = this.tabButtons.get(id);
    if (next) next.classList.add('active');

    this.activeId = id;
  }

  private wireStatusIndicators(gameClient: GameClient): void {
    let lastVisual = '';

    gameClient.subscribe((state) => {
      const combatTab = this.tabButtons.get('combat');
      const mapTab = this.tabButtons.get('map');
      const visual = state.battle.visual;

      if (combatTab) {
        // Clear previous visual classes
        combatTab.classList.remove('fighting-pulse', 'victory-flash', 'defeat-flash');

        if (visual === 'fighting') {
          combatTab.classList.add('fighting-pulse');
        } else if (visual === 'victory' && lastVisual === 'fighting') {
          combatTab.classList.add('victory-flash');
        } else if (visual === 'defeat' && lastVisual === 'fighting') {
          combatTab.classList.add('defeat-flash');
        }
      }

      if (mapTab) {
        const isMoving = state.party.path.length > 0;
        mapTab.classList.toggle('has-path', isMoving);
      }

      lastVisual = visual;
    });
  }
}
