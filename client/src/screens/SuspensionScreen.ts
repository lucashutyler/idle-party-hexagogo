import type { Screen } from './ScreenManager';
import { submitAppeal } from '../network/AuthClient';

export class SuspensionScreen implements Screen {
  private container: HTMLElement;
  private email: string = '';

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.buildDOM();
    this.wireEvents();
  }

  setEmail(email: string): void {
    this.email = email;
  }

  onActivate(): void {
    const textarea = this.container.querySelector('.suspension-textarea') as HTMLTextAreaElement;
    const btn = this.container.querySelector('.suspension-submit') as HTMLButtonElement;
    const feedback = this.container.querySelector('.suspension-feedback') as HTMLElement;
    if (textarea) { textarea.value = ''; textarea.disabled = false; }
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
    if (feedback) feedback.textContent = '';
  }

  onDeactivate(): void {
    // no-op
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="offline-content">
        <div class="offline-icon" style="color: var(--color-danger, #e74c3c);">X</div>
        <h2 class="offline-title">Account Suspended</h2>
        <p class="offline-status">Your account has been suspended. If you believe this is an error, you may submit a case for review below.</p>
        <textarea class="suspension-textarea" placeholder="Explain why your account should be reactivated..." maxlength="500" rows="4" style="width: 100%; max-width: 400px; margin: 12px auto; display: block; font-family: inherit; font-size: inherit; padding: 8px; background: var(--color-bg-panel, #1a1a2e); color: var(--color-text, #eee); border: 2px solid var(--color-border, #333); resize: vertical;"></textarea>
        <button class="suspension-submit" style="margin-top: 4px;">Submit</button>
        <p class="suspension-feedback" style="margin-top: 8px; min-height: 1.2em;"></p>
      </div>
    `;
  }

  private wireEvents(): void {
    const btn = this.container.querySelector('.suspension-submit') as HTMLButtonElement;
    const textarea = this.container.querySelector('.suspension-textarea') as HTMLTextAreaElement;
    const feedback = this.container.querySelector('.suspension-feedback') as HTMLElement;

    btn.addEventListener('click', async () => {
      const text = textarea.value.trim();
      if (!text) {
        feedback.textContent = 'Please enter your case before submitting.';
        feedback.style.color = 'var(--color-danger, #e74c3c)';
        return;
      }
      if (!this.email) {
        feedback.textContent = 'Unable to submit — no account email found.';
        feedback.style.color = 'var(--color-danger, #e74c3c)';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Submitting...';
      textarea.disabled = true;

      try {
        const result = await submitAppeal(this.email, text);
        if (result.success) {
          feedback.textContent = 'Your case has been submitted for review.';
          feedback.style.color = 'var(--color-success, #2ecc71)';
        } else {
          feedback.textContent = result.error ?? 'Failed to submit. Please try again.';
          feedback.style.color = 'var(--color-danger, #e74c3c)';
          btn.disabled = false;
          btn.textContent = 'Submit';
          textarea.disabled = false;
        }
      } catch {
        feedback.textContent = 'Could not connect to server. Please try again later.';
        feedback.style.color = 'var(--color-danger, #e74c3c)';
        btn.disabled = false;
        btn.textContent = 'Submit';
        textarea.disabled = false;
      }
    });
  }
}
