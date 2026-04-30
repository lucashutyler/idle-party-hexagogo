import { xpForNextLevel } from '@idle-party-rpg/shared';
import type { Tab } from './Tab';

const MAX_LEVEL = 100;

export class XpTableTab implements Tab {
  render(container: HTMLElement): void {
    const rows: string[] = [];
    let cumulativeXp = 0;
    let cumulativeDays = 0;

    for (let level = 1; level <= MAX_LEVEL; level++) {
      const xpNeeded = xpForNextLevel(level);
      cumulativeXp += xpNeeded;

      // Daily income model: 57.6k/day solo at L1, 557k/day party at L10,
      // doubling every 10 levels above L10.
      let dailyIncome: number;
      if (level < 10) {
        const t = (level - 1) / 9;
        dailyIncome = 57600 + t * (557000 - 57600);
      } else {
        dailyIncome = 557000 * Math.pow(2, (level - 10) / 10);
      }

      const daysToLevel = xpNeeded / dailyIncome;
      cumulativeDays += daysToLevel;
      const ratePerHour = dailyIncome / 24;
      const ratePerMinute = ratePerHour / 60;

      const daysStr = daysToLevel < 1
        ? `${(daysToLevel * 24).toFixed(1)}h`
        : `${daysToLevel.toFixed(1)}d`;

      rows.push(`
        <tr${level % 10 === 0 ? ' class="xp-table-milestone"' : ''}>
          <td>${level}</td>
          <td>${formatNumber(xpNeeded)}</td>
          <td>${formatNumber(cumulativeXp)}</td>
          <td>${daysStr}</td>
          <td>${cumulativeDays.toFixed(1)}d</td>
          <td>${formatNumber(Math.round(dailyIncome))}</td>
          <td>${formatNumber(Math.round(ratePerHour))}</td>
          <td>${formatNumber(Math.round(ratePerMinute))}</td>
        </tr>
      `);
    }

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>XP Table</h2>
        </div>
        <p class="admin-page-subtitle">
          Formula: floor(18000 &times; L<sup>1.2</sup> &times; 1.06<sup>L</sup>)
          &mdash; Income model: 57.6k/day solo L1, 557k/day party L10, 2x per 10 levels
        </p>
        <div class="admin-table-wrap">
          <table class="admin-table xp-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>XP to Level</th>
                <th>Cumulative XP</th>
                <th>Est. Time</th>
                <th>Cumulative Time</th>
                <th>Rate/Day</th>
                <th>Rate/Hour</th>
                <th>Rate/Min</th>
              </tr>
            </thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div>
      </div>
    `;
  }
}

function formatNumber(n: number): string {
  // Use compact suffixes for very large XP numbers so the table stays readable at L100.
  if (n >= 1e15) return (n / 1e15).toFixed(2) + 'q';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 't';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'b';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  return n.toLocaleString();
}
