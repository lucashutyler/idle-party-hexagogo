import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClassName, SkillDefinition } from '@idle-party-rpg/shared';
import { computeEquipmentBonuses, CLASS_ICONS, UNKNOWN_CLASS_ICON, SKILL_TREES, SKILL_SLOTS, LEVELS_PER_SKILL_POINT, getSkillById } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

export class CharacterScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
  private classNameEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpLabel!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpRateEl!: HTMLElement;
  private xpRateFromEl!: HTMLElement;
  private hpDisplay!: HTMLElement;
  private goldDisplay!: HTMLElement;
  private combatBonuses!: HTMLElement;
  private damageDisplay!: HTMLElement;
  private skillSlotsEl!: HTMLElement;
  private skillTreeEl!: HTMLElement;
  private skillPointsEl!: HTMLElement;
  private lastSkillKey = '';

  private unsubscribe?: () => void;
  private popupOpen = false;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    this.buildDOM();
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });

    const state = this.gameClient.lastState;
    if (state) {
      this.updateFromState(state);
    }
  }

  onDeactivate(): void {
    this.isActive = false;
    this.popupOpen = false;
    const popup = this.container.querySelector('.skill-popup');
    if (popup) popup.remove();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="character-content">
        <div class="character-card">
          <div class="character-card-header">
            <span class="character-class-name">Adventurer</span>
            <span class="character-level">Lv 1</span>
          </div>
          <div class="character-xp-section">
            <div class="character-xp-label">
              <span>XP</span>
              <span class="character-xp-numbers">0 / 100</span>
            </div>
            <div class="character-xp-bar">
              <div class="character-xp-fill" style="width: 0%"></div>
            </div>
            <div class="character-xp-rate">
              <span class="character-xp-rate-label">XP Rate</span>
              <span class="character-xp-rate-value">0/hr</span>
              <span class="character-xp-rate-reset" title="Reset XP rate counter">&#x21bb;</span>
              <span class="character-xp-rate-from"></span>
            </div>
          </div>
          <div class="character-hp-display">
            HP: <span class="character-hp-value">40</span>
          </div>
          <div class="character-damage-display">
            Damage: <span class="character-damage-value">1</span> <span class="character-damage-type"></span>
          </div>
          <div class="character-gold-display">
            Gold: <span class="character-gold-value">0</span> GP
          </div>
          <div class="character-combat-bonuses"></div>
          <div class="character-skill-points"></div>
          <div class="character-skill-slots"></div>
          <div class="character-skill-tree"></div>
        </div>
      </div>
    `;

    this.classNameEl = this.container.querySelector('.character-class-name')!;
    this.levelEl = this.container.querySelector('.character-level')!;
    this.xpLabel = this.container.querySelector('.character-xp-numbers')!;
    this.xpFill = this.container.querySelector('.character-xp-fill')!;
    this.hpDisplay = this.container.querySelector('.character-hp-value')!;
    this.goldDisplay = this.container.querySelector('.character-gold-value')!;
    this.combatBonuses = this.container.querySelector('.character-combat-bonuses')!;
    this.damageDisplay = this.container.querySelector('.character-damage-value')!;
    this.skillSlotsEl = this.container.querySelector('.character-skill-slots')!;
    this.skillTreeEl = this.container.querySelector('.character-skill-tree')!;
    this.skillPointsEl = this.container.querySelector('.character-skill-points')!;
    this.xpRateEl = this.container.querySelector('.character-xp-rate-value')!;
    this.xpRateFromEl = this.container.querySelector('.character-xp-rate-from')!;

    // Wire XP rate reset icon with confirmation
    this.container.querySelector('.character-xp-rate-reset')!.addEventListener('click', () => {
      if (!confirm('Reset XP rate counter?')) return;
      this.gameClient.resetXpRate();
    });
  }

  private static formatXpRate(rate: number): string {
    if (rate < 1000) return `${Math.round(rate)}/hr`;
    if (rate < 1_000_000) return `${(rate / 1_000).toFixed(1)}k/hr`;
    if (rate < 1_000_000_000) return `${(rate / 1_000_000).toFixed(1)}m/hr`;
    if (rate < 1_000_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)}b/hr`;
    if (rate < 1_000_000_000_000_000) return `${(rate / 1_000_000_000_000).toFixed(1)}t/hr`;
    return '?/hr';
  }

  private static formatDateTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const mon = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${mon}/${day} ${h}:${m}`;
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    const icon = CLASS_ICONS[char.className] ?? UNKNOWN_CLASS_ICON;
    this.classNameEl.textContent = `${icon} ${char.className}`;
    this.levelEl.textContent = `Lv ${char.level}`;
    this.xpLabel.textContent = `${char.xp} / ${char.xpForNextLevel}`;

    const xpPct = char.xpForNextLevel > 0 ? (char.xp / char.xpForNextLevel) * 100 : 0;
    this.xpFill.style.width = `${xpPct}%`;

    // XP rate from server
    const xpRate = char.xpRate;
    const elapsedHours = (Date.now() - xpRate.startTime) / 3_600_000;
    const rate = elapsedHours > 0 ? xpRate.totalXp / elapsedHours : 0;
    this.xpRateEl.textContent = CharacterScreen.formatXpRate(rate);
    this.xpRateFromEl.textContent = `from ${CharacterScreen.formatDateTime(xpRate.startTime)}`;

    this.hpDisplay.textContent = `${char.maxHp}`;
    this.damageDisplay.textContent = `${char.baseDamage}`;
    const dmgTypeEl = this.container.querySelector('.character-damage-type')!;
    dmgTypeEl.textContent = `(${char.damageType})`;
    this.goldDisplay.textContent = char.gold.toLocaleString();

    // Equipment combat bonuses
    const bonuses = computeEquipmentBonuses(char.equipment, state.itemDefinitions ?? {}, char.level);
    const hasAtk = bonuses.bonusAttackMax > 0;
    const hasDef = bonuses.damageReductionMax > 0;
    const hasMR = bonuses.magicReductionMax > 0;
    this.combatBonuses.innerHTML = `
      <div class="character-bonus-row">
        <span class="character-bonus-label">Attack bonus</span>
        <span class="character-bonus-value${hasAtk ? ' active' : ''}">${hasAtk ? `+${bonuses.bonusAttackMin}-${bonuses.bonusAttackMax}` : 'None'}</span>
      </div>
      <div class="character-bonus-row">
        <span class="character-bonus-label">Damage reduction</span>
        <span class="character-bonus-value${hasDef ? ' active' : ''}">${hasDef ? `${bonuses.damageReductionMin}-${bonuses.damageReductionMax}` : 'None'}</span>
      </div>
      <div class="character-bonus-row">
        <span class="character-bonus-label">Magic resistance</span>
        <span class="character-bonus-value${hasMR ? ' active' : ''}">${hasMR ? `${bonuses.magicReductionMin}-${bonuses.magicReductionMax}` : 'None'}</span>
      </div>
    `;

    // Skill points
    const availablePoints = char.skillPoints;
    this.skillPointsEl.textContent = availablePoints > 0 ? `Skill Points: ${availablePoints}` : '';

    // Skill slots & tree — only re-render when skill state changes (not every tick)
    const skillKey = JSON.stringify(char.skillLoadout) + char.level;
    if (!this.popupOpen && skillKey !== this.lastSkillKey) {
      this.lastSkillKey = skillKey;
      this.renderSkillSlots(state);
      this.renderSkillTree(state);
    }
  }

  private renderSkillSlot(slotIndex: number, char: { level: number; skillLoadout: { equippedSkills: (string | null)[] } }): string {
    const slot = SKILL_SLOTS[slotIndex];
    const isUnlocked = char.level >= slot.unlocksAtLevel;
    const equippedId = char.skillLoadout.equippedSkills[slotIndex];
    const skill = equippedId ? getSkillById(equippedId) : null;

    if (!isUnlocked) {
      return `<div class="skill-slot locked">
        <div class="skill-slot-hex">
          <span class="skill-slot-lock">Lv ${slot.unlocksAtLevel}</span>
        </div>
        <div class="skill-slot-type">${slot.type}</div>
      </div>`;
    } else if (skill) {
      return `<div class="skill-slot filled ${skill.type}" data-slot="${slotIndex}" data-skill="${skill.id}">
        <div class="skill-slot-hex ${skill.type}">
          <span class="skill-slot-name">${this.escapeHtml(skill.name)}</span>
        </div>
        <div class="skill-slot-type">${skill.type}${skill.cooldown ? ` CD${skill.cooldown}` : ''}</div>
      </div>`;
    } else {
      return `<div class="skill-slot empty" data-slot="${slotIndex}">
        <div class="skill-slot-hex empty">
          <span class="skill-slot-name">Empty</span>
        </div>
        <div class="skill-slot-type">${slot.type}</div>
      </div>`;
    }
  }

  private renderSkillSlots(state: ServerStateMessage): void {
    const char = state.character;

    // Active slot (index 1) on the left, passive slots (0, 2, 3, 4) on the right
    let html = '<div class="skill-slots-header">Equipped Skills</div>';
    html += '<div class="skill-slots-split">';
    html += '<div class="skill-slots-active">';
    html += this.renderSkillSlot(1, char);
    html += '</div>';
    html += '<div class="skill-slots-passive">';
    html += this.renderSkillSlot(0, char);
    html += this.renderSkillSlot(2, char);
    html += this.renderSkillSlot(3, char);
    html += this.renderSkillSlot(4, char);
    html += '</div>';
    html += '</div>';
    this.skillSlotsEl.innerHTML = html;

    // Wire clicks on filled slots to show popup
    for (const el of this.skillSlotsEl.querySelectorAll('.skill-slot.filled')) {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const skillId = el.getAttribute('data-skill')!;
        this.showSkillPopup(skillId, el as HTMLElement, state);
      });
    }
  }

  /** Get the level at which a skill becomes learnable (treeOrder 0 = Lv1, others = treeOrder * 5). */
  private getSkillLearnLevel(treeOrder: number): number {
    return treeOrder === 0 ? 1 : treeOrder * 5;
  }

  private renderSkillTreeNode(skill: SkillDefinition, statusClass: string, isUnlocked: boolean): string {
    const learnLevel = this.getSkillLearnLevel(skill.treeOrder);
    const levelLabel = !isUnlocked ? ` Lv ${learnLevel}` : '';

    let html = `<div class="skill-tree-node ${statusClass} ${skill.type}" data-skill-id="${skill.id}">`;
    html += `<div class="skill-hex ${skill.type} ${statusClass}">`;
    html += `<span class="skill-hex-name">${this.escapeHtml(skill.name)}</span>`;
    html += `</div>`;
    html += `<div class="skill-node-label">${skill.cooldown ? `CD ${skill.cooldown}` : skill.type}${levelLabel}</div>`;
    html += `</div>`;
    return html;
  }

  private renderSkillTree(state: ServerStateMessage): void {
    const char = state.character;
    const className = char.className as ClassName;
    const tree = SKILL_TREES[className];

    if (!tree || tree.length === 0) {
      this.skillTreeEl.innerHTML = '';
      return;
    }

    const loadout = char.skillLoadout;
    const unlockedSet = new Set(loadout.unlockedSkills);
    const equippedSet = new Set(loadout.equippedSkills.filter(Boolean));

    const actives = tree.filter(s => s.type === 'active');
    const passives = tree.filter(s => s.type === 'passive');

    const getStatus = (skill: SkillDefinition) => {
      const isUnlocked = unlockedSet.has(skill.id);
      const isEquipped = equippedSet.has(skill.id);
      let canUnlock = false;
      if (!isUnlocked) {
        const learnLevel = skill.treeOrder === 0 ? 1 : skill.treeOrder * LEVELS_PER_SKILL_POINT;
        const allPriorUnlocked = tree.every(s => s.treeOrder >= skill.treeOrder || unlockedSet.has(s.id));
        const cost = skill.treeOrder === 0 ? 0 : 1;
        canUnlock = char.level >= learnLevel && allPriorUnlocked && char.skillPoints >= cost;
      }
      return {
        isUnlocked,
        statusClass: isEquipped ? 'equipped' : isUnlocked ? 'unlocked' : canUnlock ? 'unlockable' : 'locked',
      };
    };

    let html = '<div class="skill-tree-header">Skill Tree</div>';
    html += '<div class="skill-tree-split">';

    // Active column (left)
    html += '<div class="skill-tree-column skill-tree-actives">';
    for (let i = 0; i < actives.length; i++) {
      const skill = actives[i];
      const { isUnlocked, statusClass } = getStatus(skill);
      html += this.renderSkillTreeNode(skill, statusClass, isUnlocked);
      if (i < actives.length - 1) {
        html += '<div class="skill-tree-connector"></div>';
      }
    }
    html += '</div>';

    // Passive column (right)
    html += '<div class="skill-tree-column skill-tree-passives">';
    for (let i = 0; i < passives.length; i++) {
      const skill = passives[i];
      const { isUnlocked, statusClass } = getStatus(skill);
      html += this.renderSkillTreeNode(skill, statusClass, isUnlocked);
      if (i < passives.length - 1) {
        html += '<div class="skill-tree-connector"></div>';
      }
    }
    html += '</div>';

    html += '</div>';
    this.skillTreeEl.innerHTML = html;

    // Wire click handlers
    for (const node of this.skillTreeEl.querySelectorAll('.skill-tree-node')) {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const skillId = node.getAttribute('data-skill-id')!;
        this.showSkillPopup(skillId, node as HTMLElement, state);
      });
    }
  }

  private showSkillPopup(skillId: string, _anchor: HTMLElement, state: ServerStateMessage): void {
    // Remove existing popup
    const existing = this.container.querySelector('.skill-popup');
    if (existing) existing.remove();

    const skill = getSkillById(skillId);
    if (!skill) return;

    const char = state.character;
    const loadout = char.skillLoadout;
    const isUnlocked = loadout.unlockedSkills.includes(skillId);
    const isEquipped = loadout.equippedSkills.includes(skillId);

    const popup = document.createElement('div');
    popup.className = `skill-popup ${skill.type}`;

    let buttonsHtml = '';
    if (isUnlocked && !isEquipped) {
      // Find matching slots by type
      const matchingSlots = SKILL_SLOTS
        .map((s, i) => ({ ...s, index: i }))
        .filter(s => s.type === skill.type && char.level >= s.unlocksAtLevel);

      if (matchingSlots.length > 0) {
        if (skill.type === 'active') {
          // Only one active slot
          buttonsHtml = `<button class="skill-popup-btn equip-btn" data-slot="${matchingSlots[0].index}">Equip in active slot</button>`;
        } else {
          buttonsHtml = matchingSlots.map(s =>
            `<button class="skill-popup-btn equip-btn" data-slot="${s.index}">Equip in passive slot ${s.index === 0 ? '1' : s.index === 2 ? '2' : s.index === 3 ? '3' : '4'}</button>`
          ).join('');
        }
      }
    } else if (isEquipped) {
      const slotIdx = loadout.equippedSkills.indexOf(skillId);
      if (slotIdx >= 0) {
        buttonsHtml = `<button class="skill-popup-btn unequip-btn" data-slot="${slotIdx}">Unequip</button>`;
      }
    }

    popup.innerHTML = `
      <div class="skill-popup-name ${skill.type}">${this.escapeHtml(skill.name)}</div>
      <div class="skill-popup-type">${skill.type}${skill.cooldown ? ` | Cooldown: ${skill.cooldown}` : ''}</div>
      <div class="skill-popup-desc">${this.escapeHtml(skill.description)}</div>
      ${buttonsHtml ? `<div class="skill-popup-actions">${buttonsHtml}</div>` : ''}
      <div class="skill-popup-dismiss">Tap to dismiss</div>
    `;

    this.container.appendChild(popup);
    this.popupOpen = true;

    const closePopup = () => {
      popup.remove();
      this.popupOpen = false;
      document.removeEventListener('click', closePopup);
      // Re-render with latest state now that popup is gone
      const latestState = this.gameClient.lastState;
      if (latestState) {
        this.renderSkillSlots(latestState);
        this.renderSkillTree(latestState);
      }
    };

    // Wire button handlers
    for (const equipBtn of popup.querySelectorAll('.equip-btn')) {
      equipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slotIndex = parseInt(equipBtn.getAttribute('data-slot')!, 10);
        this.gameClient.sendEquipSkill(skillId, slotIndex);
        closePopup();
      });
    }

    const unequipBtn = popup.querySelector('.unequip-btn');
    if (unequipBtn) {
      unequipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slotIndex = parseInt(unequipBtn.getAttribute('data-slot')!, 10);
        this.gameClient.sendUnequipSkill(slotIndex);
        closePopup();
      });
    }

    // Dismiss on click anywhere
    setTimeout(() => document.addEventListener('click', closePopup), 0);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
