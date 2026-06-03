/* End-to-end check of the acceptance criteria (Phases 3 + 4).
 * Needs: Django on :8000, Next dev on :3000.
 * Uses Chromium's fake webcam, so PRACTICE is completed via "Skip / Next".
 */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const ctx = await browser.newContext({ permissions: ["camera"] });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE JS ERROR:", e.message));

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures++;
    console.log(`[${cond ? "OK " : "FAIL"}] ${name}`);
  };

  // ── Login screen (landing) screenshot ──
  await page.goto("http://localhost:3000/");
  await page.waitForSelector('input[placeholder="Username"]');
  await page.screenshot({ path: "shot_login.png" });

  // ── Register, land in app, persist across refresh ──
  const uname = "e2e_" + Date.now();
  await page.click("text=No account? Register");
  await page.fill('input[placeholder="Username"]', uname);
  await page.fill('input[placeholder="Password"]', "pass1234");
  await page.click('button:has-text("Register")');
  await page.waitForSelector("text=Pick a move to practice");
  check("register → library", true);

  await page.reload();
  const stillIn = await page
    .waitForSelector("text=Pick a move to practice", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("stays logged in across refresh", stillIn);

  // ── No rest banner for a fresh user (streak < 6) ──
  await page.waitForTimeout(800); // let the stats fetch settle
  check(
    "no rest banner for fresh user",
    !(await page.isVisible("text=consider a rest day"))
  );

  // ── Warmup gates the first practice of the day ──
  await page.click("text=Side Step Reach");
  await page.waitForSelector("text=Warm up first");
  check("warmup appears before first practice", true);

  const startBtn = page.locator('button:has-text("done")');
  check(
    "Start gated until all items checked",
    (await startBtn.count()) === 1 && (await startBtn.isDisabled())
  );

  for (const box of await page.locator('input[type="checkbox"]').all())
    await box.check();
  await page.click('button:has-text("Start practicing")');
  await page.waitForSelector("text=Pose 1 of 3");
  check("all checked → Start practicing → practice", true);

  // warmedUpDate persisted: leaving and re-entering skips the warmup
  await page.click('button:has-text("Back to Moves")');
  await page.click("text=Side Step Reach");
  await page.waitForSelector("text=Pose 1 of 3");
  check("second practice same day skips warmup", true);

  // skip link path: clear the stored date and use "Skip for now"
  await page.click('button:has-text("Back to Moves")');
  await page.evaluate(() => localStorage.removeItem("dancemore_warmedUpDate"));
  await page.click("text=Side Step Reach");
  await page.waitForSelector("text=Warm up first");
  await page.click("text=Skip for now");
  await page.waitForSelector("text=Pose 1 of 3");
  check("warmup 'Skip for now' proceeds to practice", true);

  // ── Complete the move (skip through), attempt saved ──
  await page.waitForTimeout(500);
  await page.screenshot({ path: "shot_practice.png" });
  for (let i = 0; i < 3; i++) {
    await page.click('button:has-text("Skip / Next")');
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("text=Overall score");
  const savedBadge = await page
    .waitForSelector("text=Attempt saved", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("result + 'Attempt saved' indicator", savedBadge);

  // ── Logout ──
  await page.click('button:has-text("Back to Moves")');
  await page.click('button:has-text("Logout")');
  await page.waitForSelector('input[placeholder="Username"]');
  check(
    "logout clears token, shows login",
    await page.evaluate(() => localStorage.getItem("dancemore_token") === null)
  );

  // ── Demo account: rest banner (streak 24) + dashboard ──
  await page.fill('input[placeholder="Username"]', "demo");
  await page.fill('input[placeholder="Password"]', "demo1234");
  await page.click('button:has-text("Log in")');
  await page.waitForSelector("text=Pick a move to practice");
  const bannerOnLibrary = await page
    .waitForSelector("text=consider a rest day", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check("rest banner shows for demo (streak 24) on Library", bannerOnLibrary);
  check(
    "banner text includes streak count",
    (await page.textContent("body")).includes("24 days in a row")
  );

  await page.click('button:has-text("Dashboard")');
  await page.waitForSelector("text=Score over time");
  check(
    "banner also on Dashboard",
    await page.isVisible("text=consider a rest day")
  );
  await page.click('[aria-label="Dismiss"]');
  await page.waitForTimeout(200);
  check(
    "banner dismissible",
    !(await page.isVisible("text=consider a rest day"))
  );
  await page.click('button:has-text("Library")');
  await page.waitForTimeout(300);
  check(
    "dismissal holds across views (session)",
    !(await page.isVisible("text=consider a rest day"))
  );

  // dashboard content + screenshot
  await page.click('button:has-text("Dashboard")');
  await page.waitForSelector("text=Score over time");
  await page.waitForTimeout(600);
  const dots = await page.locator(".recharts-area-dot").count();
  check(`dashboard chart renders (dots=${dots})`, dots >= 33);
  await page.screenshot({ path: "shot_dashboard.png", fullPage: true });

  await browser.close();
  console.log("Screenshots: shot_login.png, shot_practice.png, shot_dashboard.png");
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
