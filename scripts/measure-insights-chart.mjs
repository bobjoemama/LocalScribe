/**
 * Measures the History Insights activity chart in Chromium, at the two
 * supported Settings sizes, and reports whether rendered bar height is linear
 * in the requested percentage.
 *
 * `activityBarHeightPercent` is only meaningful if the percentage resolves
 * against the same box for every column. When the column was a flex column and
 * the bar asked for a percentage of the whole 215px chart, flex-shrink absorbed
 * the overflow for tall bars only, so it was not:
 *
 *   requested   rendered   share of the tallest bar
 *          5%      10.75                      5.65%
 *         65%     139.75                     73.44%
 *        100%     190.30                    100.00%   (label squeezed to 24.7px)
 *
 * Run it after any change to the chart's geometry:
 *
 *   npx electron scripts/measure-insights-chart.mjs
 *
 * The DOM below is transcribed from `ActivityChart`; the shape is pinned by
 * tests/historyInsightsUi.test.tsx so the transcription cannot silently drift.
 * The window itself is left at Electron's default size: the chart's height is
 * fixed and only the card's content width varies between the two Settings
 * sizes, so the card is measured at each width inside one window.
 */
import { app, BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const css = readFileSync(
  resolve(repository, "src/renderer/settings/screens/history-insights.css"),
  "utf8",
);

const REQUESTED_PERCENTS = [5, 15, 25, 35, 45, 55, 65, 100];

/** Card content widths: the `minmax(0, 1.42fr)` column less 21px of padding. */
const CARD_WIDTHS = [["1220x760", 690], ["900x640", 470]];

const columns = REQUESTED_PERCENTS.map((percent, index) => `
  <div class="hi-chart-column" data-edge="${index === 0 ? "start" : "middle"}">
    <span class="hi-chart-tooltip"><strong>1,204 words</strong><small>Monday, Mar 3</small></span>
    <i style="height:${percent}%"></i>
    <span class="hi-chart-label">3</span>
  </div>`).join("");

const page = `<div class="hi-screen" style="padding:0">
  <div id="card-frame"><section class="hi-insight-card">
    <div class="hi-card-heading"><h2>Activity</h2><span>Last 30 days</span></div>
    <div class="hi-chart" role="group">
      <div class="hi-chart-grid"><span></span><span></span><span></span></div>
      <div class="hi-chart-bars">${columns}</div>
    </div>
  </section></div>
</div>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL("data:text/html,<title>insights chart measurement</title>");
  await window.webContents.executeJavaScript(`(() => {
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    document.body.style.margin = "0";
    document.body.innerHTML = ${JSON.stringify(page)};
    return true;
  })()`);

  for (const [label, cardWidth] of CARD_WIDTHS) {
    const measurement = await window.webContents.executeJavaScript(`(() => {
      document.getElementById("card-frame").style.width = "${cardWidth}px";
      const chartElement = document.querySelector(".hi-chart");
      const chart = chartElement.getBoundingClientRect();
      const topGridline = document.querySelector(".hi-chart-grid span").getBoundingClientRect();
      const bars = [...document.querySelectorAll(".hi-chart-column")].map((column) => {
        const bar = column.querySelector("i");
        const axis = column.querySelector(".hi-chart-label").getBoundingClientRect();
        const box = bar.getBoundingClientRect();
        return {
          requested: parseFloat(bar.style.height),
          rendered: +box.height.toFixed(2),
          baseline: +box.bottom.toFixed(2),
          labelHeight: +axis.height.toFixed(2),
        };
      });
      const tallest = Math.max(...bars.map((bar) => bar.rendered));
      const labelHeight = parseFloat(
        getComputedStyle(chartElement).getPropertyValue("--hi-chart-label-height"),
      ) || 0;
      return {
        bars: bars.map((bar) => ({ ...bar, share: +(bar.rendered / tallest * 100).toFixed(2) })),
        tallestAboveTopGridline: +(topGridline.top - (chart.bottom - labelHeight - tallest)).toFixed(2),
        plotHeight: +(chart.height - labelHeight).toFixed(2),
      };
    })()`);

    console.log(`\n${label}  (card content width ${cardWidth}px, plot area ${measurement.plotHeight}px)`);
    console.log("  requested   rendered      share   label");
    for (const bar of measurement.bars) {
      console.log(
        `  ${String(bar.requested).padStart(8)}%`
        + `${String(bar.rendered).padStart(11)}`
        + `${String(`${bar.share}%`).padStart(11)}`
        + `${String(`${bar.labelHeight}px`).padStart(9)}`,
      );
    }
    const worst = Math.max(...measurement.bars.map((bar) => Math.abs(bar.share - bar.requested)));
    console.log(`  worst share error: ${worst.toFixed(2)} percentage points`);
  }

  app.exit(0);
});
