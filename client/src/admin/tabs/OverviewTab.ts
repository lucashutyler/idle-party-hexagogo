import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';

export class OverviewTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const data = ctx.overview;
    const onlineStr = data ? `${data.onlinePlayers}` : '—';
    const accountsStr = data ? `${data.totalAccounts}` : '—';
    const sessionsStr = data ? `${data.totalSessions}` : '—';
    const connectionsStr = data ? `${data.totalConnections}` : '—';
    let uptimeStr = '—';
    if (data) {
      const hours = Math.floor(data.uptime / 3600);
      const mins = Math.floor((data.uptime % 3600) / 60);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Overview</h2></div>

        <div class="admin-stats">
          <div class="admin-stat">
            <span class="admin-stat-label">Online</span>
            <span class="admin-stat-value">${onlineStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Accounts</span>
            <span class="admin-stat-value">${accountsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Sessions</span>
            <span class="admin-stat-value">${sessionsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Connections</span>
            <span class="admin-stat-value">${connectionsStr}</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-label">Uptime</span>
            <span class="admin-stat-value">${uptimeStr}</span>
          </div>
        </div>

        <div class="admin-page-section">
          <h3>Analytics <span class="admin-soon-pill">coming soon</span></h3>
          <div class="admin-analytics-grid">
            ${this.renderPlaceholder('Daily Active Users', 'Line chart of unique players per day over the last 30 days.')}
            ${this.renderPlaceholder('New Accounts', 'Daily new account signups, with a 7-day moving average.')}
            ${this.renderPlaceholder('Retention', 'D1, D7, D30 retention cohort table.')}
            ${this.renderPlaceholder('Average Session Length', 'Median minutes per active session, by day.')}
            ${this.renderPlaceholder('Level Distribution', 'Histogram of player levels across all accounts.')}
            ${this.renderPlaceholder('Class Mix', 'Pie chart of class popularity among active players.')}
          </div>
        </div>
      </div>
    `;
  }

  private renderPlaceholder(title: string, desc: string): string {
    return `
      <div class="admin-card admin-card-placeholder">
        <div class="admin-card-title">${title}</div>
        <div class="admin-card-chart-placeholder" aria-hidden="true">
          <svg viewBox="0 0 200 80" preserveAspectRatio="none">
            <polyline points="0,60 30,55 60,40 90,45 120,30 150,35 180,18 200,22"
              fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        </div>
        <div class="admin-card-body">${desc}</div>
      </div>
    `;
  }
}
