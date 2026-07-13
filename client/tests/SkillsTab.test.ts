import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CLASS_NAMES, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '@idle-party-rpg/shared';
import type { SkillDefinition } from '@idle-party-rpg/shared';
import { SkillsTab } from '../src/admin/tabs/SkillsTab';
import type { AdminContext } from '../src/admin/AdminContext';
import type { ContentData } from '../src/admin/types';
import { closeAllModals } from '../src/admin/components/Modal';

const GRANT_ONLY_SKILL: SkillDefinition = {
  id: 'test_ember_ward',
  name: 'Ember Ward',
  description: 'Only granted by equipment.',
  className: 'Knight',
  type: 'passive',
  unlockLevel: null,
  sortOrder: 99,
  passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 }],
};

function makeCtx(opts: { readOnly?: boolean } = {}): AdminContext {
  const content = {
    skills: {
      knight_guard: { ...SEED_SKILLS.knight_guard },
      knight_bash: { ...SEED_SKILLS.knight_bash },
      mage_zap: { ...SEED_SKILLS.mage_zap },
      test_ember_ward: { ...GRANT_ONLY_SKILL },
    },
    skillSlotSchedules: { ...SEED_SKILL_SLOT_SCHEDULES },
  } as unknown as ContentData;
  return {
    overview: null,
    accounts: [],
    versions: [],
    activeVersionId: null,
    selectedVersionId: null,
    versionContent: content,
    getDisplayContent: () => content,
    isReadOnly: () => opts.readOnly ?? false,
    versionQueryParam: () => '',
    refresh: async () => {},
    refreshVersions: async () => {},
    selectVersion: async () => {},
    rerenderTab: vi.fn(),
    patchVersionContent: vi.fn(),
    refreshStatusBar: () => {},
  };
}

describe('SkillsTab', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
  });

  it('renders one section per class, in class order, with rows from content', () => {
    new SkillsTab().render(container, makeCtx());
    const sections = [...container.querySelectorAll('[data-skills-class]')];
    expect(sections.map(s => s.getAttribute('data-skills-class'))).toEqual(ALL_CLASS_NAMES);

    const knight = container.querySelector('[data-skills-class="Knight"]')!;
    expect(knight.querySelectorAll('tbody tr').length).toBe(3);
    expect(knight.textContent).toContain('Guard');
    expect(knight.textContent).toContain('knight_guard');

    const mage = container.querySelector('[data-skills-class="Mage"]')!;
    expect(mage.querySelectorAll('tbody tr').length).toBe(1);
    expect(mage.textContent).toContain('mage_zap');
  });

  it('shows unlock levels from skill.unlockLevel and a grant-only badge when null', () => {
    new SkillsTab().render(container, makeCtx());
    const knight = container.querySelector('[data-skills-class="Knight"]')!;
    const rows = [...knight.querySelectorAll('tbody tr')];

    const guardRow = rows.find(tr => tr.textContent!.includes('knight_guard'))!;
    expect(guardRow.querySelector('td')!.textContent!.trim()).toBe(String(SEED_SKILLS.knight_guard.unlockLevel));

    const grantRow = rows.find(tr => tr.textContent!.includes('test_ember_ward'))!;
    expect(grantRow.querySelector('td .admin-pill-grant')).not.toBeNull();
    expect(grantRow.textContent).toContain('grant-only');
  });

  it('draft mode shows Add/Restore buttons and Edit/Del row actions', () => {
    new SkillsTab().render(container, makeCtx());
    expect(container.querySelector('#skill-add-btn')).not.toBeNull();
    expect(container.querySelector('#skill-restore-btn')).not.toBeNull();
    expect(container.querySelectorAll('.skill-edit-btn').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.skill-delete-btn').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.skill-view-btn').length).toBe(0);
  });

  it('read-only mode hides Add/Restore and shows View buttons instead', () => {
    new SkillsTab().render(container, makeCtx({ readOnly: true }));
    expect(container.querySelector('#skill-add-btn')).toBeNull();
    expect(container.querySelector('#skill-restore-btn')).toBeNull();
    expect(container.querySelectorAll('.skill-edit-btn').length).toBe(0);
    expect(container.querySelectorAll('.skill-delete-btn').length).toBe(0);
    expect(container.querySelectorAll('.skill-view-btn').length).toBe(4);
  });

  it('renders an Edit Slots button per class section', () => {
    new SkillsTab().render(container, makeCtx());
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.skill-slots-btn')];
    expect(buttons.map(b => b.dataset.class)).toEqual(ALL_CLASS_NAMES);
    expect(buttons[0].textContent!.trim()).toBe('Edit Slots');
  });

  it('option picker filters catalog rows by search and by skill type legality', () => {
    new SkillsTab().render(container, makeCtx());
    container.querySelector<HTMLButtonElement>('#skill-add-btn')!.click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    modal.querySelector<HTMLButtonElement>('#skf-add-option')!.click();

    const picker = modal.querySelector<HTMLElement>('#skf-option-picker')!;
    expect(picker.hidden).toBe(false);

    // New skills default to passive: active kinds are illegal and hidden.
    const stunSingle = modal.querySelector<HTMLElement>('.skills-option-pick[data-kind="stun_single"]')!;
    expect(stunSingle.style.display).toBe('none');

    const search = modal.querySelector<HTMLInputElement>('#skf-option-search')!;
    search.value = 'xp';
    search.dispatchEvent(new Event('input'));

    const xpRow = modal.querySelector<HTMLElement>('.skills-option-pick[data-kind="xp_bonus"]')!;
    const critRow = modal.querySelector<HTMLElement>('.skills-option-pick[data-kind="crit_chance"]')!;
    expect(xpRow.style.display).not.toBe('none');
    expect(critRow.style.display).toBe('none');
  });

  it('picking a catalog option appends an option row with param inputs', () => {
    new SkillsTab().render(container, makeCtx());
    container.querySelector<HTMLButtonElement>('#skill-add-btn')!.click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    modal.querySelector<HTMLButtonElement>('#skf-add-option')!.click();
    modal.querySelector<HTMLButtonElement>('.skills-option-pick[data-kind="physical_reduction"]')!.click();

    const row = modal.querySelector<HTMLElement>('#skf-options-list .skills-option-row')!;
    expect(row.dataset.kind).toBe('physical_reduction');
    expect(row.querySelector('[data-key="valuePerLevel"]')).not.toBeNull();
    expect(modal.querySelector<HTMLElement>('#skf-option-picker')!.hidden).toBe(true);
  });

  it('displays percent params ×100 in option rows', () => {
    new SkillsTab().render(container, makeCtx());
    container
      .querySelector<HTMLButtonElement>('.skill-edit-btn[data-id="knight_bash"]')!
      .click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    // knight_bash: stun_single with stunChance 0.50, displayed as 50 (%).
    const input = modal.querySelector<HTMLInputElement>('.skills-option-row [data-key="stunChance"]')!;
    expect(input.value).toBe('50');
    // Cooldown field is visible for actives.
    const cooldownWrap = modal.querySelector<HTMLElement>('#skf-cooldown-wrap')!;
    expect(cooldownWrap.style.display).not.toBe('none');
  });

  it('checking grant-only disables the unlock level input', () => {
    new SkillsTab().render(container, makeCtx());
    container.querySelector<HTMLButtonElement>('#skill-add-btn')!.click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    const grantCheck = modal.querySelector<HTMLInputElement>('#skf-grantOnly')!;
    const levelInput = modal.querySelector<HTMLInputElement>('#skf-unlockLevel')!;
    expect(levelInput.disabled).toBe(false);
    grantCheck.checked = true;
    grantCheck.dispatchEvent(new Event('change'));
    expect(levelInput.disabled).toBe(true);
  });

  it('opens the slots modal with one row per scheduled slot', () => {
    new SkillsTab().render(container, makeCtx());
    container
      .querySelector<HTMLButtonElement>('.skill-slots-btn[data-class="Knight"]')!
      .click();

    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    const rows = modal.querySelectorAll('.skills-slot-row');
    expect(rows.length).toBe(SEED_SKILL_SLOT_SCHEDULES.Knight.length);
    const firstLevel = rows[0].querySelector<HTMLInputElement>('.slf-slot-level')!;
    expect(firstLevel.value).toBe(String(SEED_SKILL_SLOT_SCHEDULES.Knight[0].unlocksAtLevel));
  });

  it('scrolls to a class section when its quick-jump button is clicked', () => {
    new SkillsTab().render(container, makeCtx());
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-skills-jump]');
    expect(buttons.length).toBe(ALL_CLASS_NAMES.length);
    const mage = container.querySelector<HTMLElement>('[data-skills-class="Mage"]')!;
    let scrolled = false;
    mage.scrollIntoView = () => { scrolled = true; };
    [...buttons].find(b => b.dataset.skillsJump === 'Mage')!.click();
    expect(scrolled).toBe(true);
  });
});
