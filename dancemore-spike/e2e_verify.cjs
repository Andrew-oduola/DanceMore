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
const LOWCONF = path.resolve(__dirname, "test-fixtures", "lowconf.mp4");

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
  // Starters now carry real youtubeIds, so WATCH renders the privacy-enhanced
  // embed (the self-hosted <video> path is still covered by the uploaded move).
  await page.click("text=Side Step Reach");
  await page.waitForSelector("text=Step side to side");
  const video = page.locator("video");
  const iframeSrc = await page.locator("iframe").getAttribute("src");
  check(
    `WATCH renders youtube-nocookie embed (${iframeSrc})`,
    !!iframeSrc &&
      iframeSrc.startsWith("https://www.youtube-nocookie.com/embed/ujREEgxEP7g")
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

  // hand-pick one via the scrubber. Wait for the frame to actually settle
  // (seeked) before capturing; under heavy CPU load retry the click once.
  const beforeCount = await thumbs().count();
  await video.evaluate(
    (v) =>
      new Promise((res) => {
        v.pause();
        v.addEventListener("seeked", () => res(), { once: true });
        v.currentTime = v.duration / 2;
      })
  );
  let captured = false;
  for (let attempt = 0; attempt < 2 && !captured; attempt++) {
    await page.click('button:has-text("Capture this frame")');
    captured = await page
      .waitForFunction(
        (n) =>
          document.querySelectorAll('input[aria-label="Checkpoint name"]')
            .length === n + 1,
        beforeCount,
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
  }
  check("scrubber capture adds a checkpoint", captured);
  check(
    "clean full-body capture shows NO low-confidence hint",
    !(await page.isVisible("text=Pose looks partly unclear"))
  );

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

  // ── Low-confidence upload: capture never blocks; move still practices ──
  // lowconf.mp4 is a tight head crop → MoveNet finds <4 confident joints, so
  // auto-sampling keeps nothing and every manual capture is "low confidence".
  await page.click('button:has-text("Library")');
  await page.waitForSelector("text=Pick a move to practice");
  await page.click("text=⬆ Upload a dance");
  await page.waitForSelector("text=Choose a video file");
  await page.setInputFiles('input[type="file"]', LOWCONF);
  await page.waitForSelector("text=Capture this frame", { timeout: 180000 });
  check(
    "low-confidence clip: auto-sampler keeps nothing (selective)",
    (await page.locator('input[aria-label="Checkpoint name"]').count()) === 0
  );

  // Capture two frames by hand — neither may be blocked.
  for (const frac of [0.3, 0.6]) {
    const n = await page.locator('input[aria-label="Checkpoint name"]').count();
    await page.locator("video").evaluate(
      (v, f) =>
        new Promise((res) => {
          v.pause();
          v.addEventListener("seeked", () => res(), { once: true });
          v.currentTime = v.duration * f;
        }),
      frac
    );
    await page.click('button:has-text("Capture this frame")');
    await page.waitForFunction(
      (k) =>
        document.querySelectorAll('input[aria-label="Checkpoint name"]')
          .length === k + 1,
      n,
      { timeout: 30000 }
    );
  }
  check("low-confidence frame is captured anyway (no block)", true);
  check(
    "…soft, non-blocking hint shown",
    await page.isVisible("text=Pose looks partly unclear")
  );
  check(
    "…low-confidence checkpoints flagged in the strip",
    (await page.locator("text=low confidence").count()) >= 1
  );
  await page.screenshot({ path: "shot_lowconf.png" });

  await page.fill('input[placeholder^="Move name"]', "Lowconf Move");
  await page.click('button:has-text("Save move")');
  await page.waitForSelector('button.moveCard:has-text("Lowconf Move")');
  check("low-confidence move saved to library", true);

  // Practice it: must run and score without crashing / NaN / hanging.
  let practiceError = null;
  const onErr = (e) => (practiceError = e.message);
  page.on("pageerror", onErr);
  await page.click("text=Lowconf Move");
  await page.click('button:has-text("Practice this move")'); // has demoVideo → WATCH
  if (
    await page
      .waitForSelector("text=Warm up first", { timeout: 2000 })
      .then(() => true)
      .catch(() => false)
  )
    await page.click("text=Skip for now");
  await page.waitForSelector("text=Pose 1 of 2");
  await page.waitForTimeout(2500);
  const scoreText = await page
    .locator("text=/^(Get into frame|\\d{1,3})$/")
    .first()
    .innerText()
    .catch(() => "");
  check(
    `low-conf practice shows a valid score state ("${scoreText}", no NaN)`,
    /^(Get into frame|\d{1,3})$/.test(scoreText)
  );
  for (let i = 0; i < 2; i++) {
    await page.click('button:has-text("Skip / Next")', { force: true });
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("text=Overall score");
  const overallLow = await page
    .locator("text=Overall score")
    .locator("xpath=following-sibling::div[1]")
    .innerText()
    .catch(() => "?");
  check(
    `low-conf move reaches RESULT with a finite score ("${overallLow}")`,
    /^\d{1,3}$/.test(overallLow.trim())
  );
  check("no JS error while practicing a low-confidence move", practiceError === null);
  page.off("pageerror", onErr);
  await page.click('button:has-text("Back to Moves")', { force: true });

  // ── Camera-deny recovery ──
  // Real browsers throw NotAllowedError when the user denies; headless
  // Chromium can't reproduce that exact name (and a fake-device-only browser
  // can't getUserMedia headlessly at all). So in a fresh context of the MAIN
  // browser (which has a working fake camera) we stub getUserMedia to reject
  // ONCE with a genuine NotAllowedError, then delegate to the real camera —
  // exercising classify → overlay → "Try again" → resume deterministically.
  const deniedCtx = await browser.newContext({
    permissions: ["camera"],
    reducedMotion: "reduce",
  });
  await deniedCtx.addInitScript(() => {
    // Patch at the prototype level — an instance own-property override does
    // not reliably intercept the call. Deny every call until the test flips
    // window.__allowCam (robust against React StrictMode's double-mount, which
    // would otherwise consume a fixed denial count and succeed on remount).
    const md = navigator.mediaDevices;
    const proto = Object.getPrototypeOf(md);
    const real = md.getUserMedia.bind(md);
    window.__allowCam = false;
    Object.defineProperty(proto, "getUserMedia", {
      configurable: true,
      writable: true,
      value: (c) =>
        window.__allowCam
          ? real(c)
          : Promise.reject(
              new DOMException("Permission denied", "NotAllowedError")
            ),
    });
  });
  const p2 = await deniedCtx.newPage();
  await p2.goto("http://localhost:3000/");
  await p2.fill('input[placeholder="Username"]', "demo");
  await p2.fill('input[placeholder="Password"]', "demo1234");
  await p2.click('button:has-text("Log in")');
  await p2.waitForSelector("text=Pick a move to practice");
  await p2.click("text=Side Step Reach");
  await p2.click('button:has-text("Practice this move")');
  await p2.waitForSelector("text=Warm up first");
  await p2.click("text=Skip for now");
  await p2.waitForSelector("text=Pose 1 of 3");
  const overlayShown = await p2
    .waitForSelector("text=Your browser is blocking the camera", {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false);
  check("camera denied → friendly recovery overlay (not a dead end)", overlayShown);
  check(
    "…overlay has a Try again button",
    await p2.isVisible('button:has-text("Try again")')
  );
  check(
    "…overlay has unblock instructions",
    await p2.isVisible("text=address bar")
  );
  check(
    "…overlay has a Reload page button",
    await p2.isVisible('button:has-text("Reload page")')
  );
  await p2.screenshot({ path: "shot_camera_denied.png" });

  // Unblock (what allowing via the address bar does), then "Try again" must
  // resume the live feed + detection.
  await p2.evaluate(() => {
    window.__allowCam = true;
  });
  await p2.click('button:has-text("Try again")', { force: true });
  const feedBack = await p2
    .waitForFunction(
      () => {
        const t = document.body.innerText;
        return (
          !t.includes("Your browser is blocking the camera") &&
          !t.includes("Loading model…")
        );
      },
      null,
      { timeout: 120000 }
    )
    .then(() => true)
    .catch(() => false);
  check("Try again → feed + detection resume normally", feedBack);
  await deniedCtx.close();

  await browser.close();
  console.log(
    "Screenshots: shot_login.png, shot_upload_review.png, shot_practice.png, shot_dashboard.png, shot_camera_denied.png"
  );
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
