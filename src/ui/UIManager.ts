/**
 * UIManager handles HTML-based UI elements that overlay the game canvas.
 * This approach is more portable (works on web, mobile via Capacitor, etc.)
 * and doesn't get affected by camera zoom/pan.
 */
export class UIManager {
  private container: HTMLElement;
  private statusElement: HTMLElement;

  constructor() {
    // Create UI container
    this.container = document.createElement('div');
    this.container.id = 'game-ui';
    this.container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      font-family: Arial, sans-serif;
    `;

    // Create status bar
    this.statusElement = document.createElement('div');
    this.statusElement.id = 'status-bar';
    this.statusElement.style.cssText = `
      position: absolute;
      top: 16px;
      left: 16px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 14px;
      pointer-events: auto;
    `;
    this.container.appendChild(this.statusElement);

    // Append to game container (so it overlays the canvas)
    const gameContainer = document.getElementById('game-container');
    if (gameContainer) {
      gameContainer.style.position = 'relative';
      gameContainer.appendChild(this.container);
    }
  }

  setStatus(text: string): void {
    this.statusElement.textContent = text;
  }

  destroy(): void {
    this.container.remove();
  }
}
