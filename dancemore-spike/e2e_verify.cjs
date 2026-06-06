/* End-to-end check of the acceptance criteria (Phases 3 + 4 + 4.5 + 5 + 5.5).
 * Needs: Django on :8000, Next dev on :3000.
 *
 * The fake webcam is fed test-fixtures/webcam.y4m (a real person holding a
 * warrior pose), and the upload fixture test-fixtures/dance.mp4 is a clip of
 * the SAME pose — so practicing the uploaded move produces genuinely high
 * scores through the real scoring pipeline (hold-to-pass auto-advances), which
 * in turn exercises the completion celebration.
 */
const path = require("path");
const { chromium } = require("playwright");

const Y4M = path.resolve(__dirname, "test-fixtures", "webcam.y4m");
const DANCE = path.resolve(__dirname, "test-fixtures", "dance.mp4");

(async () => {
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M}`,
    ],
  });
  // reducedMotion keeps hover/width transitions from confusing Playwright's
  // actionability checks while the CPU pose-inference loop hogs the main thread.
  const ctx = await browser.newContext({
    permissions: ["camera"],
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    window.__gumCalls = 0;
    window.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    navigator.mediaDevices.getUserMedia = async (...a) => {
      window.__gumCalls++;
      const s = await orig(...a);
      window.__streams.push(s);
      return s;
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE JS ERROR:", e.message));

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures++;
    console.log(`[${cond ? "OK " : "FAIL"}] ${name}`);
  };
  const gumCalls = () => page.evaluate(() => window.__gumCalls);
  const liveTracks = () =>
    page.evaluate(
      () =>
        window.__streams
          .flatMap((s) => s.getTracks())
          .filter((t) => t.readyState === "live").length
    );

  // ── Landing ──
  await page.goto("http://localhost:3000/");
  await page.waitForSelector('input[placeholder="Username"]');
  await page.screenshot({ path: "shot_login.png" });

  // ── Register + persistence ──
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

  await page.waitForTimeout(800);
  check(
    "no rest banner for fresh user",
    !(await page.isVisible("text=consider a rest day"))
  );
  check(
    "no '✓ Completed' badge for fresh user",
    (await page.locator("text=✓ Completed").count()) === 0
  );
  const badges = await page.locator("text=▶ Watch").count();
  check(`'▶ Watch' badges (found ${badges}, expect 3)`, badges === 3);

  // ── Watch → warmup → practice (starter move; low scores → manual skip) ──
  await page.click("text=Side Step Reach");
  await page.waitForSelector("text=Step side to side");
  const video = page.locator("video");
  await page.waitForTimeout(700);
  const vState = await video.evaluate((v) => ({
    loop: v.loop,
    controls: v.controls,
    paused: v.paused,
    time: v.currentTime,
  }));
  check(
    `WATCH plays demo clip (loop=${vState.loop}, t=${vState.time.toFixed(2)})`,
    vState.loop && vState.controls && !vState.paused && vState.time > 0
  );
  check("camera NOT active during WATCH", (await gumCalls()) === 0);

  await page.click('button:has-text("Practice this move")');
  await page.waitForSelector("text=Warm up first");
  check("warmup gates first practice of the day", true);
  for (const box of await page.locator('input[type="checkbox"]').all())
    await box.check();
  await page.click('button:has-text("Start practicing")');
  await page.waitForSelector("text=Pose 1 of 3");
  await page.waitForTimeout(1200);
  check("camera IS active during PRACTICE", (await gumCalls()) >= 1);
  check(
    "no ghost legend on a checkpoint without keypoints (placeholder move)",
    !(await page.isVisible("text=line yourself up"))
  );

  // rewatch round-trip releases the camera
  await page.click("text=↺ Rewatch demo", { force: true }); // inference loop saturates main thread
  await page.waitForSelector('button:has-text("Practice this move")');
  await page.waitForTimeout(600);
  check("practice camera tracks stopped on WATCH", (await liveTracks()) === 0);
  await page.click('button:has-text("Skip")');
  await page.waitForSelector("text=Pose 1 of 3");

  // skip through (starter checkpoints won't match the warrior pose)
  for (let i = 0; i < 3; i++) {
    await page.click('button:has-text("Skip / Next")', { force: true });
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("text=Overall score");
  const saved1 = await page
    .waitForSelector("text=Attempt saved", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("result + 'Attempt saved'", saved1);
  check(
    "NO celebration on a low-score attempt",
    !(await page.isVisible("text=mastered"))
  );

  // ── No-clip fallback (Drew Test) ──
  await page.click('button:has-text("Back to Moves")', { force: true });
  await page.click("text=Drew Test");
  await page.waitForSelector("text=Pose 1 of 3");
  check(
    "move without demoVideo skips WATCH",
    !(await page.isVisible('button:has-text("Practice this move")'))
  );
  await page.click('button:has-text("Back to Moves")', { force: true });

  // ── PHASE 5: upload a dance ──
  await page.click("text=⬆ Upload a dance");
  await page.waitForSelector("text=Choose a video file");
  await page.setInputFiles('input[type="file"]', DANCE);
  const sawProgress = await page
    .waitForSelector("text=Analyzing the dance", { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check("progress indicator during extraction", sawProgress);

  // review appears when extraction completes (CPU backend can be slow)
  await page.waitForSelector("text=Capture this frame", { timeout: 180000 });
  const thumbs = () => page.locator('input[aria-label="Checkpoint name"]');
  const found = await thumbs().count();
  check(`auto-sampled candidates with skeleton thumbs (found ${found})`, found >= 4);
  await page.screenshot({ path: "shot_upload_review.png" });

  // curate: rename #1, keep first two, remove the rest
  await thumbs().first().fill("Warrior");
  const removeBtns = page.locator('button:has-text("✕ Remove")');
  while ((await removeBtns.count()) > 2) await removeBtns.last().click();
  check("keep/remove toggles work (2 kept)", (await removeBtns.count()) === 2);
  // un-remove one back to verify the toggle both ways
  const keepBtns = page.locator('button:has-text("↩ Keep")');
  if ((await keepBtns.count()) > 0) await keepBtns.first().click();
  check("removed candidate can be kept again (3 kept)", (await removeBtns.count()) === 3);

  // hand-pick one via the scrubber
  await video.evaluate((v) => (v.currentTime = v.duration / 2));
  await page.waitForTimeout(400);
  await page.click('button:has-text("Capture this frame")');
  await page.waitForFunction(
    (n) => document.querySelectorAll('input[aria-label="Checkpoint name"]').length === n + 1,
    await thumbs().count(),
    { timeout: 60000 }
  );
  check("scrubber capture adds a checkpoint", true);

  // mirror toggle exercises (leave OFF — webcam pose has same orientation)
  await page.click("text=Dancer faces me (mirror)");
  await page.click("text=Dancer faces me (mirror)");

  await page.fill('input[placeholder^="Move name"]', "My Warrior Dance");
  await page.fill('input[placeholder^="Description"]', "Hold the warrior pose.");
  await page.click('button:has-text("Save move")');
  await page.waitForSelector("text=My Warrior Dance");
  check("saved move appears in library", true);
  const yoursCard = page.locator("button.moveCard", { hasText: "My Warrior Dance" });
  check(
    "'Yours' + '▶ Watch' badges on the uploaded move",
    (await yoursCard.locator("text=Yours").count()) === 1 &&
      (await yoursCard.locator("text=▶ Watch").count()) === 1
  );

  // ── Practice the uploaded move: REAL scoring (same pose on the webcam) ──
  await page.click("text=My Warrior Dance");
  await page.waitForSelector('button:has-text("Practice this move")');
  const uploadedClipPlays = await page
    .waitForFunction(
      () => {
        const v = document.querySelector("video");
        return v && v.src.startsWith("blob:") && !v.paused && v.currentTime > 0;
      },
      null,
      { timeout: 10000 }
    )
    .then(() => true)
    .catch(() => false);
  check("WATCH plays the uploaded clip (object URL)", uploadedClipPlays);
  await page.click('button:has-text("Practice this move")');
  await page.waitForSelector("text=Pose 1 of 4");

  // ── PHASE 5.6: ghost overlay on checkpoints WITH keypoints ──
  check(
    "ghost legend shown for a checkpoint with keypoints",
    await page.isVisible("text=line yourself up")
  );
  // The real proof: magenta ghost strokes actually painted on the canvas.
  const ghostDrawn = await page
    .waitForFunction(
      () => {
        const c = document.querySelector("canvas");
        if (!c || c.width === 0) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 140 && d[i + 3] > 60)
            n++;
        }
        return n > 100;
      },
      null,
      { timeout: 120000 }
    )
    .then(() => true)
    .catch(() => false);
  check("magenta ghost skeleton painted on the live canvas", ghostDrawn);
  await page.screenshot({ path: "shot_ghost.png" });

  console.log("      …live-scoring 4 checkpoints via hold-to-pass (CPU backend, be patient)");
  // all 4 checkpoints should auto-pass via hold-to-pass — no Skip clicks
  const reachedResult = await page
    .waitForSelector("text=Overall score", { timeout: 240000 })
    .then(() => true)
    .catch(() => false);
  check("hold-to-pass auto-advanced through ALL checkpoints (no skips)", reachedResult);
  await page.screenshot({ path: "shot_practice.png" });

  const overall = parseInt(
    await page
      .locator("div", { hasText: /^\d+$/ })
      .last()
      .innerText()
      .catch(() => "0"),
    10
  );
  check(`overall score from real scoring = ${overall} (expect ≥ 80)`, overall >= 80);
  const saved2 = await page
    .waitForSelector("text=Attempt saved", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("uploaded-move attempt saved to backend", saved2);

  // ── PHASE 5.5: first-completion celebration, exactly once ──
  check(
    "🎉 celebration on FIRST completion",
    await page.isVisible("text=You’ve mastered this move!")
  );
  await page.click('button:has-text("Try Again")');
  await page.waitForSelector("text=Pose 1 of 4");
  const reachedResult2 = await page
    .waitForSelector("text=Overall score", { timeout: 240000 })
    .then(() => true)
    .catch(() => false);
  check("second run also reaches RESULT", reachedResult2);
  check(
    "NO celebration on re-completion",
    !(await page.isVisible("text=You’ve mastered this move!"))
  );

  // ── 5.5: library badge + dashboard count reflect the new best ──
  await page.click('button:has-text("Back to Moves")', { force: true });
  await page.waitForSelector("text=Pick a move to practice");
  await page.waitForTimeout(1000); // stats refetch
  const completedBadges = await page.locator("text=✓ Completed").count();
  check(`'✓ Completed' badge on the mastered move (found ${completedBadges}, expect 1)`, completedBadges === 1);

  await page.click('button:has-text("Dashboard")');
  await page.waitForSelector("text=Score over time");
  const dashText = await page.locator("main").innerText();
  check(
    "dashboard shows '1/5 moves completed' (4 starters + 1 uploaded)",
    dashText.includes("1/5") && dashText.includes("Moves completed")
  );
  check(
    "✓ on the completed move's mastery row",
    dashText.includes("My Warrior Dance ✓") || /My Warrior Dance\s*✓/.test(dashText)
  );

  // ── Logout (with confirmation) / demo account regression ──
  await page.click('button:has-text("Logout")');
  await page.waitForSelector("text=Are you sure you want to log out?");
  check("logout shows confirmation dialog", true);
  await page.click('button:has-text("Cancel")');
  await page.waitForTimeout(300);
  check(
    "Cancel keeps the session",
    await page.evaluate(() => localStorage.getItem("dancemore_token") !== null)
  );
  await page.click('button:has-text("Logout")');
  await page.click('button:has-text("Log out")'); // dialog confirm
  await page.waitForSelector('input[placeholder="Username"]');
  check(
    "confirming logs out and clears token",
    await page.evaluate(() => localStorage.getItem("dancemore_token") === null)
  );

  await page.fill('input[placeholder="Username"]', "demo");
  await page.fill('input[placeholder="Password"]', "demo1234");
  await page.click('button:has-text("Log in")');
  await page.waitForSelector("text=Pick a move to practice");
  const bannerOnLibrary = await page
    .waitForSelector("text=consider a rest day", { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check("rest banner for demo (streak 24)", bannerOnLibrary);
  await page.waitForTimeout(500);
  const demoCompleted = await page.locator("text=✓ Completed").count();
  check(
    `demo library shows '✓ Completed' on seeded bests ≥80 (found ${demoCompleted}, expect 3)`,
    demoCompleted === 3
  );

  await page.click('button:has-text("Dashboard")');
  await page.waitForSelector("text=Score over time");
  await page.click('[aria-label="Dismiss"]');
  check("banner dismissible", !(await page.isVisible("text=consider a rest day")));
  const demoDash = await page.locator("main").innerText();
  check(
    "demo dashboard 'Moves completed' = 3/4",
    demoDash.includes("3/4")
  );
  const dots = await page.locator(".recharts-area-dot").count();
  check(`dashboard chart renders (dots=${dots}, expect ≥33)`, dots >= 33);
  await page.screenshot({ path: "shot_dashboard.png", fullPage: true });

  await browser.close();
  console.log(
    "Screenshots: shot_login.png, shot_upload_review.png, shot_practice.png, shot_dashboard.png"
  );
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
