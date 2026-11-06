import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_CLASS_NAMES,
  SEED_SKILLS,
  SEED_SKILL_SLOT_SCHEDULES,
  SKILL_TRIGGER_INFO,
  SKILL_TRIGGER_VALUES,
} from '@idle-party-rpg/shared';
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

const LEGACY_BASH: SkillDefinition = (() => {
  const { charge: _charge, recovery: _recovery, ...rest } = SEED_SKILLS.knight_bash;
  return { ...rest, cooldown: 2 };
})();

function makeCtx(opts: { readOnly?: boolean; extraSkills?: SkillDefinition[] } = {}): AdminContext {
  const content = {
    skills: {
      knight_guard: { ...SEED_SKILLS.knight_guard },
      knight_bash: { ...LEGACY_BASH },
      mage_zap: { ...SEED_SKILLS.mage_zap },
      test_ember_ward: { ...GRANT_ONLY_SKILL },
      ...Object.fromEntries((opts.extraSkills ?? []).map(sk => [sk.id, { ...sk }])),
    },
    skillSlotSchedules: { ...SEED_SKILL_SLOT_SCHEDULES },
  } as unknown as ContentData;
  return {
    me: null,
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

function openEdit(container: HTMLElement, id: string): HTMLElement {
  container.querySelector<HTMLButtonElement>(`.skill-edit-btn[data-id="${id}"]`)!.click();
  return document.body.querySelector<HTMLElement>('.admin-modal')!;
}

function setValue(modal: HTMLElement, selector: string, value: string): void {
  const el = modal.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function stubPut(): { bodies: SkillDefinition[] } {
  const captured = { bodies: [] as SkillDefinition[] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    captured.bodies.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({ skills: {} }) };
  }));
  return captured;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('SkillsTab', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
    vi.unstubAllGlobals();
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

  it('shows cooldowns in seconds with the card type, and no turn-based wording', () => {
    new SkillsTab().render(container, makeCtx());
    expect(container.textContent).not.toContain('Nth attack');

    const knight = container.querySelector('[data-skills-class="Knight"]')!;
    const bashRow = [...knight.querySelectorAll('tbody tr')].find(tr => tr.textContent!.includes('knight_bash'))!;
    const cells = bashRow.querySelectorAll('td');
    const cdCell = cells[cells.length - 2];
    expect(cdCell.textContent).toContain(`${LEGACY_BASH.cooldown}s`);
    expect(cdCell.querySelector('[data-card-type="action"]')).not.toBeNull();

    const guardRow = [...knight.querySelectorAll('tbody tr')].find(tr => tr.textContent!.includes('knight_guard'))!;
    expect(guardRow.querySelector('[data-card-type="passive"]')).not.toBeNull();
  });

  it('shows cast time and trigger for casting and reacting skills in the table', () => {
    new SkillsTab().render(container, makeCtx({
      extraSkills: [SEED_SKILLS.mage_blizzard, SEED_SKILLS.knight_intercept],
    }));
    const mageRow = [...container.querySelectorAll('[data-skills-class="Mage"] tbody tr')]
      .find(tr => tr.textContent!.includes('mage_blizzard'))!;
    expect(mageRow.textContent).toContain(`cast ${SEED_SKILLS.mage_blizzard.castTime}s`);

    const interceptRow = [...container.querySelectorAll('[data-skills-class="Knight"] tbody tr')]
      .find(tr => tr.textContent!.includes('knight_intercept'))!;
    expect(interceptRow.querySelector('[data-card-type="instant"]')).not.toBeNull();
    expect(interceptRow.textContent).toContain('ally targeted');
  });

  it('edit form uses fractional-second cooldown and shows cast time, warm-up and trigger for actives', () => {
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');

    const cooldown = modal.querySelector<HTMLInputElement>('#skf-cooldown')!;
    expect(cooldown.step).toBe('0.1');
    expect(cooldown.min).toBe('1');
    expect(modal.querySelector('#skf-cooldown-wrap')!.textContent).toContain('Cooldown (seconds)');

    for (const id of ['#skf-castTime-wrap', '#skf-warmup-wrap', '#skf-trigger-wrap']) {
      expect(modal.querySelector<HTMLElement>(id)!.style.display).not.toBe('none');
    }
    const trigger = modal.querySelector<HTMLSelectElement>('#skf-trigger')!;
    expect(trigger.value).toBe('');
    expect([...trigger.options].map(o => o.value)).toEqual(['', ...SKILL_TRIGGER_VALUES]);
    expect(trigger.options[1].textContent).toBe(SKILL_TRIGGER_INFO[SKILL_TRIGGER_VALUES[0]].label);

    expect(modal.querySelector('#skf-card-type [data-card-type="action"]')).not.toBeNull();
    expect(modal.querySelector<HTMLInputElement>('#skf-warmup')!.placeholder).toContain(`${LEGACY_BASH.cooldown! - 1}s`);
  });

  it('hides the active-only timing fields for passives and reveals them when switched to active', () => {
    new SkillsTab().render(container, makeCtx());
    container.querySelector<HTMLButtonElement>('#skill-add-btn')!.click();
    const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
    const activeOnly = [...modal.querySelectorAll<HTMLElement>('.skf-active-only')];
    expect(activeOnly.length).toBeGreaterThanOrEqual(5);
    expect(activeOnly.every(el => el.style.display === 'none')).toBe(true);

    setValue(modal, '#skf-type', 'active');
    expect(activeOnly.every(el => el.style.display === '')).toBe(true);
  });

  it('updates the card-type chip and trigger help live as the trigger changes', () => {
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');
    const chip = () => modal.querySelector('#skf-card-type [data-card-type]')!.getAttribute('data-card-type');

    setValue(modal, '#skf-trigger', 'enemy_cast');
    expect(chip()).toBe('instant');
    expect(modal.querySelector('#skf-trigger-help')!.textContent).toContain(SKILL_TRIGGER_INFO.enemy_cast.description);

    setValue(modal, '#skf-trigger', 'ally_low_hp');
    expect(chip()).toBe('instant');

    setValue(modal, '#skf-trigger', '');
    expect(chip()).toBe('action');
  });

  it('hides Recovery and never saves it while the skill has a trigger', async () => {
    const put = stubPut();
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');
    const wrap = modal.querySelector<HTMLElement>('#skf-recovery-wrap')!;
    setValue(modal, '#skf-charge', '3');
    setValue(modal, '#skf-recovery', '1.5');
    expect(wrap.style.display).toBe('');
    setValue(modal, '#skf-trigger', 'enemy_cast');
    expect(wrap.style.display).toBe('none');
    setValue(modal, '#skf-trigger', '');
    expect(wrap.style.display).toBe('');
    expect(modal.querySelector<HTMLInputElement>('#skf-recovery')!.value).toBe('1.5');
    setValue(modal, '#skf-trigger', 'enemy_cast');
    modal.querySelector<HTMLButtonElement>('#skf-save')!.click();
    await flush();

    expect(alert).not.toHaveBeenCalled();
    expect(put.bodies[0]).toMatchObject({ charge: 3, trigger: 'enemy_cast' });
    expect(put.bodies[0].recovery).toBeUndefined();
  });

  it('keeps the cooldown of a triggered skill left with only a hidden Recovery', async () => {
    const put = stubPut();
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');
    setValue(modal, '#skf-charge', '');
    setValue(modal, '#skf-recovery', '2');
    setValue(modal, '#skf-trigger', 'self_hit');
    setValue(modal, '#skf-cooldown', '5');
    modal.querySelector<HTMLButtonElement>('#skf-save')!.click();
    await flush();

    expect(alert).not.toHaveBeenCalled();
    expect(put.bodies[0]).toMatchObject({ cooldown: 5, trigger: 'self_hit' });
    expect(put.bodies[0].recovery).toBeUndefined();
    expect(put.bodies[0].charge).toBeUndefined();
  });

  it('hides Recovery on a skill whose trigger is inferred, and on opening a stale one', () => {
    const stale: SkillDefinition = { ...SEED_SKILLS.knight_intercept, id: 'stale_intercept', recovery: 1.8 };
    delete stale.trigger;
    new SkillsTab().render(container, makeCtx({ extraSkills: [stale] }));
    const modal = openEdit(container, 'stale_intercept');
    expect(modal.querySelector<HTMLElement>('#skf-recovery-wrap')!.style.display).toBe('none');
  });

  it('shows an inferred trigger for an Intercept skill authored without one', () => {
    const legacyIntercept: SkillDefinition = { ...SEED_SKILLS.knight_intercept, id: 'legacy_intercept' };
    delete legacyIntercept.trigger;
    new SkillsTab().render(container, makeCtx({ extraSkills: [legacyIntercept] }));
    const modal = openEdit(container, 'legacy_intercept');

    expect(modal.querySelector<HTMLSelectElement>('#skf-trigger')!.value).toBe('');
    expect(modal.querySelector('#skf-card-type [data-card-type="instant"]')).not.toBeNull();
    expect(modal.querySelector('#skf-trigger-help')!.textContent).toContain('inferred');
  });

  it('saves fractional cooldown, cast time, warm-up and trigger', async () => {
    const put = stubPut();
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');
    setValue(modal, '#skf-cooldown', '2.5');
    setValue(modal, '#skf-castTime', '0.5');
    setValue(modal, '#skf-warmup', '0');
    modal.querySelector<HTMLButtonElement>('#skf-save')!.click();
    await flush();

    expect(alert).not.toHaveBeenCalled();
    expect(put.bodies).toHaveLength(1);
    expect(put.bodies[0]).toMatchObject({ id: 'knight_bash', cooldown: 2.5, castTime: 0.5, warmup: 0 });
    expect(put.bodies[0].trigger).toBeUndefined();
  });

  it('omits blank warm-up and cast time, and never sends active timing on a passive', async () => {
    const put = stubPut();
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_guard');
    modal.querySelector<HTMLButtonElement>('#skf-save')!.click();
    await flush();

    expect(put.bodies).toHaveLength(1);
    for (const key of ['cooldown', 'castTime', 'warmup', 'trigger']) {
      expect(key in put.bodies[0]).toBe(false);
    }
  });

  it('surfaces validation errors (a triggered skill with a cast time) instead of saving', async () => {
    const put = stubPut();
    new SkillsTab().render(container, makeCtx());
    const modal = openEdit(container, 'knight_bash');
    setValue(modal, '#skf-trigger', 'self_hit');
    setValue(modal, '#skf-castTime', '1');
    modal.querySelector<HTMLButtonElement>('#skf-save')!.click();
    await flush();

    expect(put.bodies).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(alert).mock.calls[0][0])).toContain('cast time');
  });
});
