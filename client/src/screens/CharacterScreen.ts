import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClassName, SkillDefinition, QuestObjective } from '@idle-party-rpg/shared';
import { computeEquipmentBonuses, CLASS_ICONS, UNKNOWN_CLASS_ICON, SKILL_TREES, SKILL_SLOTS, LEVELS_PER_SKILL_POINT, getSkillById, getObjectiveTarget } from '@idle-party-rpg/shared';
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

  // Completed quests log UI state (preserved across re-renders)
  private completedExpanded = false;
  private completedSearch = '';
  private completedSort: 'date_desc' | 'date_asc' | 'name_asc' = 'date_desc';
  private completedFilter: 'all' | 'solo' | 'party_shared' = 'all';
  private completedPage = 0;
  private static readonly COMPLETED_PAGE_SIZE = 20;

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
            <span class="character-class-name"></span>
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
          <div class="character-quest-log"></div>
          <div class="character-skill-points"></div>
          <div class="character-skill-slots"></div>
          <div class="character-skill-tree"></div>
          <div class="character-completed-quests"></div>
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

    // Quest log card
    this.renderQuestLog(state);
    this.renderCompletedQuests(state);

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
    if (!char) return;

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
    if (!char) return;
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
    if (!char) return;
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

  private renderQuestLog(state: ServerStateMessage): void {
    const el = this.container.querySelector('.character-quest-log') as HTMLElement | null;
    if (!el) return;
    const active = state.activeQuests ?? [];
    const completed = state.completedQuests ?? [];
    const defs = state.questDefinitions ?? {};

    if (active.length === 0 && completed.length === 0) {
      el.innerHTML = `
        <div class="quest-log-card">
          <div class="quest-log-header">Quest Log</div>
          <div class="quest-log-empty">No quests yet. Talk to NPCs marked with 💬 on the map.</div>
        </div>
      `;
      return;
    }

    const resolutions = state.questResolutions;
    const resolveMonster = (id: string) => resolutions?.monsters[id] ?? id;
    const resolveItem = (id: string) => resolutions?.items[id] ?? id;
    const resolveTile = (id: string) => {
      const t = resolutions?.tiles[id];
      return t ? `${t.name} (${t.col},${t.row})` : 'a specific room';
    };

    const objectiveText = (obj: QuestObjective, progress: number): string => {
      const target = getObjectiveTarget(obj);
      const cap = Math.min(progress, target);
      if (obj.kind === 'kill') return `Kill ${this.escapeHtml(resolveMonster(obj.monsterId))} (${cap}/${target})`;
      if (obj.kind === 'collect') return `Collect ${this.escapeHtml(resolveItem(obj.itemId))} (${cap}/${target})`;
      const place = this.escapeHtml(resolveTile(obj.tileId));
      return cap >= 1 ? `Visit ${place} — done` : `Visit ${place}`;
    };

    const rows = active.map(entry => {
      const def = defs[entry.questId];
      const name = def?.name ?? entry.questId;
      const objs = def
        ? def.objectives.map((o, i) => `<div class="quest-log-objective">• ${objectiveText(o, entry.progress[i] ?? 0)}</div>`).join('')
        : '';
      const statusLabel = entry.status === 'ready' ? 'Ready' : entry.status === 'in_progress' ? 'In Progress' : 'Accepted';
      return `
        <div class="quest-log-entry">
          <div class="quest-log-entry-header">
            <span class="quest-log-entry-name">${this.escapeHtml(name)}</span>
            <span class="quest-log-status quest-log-status-${entry.status}">${statusLabel}</span>
          </div>
          ${objs}
        </div>
      `;
    }).join('');

    el.innerHTML = `
      <div class="quest-log-card">
        <div class="quest-log-header">Quest Log</div>
        ${rows || '<div class="quest-log-empty">No active quests.</div>'}
      </div>
    `;
  }

  private renderCompletedQuests(state: ServerStateMessage): void {
    const el = this.container.querySelector('.character-completed-quests') as HTMLElement | null;
    if (!el) return;

    const completed = state.completedQuests ?? [];
    const defs = state.questDefinitions ?? {};

    if (completed.length === 0) {
      el.innerHTML = '';
      return;
    }

    const chevron = this.completedExpanded ? '▾' : '▸';
    const headerHtml = `
      <button class="completed-quests-toggle" type="button">
        <span class="completed-quests-chevron">${chevron}</span>
        <span class="quest-log-header">Completed Quests</span>
        <span class="quest-log-count">${completed.length}</span>
      </button>
    `;

    if (!this.completedExpanded) {
      el.innerHTML = `<div class="quest-log-card">${headerHtml}</div>`;
      el.querySelector<HTMLButtonElement>('.completed-quests-toggle')?.addEventListener('click', () => {
        this.completedExpanded = true;
        this.renderCompletedQuests(state);
      });
      return;
    }

    // Apply filter, search, sort
    const search = this.completedSearch.trim().toLowerCase();
    let entries = completed.map(c => ({ ...c, def: defs[c.questId] }));

    if (this.completedFilter !== 'all') {
      entries = entries.filter(e => e.def?.scope === this.completedFilter);
    }
    if (search) {
      entries = entries.filter(e => (e.def?.name ?? e.questId).toLowerCase().includes(search));
    }

    entries.sort((a, b) => {
      if (this.completedSort === 'name_asc') {
        return (a.def?.name ?? a.questId).localeCompare(b.def?.name ?? b.questId);
      }
      const ta = new Date(a.completedAt).getTime();
      const tb = new Date(b.completedAt).getTime();
      return this.completedSort === 'date_asc' ? ta - tb : tb - ta;
    });

    const pageSize = CharacterScreen.COMPLETED_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    if (this.completedPage >= totalPages) this.completedPage = totalPages - 1;
    if (this.completedPage < 0) this.completedPage = 0;
    const start = this.completedPage * pageSize;
    const pageEntries = entries.slice(start, start + pageSize);

    const fmtDate = (iso: string): string => {
      const d = new Date(iso);
      const mon = (d.getMonth() + 1).toString().padStart(2, '0');
      const day = d.getDate().toString().padStart(2, '0');
      const yr = d.getFullYear();
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      return `${yr}-${mon}-${day} ${h}:${m}`;
    };

    const rowsHtml = pageEntries.map(e => {
      const name = e.def?.name ?? e.questId;
      const scope = e.def?.scope === 'solo' ? 'Solo' : 'Party';
      return `
        <div class="quest-log-entry">
          <div class="quest-log-entry-header">
            <span class="quest-log-entry-name">${this.escapeHtml(name)}</span>
            <span class="quest-log-status quest-log-status-ready">${scope}</span>
          </div>
          <div class="quest-log-objective">Completed ${fmtDate(e.completedAt)}</div>
        </div>
      `;
    }).join('');

    const noResultsHtml = pageEntries.length === 0
      ? `<div class="quest-log-empty">No matches.</div>`
      : '';

    const pagerHtml = totalPages > 1
      ? `
        <div class="completed-quests-pager">
          <button class="admin-btn admin-btn-sm" id="cq-prev" ${this.completedPage <= 0 ? 'disabled' : ''}>‹ Prev</button>
          <span>Page ${this.completedPage + 1} / ${totalPages}</span>
          <button class="admin-btn admin-btn-sm" id="cq-next" ${this.completedPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
        </div>
      `
      : '';

    el.innerHTML = `
      <div class="quest-log-card">
        ${headerHtml}
        <div class="completed-quests-toolbar">
          <input type="search" class="completed-quests-search" placeholder="Search…" value="${this.escapeAttr(this.completedSearch)}">
          <select class="completed-quests-filter">
            <option value="all" ${this.completedFilter === 'all' ? 'selected' : ''}>All</option>
            <option value="party_shared" ${this.completedFilter === 'party_shared' ? 'selected' : ''}>Party</option>
            <option value="solo" ${this.completedFilter === 'solo' ? 'selected' : ''}>Solo</option>
          </select>
          <select class="completed-quests-sort">
            <option value="date_desc" ${this.completedSort === 'date_desc' ? 'selected' : ''}>Newest first</option>
            <option value="date_asc" ${this.completedSort === 'date_asc' ? 'selected' : ''}>Oldest first</option>
            <option value="name_asc" ${this.completedSort === 'name_asc' ? 'selected' : ''}>Name A–Z</option>
          </select>
        </div>
        ${rowsHtml || noResultsHtml}
        ${pagerHtml}
      </div>
    `;

    el.querySelector<HTMLButtonElement>('.completed-quests-toggle')?.addEventListener('click', () => {
      this.completedExpanded = false;
      this.renderCompletedQuests(state);
    });
    const searchEl = el.querySelector<HTMLInputElement>('.completed-quests-search');
    searchEl?.addEventListener('input', () => {
      this.completedSearch = searchEl.value;
      this.completedPage = 0;
      this.renderCompletedQuests(state);
    });
    const filterEl = el.querySelector<HTMLSelectElement>('.completed-quests-filter');
    filterEl?.addEventListener('change', () => {
      this.completedFilter = filterEl.value as typeof this.completedFilter;
      this.completedPage = 0;
      this.renderCompletedQuests(state);
    });
    const sortEl = el.querySelector<HTMLSelectElement>('.completed-quests-sort');
    sortEl?.addEventListener('change', () => {
      this.completedSort = sortEl.value as typeof this.completedSort;
      this.renderCompletedQuests(state);
    });
    el.querySelector('#cq-prev')?.addEventListener('click', () => {
      this.completedPage = Math.max(0, this.completedPage - 1);
      this.renderCompletedQuests(state);
    });
    el.querySelector('#cq-next')?.addEventListener('click', () => {
      this.completedPage = Math.min(totalPages - 1, this.completedPage + 1);
      this.renderCompletedQuests(state);
    });
  }

  private escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
}
