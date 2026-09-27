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
    if (feedback) setFeedback(feedback, '', null);
  }

  onDeactivate(): void {
    // no-op
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="offline-content">
        <div class="offline-icon suspension-icon">X</div>
        <h2 class="offline-title">Account Suspended</h2>
        <p class="offline-status">Your account has been suspended. If you believe this is an error, you may submit a case for review below.</p>
        <textarea class="suspension-textarea" placeholder="Explain why your account should be reactivated..." maxlength="500" rows="4"></textarea>
        <button class="suspension-submit">Submit</button>
        <p class="suspension-feedback"></p>
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
        setFeedback(feedback, 'Please enter your case before submitting.', 'error');
        return;
      }
      if (!this.email) {
        setFeedback(feedback, 'Unable to submit — no account email found.', 'error');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Submitting...';
      textarea.disabled = true;

      try {
        const result = await submitAppeal(this.email, text);
        if (result.success) {
          setFeedback(feedback, 'Your case has been submitted for review.', 'success');
        } else {
          setFeedback(feedback, result.error ?? 'Failed to submit. Please try again.', 'error');
          btn.disabled = false;
          btn.textContent = 'Submit';
          textarea.disabled = false;
        }
      } catch {
        setFeedback(feedback, 'Could not connect to server. Please try again later.', 'error');
        btn.disabled = false;
        btn.textContent = 'Submit';
        textarea.disabled = false;
      }
    });
  }
}

function setFeedback(el: HTMLElement, text: string, tone: 'error' | 'success' | null): void {
  el.textContent = text;
  if (tone) el.dataset.tone = tone;
  else delete el.dataset.tone;
}
