// Run in the browser console on the executive report overview with nonzero sales.
// This checks real layout in Safari/Chromium; jsdom cannot measure rendered bars.
(() => {
  const plots = [...document.querySelectorAll('.executive-area-chart__plot')];
  if (!plots.length) throw new Error('Open the executive report overview first');
  let nonzeroBars = 0;
  const results = plots.map(plot => {
    const bar = plot.querySelector('i');
    const grid = plot.closest('.executive-area-chart__columns')
      .querySelector('.executive-area-chart__grid').getBoundingClientRect();
    const rect = plot.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const fraction = parseFloat(bar.style.height) / 100;
    const top = parseFloat(bar.style.top) / 100;
    if (fraction > 0) nonzeroBars++;
    const passes = rect.height > 0 && barRect.width > 0
      && Math.abs(rect.height - grid.height) < 1
      && Math.abs(rect.top - grid.top) < 1
      && Math.abs(barRect.height - grid.height * fraction) < 1
      && Math.abs(barRect.top - (grid.top + grid.height * top)) < 1;
    return { passes, plotHeight: rect.height, barHeight: barRect.height };
  });
  if (!nonzeroBars || results.some(result => !result.passes)) {
    throw new Error(`Chart layout regression: ${JSON.stringify(results)}`);
  }
  return `PASS: ${results.length} bars align with the chart scale`;
})();
