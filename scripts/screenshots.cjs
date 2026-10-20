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
  // Esc with nothing open brings up the main menu, so dialogs are closed directly.
  const closeModal = () => page.evaluate(() => document.querySelector('.modal-backdrop') && window.ironBaron.closeModal());
  await page.goto('http://localhost:4173/?seed=42&size=128');
  await page.waitForFunction(() => window.ironBaron && window.ironBaron.game && !document.querySelector('.loading'));
  await page.keyboard.press('Space');
  // 1. new game dialog
  await page.keyboard.press('n');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/01-new-game.png` });
  await closeModal();
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    app.setSpeed(0);
    for (const r of g.territories.regions) r.chartered = true;
    for (let i = 0; i < 6; i++) g.issueBond();
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
    const route = (a, b) => [{ station: a.id, load: 'auto', waitFull: false }, { station: b.id, load: 'auto', waitFull: false }];
    for (let i = 0; i + 1 < st.length; i++) {
      const r = g.buildTrack(st[i].tiles[st[i].tiles.length - 1], st[i + 1].tiles[0], opts(false));
      links.push(r.ok ? Math.round(r.cost) : r.error);
      if (!r.ok) continue;
      g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[i], st[i + 1]));
      if (i === 0) g.buyTrain('columbia', ['passengers', 'passengers', 'mail', '@dining'], route(st[i + 1], st[i]));
    }
    g.buildImprovement(st[0].id, 'water_tower');
    g.buildImprovement(st[0].id, 'hotel');
    for (let i = 0; i < 24 * 120; i++) g.step();
    g.issueBond();
    g.setDividend(0.5);
    for (let i = 0; i < 24 * 280; i++) g.step();
    return { stations: st.map((s) => [s.id, s.name]), links, cash: Math.round(g.company.cash) };
  });
  console.log(JSON.stringify(info));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/11-year-end.png` });
  await closeModal();
  await page.waitForTimeout(200);
  for (const [tab, n] of [['books', 12], ['bonds', 13], ['stock', 14], ['portfolio', 15]]) {
    await page.keyboard.press('m');
    await page.waitForTimeout(200);
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${n}-finance-${tab}.png` });
    await closeModal();
    await page.waitForTimeout(150);
  }
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
  await closeModal();
  await page.waitForTimeout(200);
  await closeModal();
  // 9. economic report
  await page.click('#econ');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/09-economic-report.png` });
  await closeModal();
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
  // 22–27. insight tools (M7)
  await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    app.camera.rotate(-1);
    const st = g.world.liveStations().filter((s) => s.owner === 0)[1];
    const W = g.world.width;
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 1);
    app.camera.centerOn(st.tiles[0] % W, Math.floor(st.tiles[0] / W));
    app.pinned = null;
    app.selectTrain(null);
    g.saveTemplate(g.trains.trains.find((t) => t.owner === 0).id);
  });
  await page.keyboard.press('u');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/22-advisor.png` });
  await page.click('[data-tab="deliveries"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/23-delivery-formulas.png` });
  await page.click('[data-tab="advice"]');
  await closeModal();
  await page.keyboard.press('k');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/24-statistics.png` });
  await page.click('[data-tab="worth"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/25-statistics-worth.png` });
  await page.click('[data-tab="revenue"]');
  await closeModal();
  for (const [kind, n] of [['supply', 26], ['congestion', 27], ['gradient', 28]]) {
    await page.keyboard.press('j');
    await page.waitForTimeout(200);
    await page.click(`[data-ov="${kind}"]`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${n}-overlay-${kind}.png` });
  }
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('y');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/29-supply-chains.png` });
  await page.click('[data-cargo="coal"]');
  await page.evaluate(() => {
    const app = window.ironBaron;
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 0);
    app.camera.centerOn(app.game.world.width / 2, app.game.world.height / 2);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/30-chain-coal.png` });
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('f');
  await page.waitForTimeout(200);
  await page.click('[data-selq="all"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/31-train-table.png` });
  await closeModal();
  await page.hover('#stock');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/32-formula-tooltip.png` });
  await page.mouse.move(600, 500);
  // 33–37. content & polish (M8)
  await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    g.forceEvent('gold_rush');
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 0);
    app.camera.centerOn(g.world.width / 2, g.world.height / 2);
    for (const r of g.territories.regions) if (r.restricted) r.chartered = false;
  });
  await page.keyboard.press('j');
  await page.waitForTimeout(200);
  await page.click('[data-ov="territories"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/33-territories.png` });
  await page.keyboard.press('Shift+J');
  await page.click('#econ');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/34-events.png` });
  await closeModal();
  await page.keyboard.press('m');
  await page.click('[data-tab="manager"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/35-managers.png` });
  await closeModal();
  await page.click('#btn-save');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/36-save-load.png` });
  await closeModal();
  await page.click('#btn-settings');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/37-settings.png` });
  await closeModal();
  await page.evaluate(() => window.ironBaron.camera.rotate(1));
  // 18–21. rivals (M6)
  await page.evaluate(() => window.ironBaron.camera.rotate(-1));
  await page.keyboard.press('o');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/18-railroads.png` });
  const rival = await page.evaluate(() => window.ironBaron.game.companies.find((c) => c.id !== 0 && !c.defunct)?.id ?? -1);
  if (rival >= 0) {
    await page.click(`[data-co="${rival}"]`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/19-railroads-rival.png` });
  }
  await closeModal();
  const rivalInfo = await page.evaluate(() => {
    const app = window.ironBaron;
    const g = app.game;
    const st = g.world.liveStations().find((s) => s.owner !== 0);
    if (!st) return 'no rival station';
    const W = g.world.width;
    const mid = st.tiles[Math.floor(st.tiles.length / 2)];
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 2);
    app.camera.centerOn((mid % W) + 0.5, Math.floor(mid / W) + 0.5);
    app.pinned = [mid % W, Math.floor(mid / W)];
    app.invalidatePanel();
    return `${st.name} (${g.companyById(st.owner).name})`;
  });
  console.log('rival station:', rivalInfo);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/20-rival-station.png` });
  await page.evaluate(() => window.ironBaron.game.endGame('board', 'The shareholders voted you out: only 38 % stood by you, for the second year running.'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/21-game-over.png` });
  // 38–40. title, scenarios, tutorial (M8)
  await closeModal();
  await page.evaluate(() => window.ironBaron.openTitle());
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/38-title.png` });
  await page.click('[data-t="scenarios"]');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/39-scenarios.png` });
  await page.click('[data-start="tutorial"]');
  await page.waitForFunction(() => window.ironBaron.game.scenario && !document.querySelector('.loading'));
  await page.waitForTimeout(600);
  await page.click('[data-tut="next"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/40-tutorial.png` });
  // 41–42. hand-made maps: a scenario on one, and the map picker
  await page.evaluate(() => window.ironBaron.openTitle());
  await page.waitForTimeout(300);
  await page.click('[data-t="scenarios"]');
  await page.waitForTimeout(300);
  await page.click('[data-start="over_the_pass"]');
  await page.waitForFunction(() => window.ironBaron.game.scenario && window.ironBaron.game.scenario.id === 'over_the_pass' && !document.querySelector('.loading'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/41-hand-made-map.png` });
  await page.evaluate(() => window.ironBaron.openNewGameDialog());
  await page.waitForTimeout(300);
  await page.selectOption('select[name="layout"]', 'oil_basin');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/42-map-picker.png` });
  // 43–45. passenger destinations and transfers
  await closeModal();
  const flow = await page.evaluate(() => {
    const app = window.ironBaron;
    app.newGame({ ...app.game.params }, { rivals: 0, destinations: true });
    const g = app.game;
    app.setSpeed(0);
    for (const r of g.territories.regions) r.chartered = true;
    g.company.cash = 5e6;
    const towns = [...g.world.cities].sort((a, b) => b.population - a.population).slice(0, 3);
    const st = [];
    for (const town of towns) {
      for (const [dx, dy] of [[0, 3], [0, -3], [3, 0], [-3, 0], [0, 4], [4, 0], [2, 2], [-2, -2], [0, 5], [5, 0]]) {
        const r = g.buildStation(town.x + dx, town.y + dy, 'station', 'x');
        if (r.ok) { st.push(r.station); break; }
      }
    }
    const opts = { double: false, bridge: 'auto', tunnels: true, demolish: true, year: 1850 };
    const links = [];
    for (let i = 0; i + 1 < st.length; i++) links.push(g.buildTrack(st[i].tiles[st[i].tiles.length - 1], st[i + 1].tiles[0], opts).ok);
    const route = (a, b, tb) => [{ station: a.id, load: 'auto', waitFull: false }, { station: b.id, load: 'auto', waitFull: false, ...(tb ? { transfer: true } : {}) }];
    g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[0], st[1], true));
    g.buyTrain('columbia', ['passengers', 'passengers', 'mail', 'passengers'], route(st[1], st[2]));
    for (let i = 0; i < 24 * 150; i++) g.step();
    const hub = st[1];
    const W = g.world.width;
    const mid = hub.tiles[1];
    app.camera.zoomAt(app.canvas.width / 2, app.canvas.height / 2, 2);
    app.camera.centerOn((mid % W) + 0.5, Math.floor(mid / W) + 0.5);
    app.pinned = [mid % W, Math.floor(mid / W)];
    app.invalidatePanel();
    const sc = g.economy.cargoAt(hub.id);
    return { st: st.map((s) => s.name), links, lots: (sc.transfer || []).length, dest: sc.dest, rev: g.company.revenueIn(g.year) };
  });
  console.log(JSON.stringify(flow));
  await page.mouse.move(600, 880);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/43-destinations-hub.png` });
  await page.evaluate(() => { const app = window.ironBaron; const t = app.game.trains.trains.find((x) => x.cars.some((c) => c.loads > 0)) || app.game.trains.trains[0]; app.selectTrain(t.id); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/44-train-bound-for.png` });
  await page.click('[data-act="edit"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/45-route-transfer.png` });

  console.log(logs.join('\n'));
  await browser.close();
})();
