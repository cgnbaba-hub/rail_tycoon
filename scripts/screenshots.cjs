// Dev helper: regenerate screenshots/ from a running preview (npm run build && npx vite preview --port 4173).
//   node scripts/screenshots.cjs [outDir]   (needs Playwright; PLAYWRIGHT_MODULE may point to it)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const OUT = process.argv[2] || 'screenshots';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const logs = [];
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && logs.push(`[console] ${m.text()}`));
  await page.goto('http://localhost:4173/?seed=42&size=128');
  await page.waitForFunction(() => window.ironBaron && window.ironBaron.game && !document.querySelector('.loading'));
  await page.keyboard.press('Space');
  // 1. new game dialog
  await page.keyboard.press('n');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-new-game.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    app.setSpeed(0);
    g.company.cash = 2500000;
    const towns = [...g.world.cities].sort((a, b) => b.population - a.population).slice(0, 4);
    const st = [];
    for (const town of towns) {
      for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 4], [4, 0], [2, 2], [-2, -2], [0, 5], [5, 0]]) {
        const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
        if (r.ok) { st.push(r.station); break; }
      }
    }
    const opts = (double) => ({ double, bridge: 'auto', tunnels: true, demolish: true, year: 1850 });
    const links = [];
    for (let i = 0; i + 1 < st.length; i++) {
      const r = g.buildTrack(st[i].tiles[st[i].tiles.length - 1], st[i + 1].tiles[0], opts(i === 0));
      links.push(r.ok ? Math.round(r.cost) : r.error);
    }
    const route = (a, b) => [{ station: a.id, load: 'auto', waitFull: false }, { station: b.id, load: 'auto', waitFull: false }];
    for (let i = 0; i + 1 < st.length; i++) {
      g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[i], st[i + 1]));
      if (i === 0) g.buyTrain('columbia', ['passengers', 'passengers', 'mail', '@dining'], route(st[i + 1], st[i]));
    }
    g.buildImprovement(st[0].id, 'water_tower');
    g.buildImprovement(st[0].id, 'hotel');
    for (let i = 0; i < 24 * 400; i++) g.step();
    return { stations: st.map((s) => [s.id, s.name]), links, cash: Math.round(g.company.cash) };
  });
  console.log(JSON.stringify(info));
  // 2. network overview at 1x/half zoom
  await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    const sts = g.world.liveStations();
    const W = g.world.width;
    const xs = sts.map((s) => s.tiles[0] % W), ys = sts.map((s) => Math.floor(s.tiles[0] / W));
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 1);
    app.camera.centerOn((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/02-network-overview.png` });
  // 3. close-up at 2x on the first station with a train
  await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    const t = g.trains.trains[0];
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 3);
    app.selectTrain(t.id);
    app.follow(t.id);
  });
  await page.keyboard.press('1');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-train-closeup.png` });
  // 4. station panel
  await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    app.selectTrain(null);
    const st = g.world.liveStations()[0];
    const W = g.world.width;
    const mid = st.tiles[1];
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 2);
    app.camera.centerOn((mid % W) + 0.5, Math.floor(mid / W) + 0.5);
    app.pinned = [mid % W, Math.floor(mid / W)];
    app.invalidatePanel();
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-station-panel.png` });
  await page.evaluate(() => { const el = document.querySelector('#inspector'); el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/05-station-demand-improvements.png` });
  // 6. track tool preview
  await page.evaluate(() => {
    const app = window.ironBaron;
    app.pinned = null;
    const g = app.game;
    const sts = g.world.liveStations();
    const a = sts[3];
    const towns = [...g.world.cities].sort((x, y) => y.population - x.population);
    const target = towns[5];
    const W = g.world.width;
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 1);
    const end = a.tiles[a.tiles.length - 1];
    const ax = end % W, ay = Math.floor(end / W);
    app.camera.centerOn((ax + target.x) / 2, (ay + target.y) / 2);
    app.setTool('track');
    const tool = app.tools.track;
    tool.pointerDown([ax, ay], 0);
    tool.pointerMove([target.x + 3, target.y + 3]);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/06-track-tool.png` });
  await page.evaluate(() => { const app = window.ironBaron; app.tools.track.deactivate?.(); app.setTool('inspect'); });
  // 7. new train dialog
  await page.click('#tool-trains');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-fleet.png` });
  await page.click('[data-act="new"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/08-new-train-dialog.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  // 9. economic report
  await page.click('#econ');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/09-economic-report.png` });
  await page.keyboard.press('Escape');
  // 10. rotated, zoomed-out whole-map view
  await page.evaluate(() => {
    const app = window.ironBaron;
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 0);
    app.camera.centerOn(64, 64);
    app.camera.rotate(1);
  });
  await page.mouse.move(600, 500);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/10-whole-map.png` });
  console.log(logs.join('\n'));
  await browser.close();
})();
