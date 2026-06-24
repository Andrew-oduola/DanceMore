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

// Derive move-count expectations from the shipped catalog so these assertions
// stay correct as moves are added/removed (rather than hard-coded numbers).
const CATALOG = require("./public/moves.json");
const usableYt = (m) => m.youtubeId && m.youtubeId !== "REPLACE_ME";
const STARTER_COUNT = CATALOG.length;
const WATCH_COUNT = CATALOG.filter((m) => m.demoVideo || usableYt(m)).length;

const fx = (f) => path.resolve(__dirname, "test-fixtures", f);
const Y4M = fx("webcam.y4m");
const DANCE = fx("dance.mp4");
const LOWCONF = fx("lowconf.mp4");
const WEBCAM_UPPER = fx("webcam_upper.y4m"); // head/shoulders only — no legs
const WEBCAM_LEGSOUT = fx("webcam_legsout.y4m"); // full → legs-out → full
const DANCE_WAISTUP = fx("dance_waistup.mp4"); // waist-up source: upper joints, no legs
const WEBCAM_PASSTHROUGH = fx("webcam_passthrough.y4m"); // matches only ~0.5s at a time
const WEBCAM_BLIP = fx("webcam_blip.y4m"); // matches only ~0.1s (sub pass-window)

// A fake YouTube IFrame API so split-screen practice works deterministically in
// headless (real YT playback isn't controllable). The prod code only ever
// touches window.YT. Injected into every context.
const YT_FAKE = `
  window.__ytTime = 0;
  window.YT = {
    PlayerState: { UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, BUFFERING:3, CUED:5 },
    Player: function(el, opts){
      window.__ytPlayer = this; this.opts = opts;
      this.playVideo = function(){ window.__ytPlaying = true; };
      this.pauseVideo = function(){ window.__ytPlaying = false; };
      this.getCurrentTime = function(){ return window.__ytTime; };
      this.getPlayerState = function(){ return 1; };
      this.destroy = function(){};
      var self = this;
      setTimeout(function(){ opts.events && opts.events.onReady && opts.events.onReady({target:self}); }, 10);
    }
  };
  window.__ytFire = function(s){ var p=window.__ytPlayer; if(p&&p.opts.events.onStateChange) p.opts.events.onStateChange({data:s, target:p}); };
`;

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
  await ctx.addInitScript(YT_FAKE);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE JS ERROR:", e.message));

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures++;
    console.log(`[${cond ? "OK " : "FAIL"}] ${name}`);
  };
  const gumCalls = () => page.evaluate(() => window.__gumCalls);
  // Read the live-score chip reliably (it's updated imperatively each frame).
  const liveScore = (pg) =>
    pg
      .getByTestId("live-score")
      .innerText()
      .then((t) => t.trim())
      .catch(() => "");
  // A move built by uploading `clip` then capturing `n` frames via the scrubber.
  async function buildUploadedMove(pg, clip, n, name) {
    await pg.click('button:has-text("Library")');
    await pg.waitForSelector("text=Pick a move to practice");
    await pg.click("text=⬆ Upload a dance");
    await pg.waitForSelector("text=Choose a video file");
    await pg.setInputFiles('input[type="file"]', clip);
    await pg.waitForSelector("text=Capture this frame", { timeout: 180000 });
    // Drop any auto-sampled candidates so the move has EXACTLY n checkpoints
    // (high-confidence clips auto-keep up to 10, which would skew the count).
    while ((await pg.locator('button:has-text("✕ Remove")').count()) > 0)
      await pg.locator('button:has-text("✕ Remove")').first().click();
    for (let i = 0; i < n; i++) {
      const before = await pg
        .locator('input[aria-label="Checkpoint name"]')
        .count();
      await pg.locator("video").evaluate(
        (v, frac) =>
          new Promise((res) => {
            v.pause();
            v.addEventListener("seeked", () => res(), { once: true });
            v.currentTime = v.duration * frac;
          }),
        (i + 0.5) / n
      );
      for (let attempt = 0; attempt < 3; attempt++) {
        await pg.click('button:has-text("Capture this frame")');
        const ok = await pg
          .waitForFunction(
            (k) =>
              document.querySelectorAll('input[aria-label="Checkpoint name"]')
                .length >= k + 1,
            before,
            { timeout: 30000 }
          )
          .then(() => true)
          .catch(() => false);
        if (ok) break;
      }
    }
    await pg.fill('input[placeholder^="Move name"]', name);
    await pg.click('button:has-text("Save move")');
    await pg.waitForSelector(`button.moveCard:has-text("${name}")`);
  }
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
  // Every catalog move with a demo clip or usable YouTube link shows the badge.
  check(
    `'▶ Watch' badges (found ${badges}, expect ${WATCH_COUNT})`,
    badges === WATCH_COUNT
  );

  // ── Split-screen for a YouTube move (no timestamps → self-paced scoring) ──
  // Any move with a YouTube link now shows video-on-top + webcam-below; with no
  // timestamps it runs the existing self-paced scoring (video = reference).
  await page.click("text=Side Step Reach");
  // No standalone Watch step now — warmup gates the first practice of the day.
  await page.waitForSelector("text=Warm up first");
  check("warmup gates first practice of the day", true);
  for (const box of await page.locator('input[type="checkbox"]').all())
    await box.check();
  await page.click('button:has-text("Start practicing")');
  await page.waitForSelector('[data-testid="synced-practice"]');
  check(
    "YouTube move → split-screen layout (video on top + webcam, no Start button)",
    (await page.getByTestId("live-score").count()) === 1 &&
      (await page.getByTestId("synced-start").count()) === 0
  );
  await page.waitForTimeout(1200);
  check("split-screen camera IS active", (await gumCalls()) >= 1);
  // Auto-start: full body (warrior webcam) held in frame → countdown → run, no
  // click. Confirm a result isn't reached before it starts.
  check(
    "split-screen: no result before auto-start",
    !(await page.isVisible("text=Overall score"))
  );
  const autoStarted = await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="synced-practice"]')
          ?.getAttribute("data-phase") === "running",
      null,
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
  check("split-screen AUTO-STARTS when full body in frame (no click)", autoStarted);
  await page.waitForSelector("text=Pose 1 of 3"); // self-paced label
  check("split-screen runs self-paced scoring (Pose 1 of 3)", true);

  // Warrior webcam won't match the placeholder poses → advance via Skip / Next.
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("skip-next").evaluate((el) => el.click());
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("text=Overall score");
  const saved1 = await page
    .waitForSelector("text=Attempt saved", { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("split-screen result + 'Attempt saved'", saved1);
  check(
    "NO celebration on a low-score attempt",
    !(await page.isVisible("text=mastered"))
  );
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click());
  await page.waitForTimeout(600);
  check("leaving practice stops the camera tracks", (await liveTracks()) === 0);

  // ── No-video move (Drew Test) keeps the existing self-paced flow, no split-screen ──
  await page.click("text=Drew Test");
  await page.waitForSelector("text=Pose 1 of 3"); // straight to self-paced (warmed up already)
  check(
    "no-video move → existing self-paced flow (no split-screen)",
    !(await page.isVisible('[data-testid="synced-practice"]'))
  );
  check(
    "no ghost legend on a keypoint-less move",
    !(await page.isVisible("text=line yourself up"))
  );
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click());

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
  const video = page.locator("video"); // the UploadMove review player
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
  check("camera NOT active during WATCH (no live tracks)", (await liveTracks()) === 0);
  await page.click('button:has-text("Practice this move")');
  await page.waitForSelector("text=Pose 1 of 4");
  await page.waitForTimeout(1000);
  check("camera IS active during PRACTICE", (await liveTracks()) >= 1);

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
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click()); // raw click avoids Playwright post-click nav-wait hang
  await page.waitForSelector("text=Pick a move to practice");
  await page.waitForTimeout(1000); // stats refetch
  const completedBadges = await page.locator("text=✓ Completed").count();
  check(`'✓ Completed' badge on the mastered move (found ${completedBadges}, expect 1)`, completedBadges === 1);

  await page.click('button:has-text("Dashboard")');
  await page.waitForSelector("text=Score over time");
  const dashText = await page.locator("main").innerText();
  // 1 completed (the uploaded warrior) out of all starters + the 1 uploaded.
  const e2eTotal = STARTER_COUNT + 1;
  check(
    `dashboard shows '1/${e2eTotal} moves completed' (${STARTER_COUNT} starters + 1 uploaded)`,
    dashText.includes(`1/${e2eTotal}`) && dashText.includes("Moves completed")
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
  // demo has 3 seeded completions across the starter catalog (no uploads here).
  check(
    `demo dashboard 'Moves completed' = 3/${STARTER_COUNT}`,
    demoDash.includes(`3/${STARTER_COUNT}`)
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
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click()); // raw click avoids Playwright post-click nav-wait hang

  // ── Full body present, WRONG pose: scores but must not falsely pass ──
  // Webcam is the full-body warrior; Drew Test's poses are different, so it
  // should score (legs in frame → gate open) but never pass. (Drew Test is a
  // no-video move → existing self-paced flow.)
  await page.click("text=Drew Test");
  if (
    await page
      .waitForSelector("text=Warm up first", { timeout: 2000 })
      .then(() => true)
      .catch(() => false)
  )
    await page.click("text=Skip for now");
  await page.waitForSelector("text=Pose 1 of 3");
  await page.waitForTimeout(1500);
  const wrongScore = await liveScore(page);
  check(
    `full body + wrong pose: gate open, scoring runs ("${wrongScore}", not the step-back prompt)`,
    !wrongScore.includes("Step back")
  );
  await page.waitForTimeout(3500);
  check(
    "full body + wrong pose does NOT falsely pass (still on Pose 1)",
    await page.isVisible("text=Pose 1 of 3")
  );
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click()); // raw click avoids Playwright post-click nav-wait hang

  // ── Pass-validity: a legless (waist-up) checkpoint must never pass, even
  // with a full-body webcam scoring it high on the upper joints ──
  await buildUploadedMove(page, DANCE_WAISTUP, 2, "Waistup Move");
  await page.click("text=Waistup Move");
  await page.click('button:has-text("Practice this move")');
  if (
    await page
      .waitForSelector("text=Warm up first", { timeout: 2000 })
      .then(() => true)
      .catch(() => false)
  )
    await page.click("text=Skip for now");
  await page.waitForSelector("text=Pose 1 of 2");
  // Sample the score for a few seconds; the upper body matches so it can read
  // high, but with no lower-body joints shared the pass must never fire.
  let maxSeen = -1;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(280);
    const t = await liveScore(page);
    if (/^\d{1,3}$/.test(t)) maxSeen = Math.max(maxSeen, parseInt(t, 10));
    if (await page.isVisible("text=Overall score")) break;
  }
  check(
    `legless checkpoint does NOT auto-pass with full body (peak score seen=${maxSeen}, still pre-result)`,
    !(await page.isVisible("text=Overall score"))
  );
  // Skip remains available so the user is never stuck.
  for (let i = 0; i < 2; i++) {
    await page.click('button:has-text("Skip / Next")', { force: true });
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("text=Overall score");
  check("legless move still reaches RESULT via Skip", true);
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click()); // raw click avoids Playwright post-click nav-wait hang

  // ── Longer session: a 6-checkpoint move runs end to end (Pose X of 6) ──
  // Built from the waist-up (legless) clip so it never auto-passes — lets us
  // step through all 6 deterministically with Skip and read every label.
  await buildUploadedMove(page, DANCE_WAISTUP, 6, "Six Move");
  await page.click("text=Six Move");
  await page.click('button:has-text("Practice this move")');
  if (
    await page
      .waitForSelector("text=Warm up first", { timeout: 2000 })
      .then(() => true)
      .catch(() => false)
  )
    await page.click("text=Skip for now");
  // Legless checkpoints never auto-pass → step through all 6 with Skip and
  // confirm each "Pose i of 6" label appears in order.
  let countsOk = true;
  for (let i = 1; i <= 6; i++) {
    const ok = await page
      .waitForSelector(`text=Pose ${i} of 6`, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    countsOk = countsOk && ok;
    // Raw DOM click — avoids Playwright's flaky post-click "wait for scheduled
    // navigations" hang when this SPA button re-renders the view.
    await page
      .locator('button:has-text("Skip / Next")')
      .first()
      .evaluate((el) => el.click())
      .catch(() => {});
    await page.waitForTimeout(350);
  }
  check("6-checkpoint move: 'Pose X of 6' correct for all 6 (count generalizes beyond 3)", countsOk);
  await page.waitForSelector("text=Overall score");
  const sixRows = await page.locator("text=/^\\d+\\.\\s/").count();
  check(`6-checkpoint move reaches RESULT with 6 breakdown rows (${sixRows})`, sixRows === 6);
  await page.locator('button:has-text("Back to Moves")').first().evaluate((el) => el.click()); // raw click avoids Playwright post-click nav-wait hang

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
  await deniedCtx.addInitScript(YT_FAKE);
  const p2 = await deniedCtx.newPage();
  await p2.goto("http://localhost:3000/");
  await p2.fill('input[placeholder="Username"]', "demo");
  await p2.fill('input[placeholder="Password"]', "demo1234");
  await p2.click('button:has-text("Log in")');
  await p2.waitForSelector("text=Pick a move to practice");
  // Drew Test is a no-video move → straight to self-paced practice; the webcam
  // mounts immediately, so the (stubbed) denial surfaces the recovery overlay.
  await p2.click("text=Drew Test");
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

  // ── Full-body presence gate (needs a different fake-camera file, so its own
  // browser). A helper logs in as demo and enters self-paced practice on the
  // no-video Drew Test move (straight to scoring, no split-screen/Start).
  async function enterPractice(args) {
    const fb = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        ...args,
      ],
    });
    const pg = await (
      await fb.newContext({ permissions: ["camera"], reducedMotion: "reduce" })
    ).newPage();
    await pg.goto("http://localhost:3000/");
    await pg.fill('input[placeholder="Username"]', "demo");
    await pg.fill('input[placeholder="Password"]', "demo1234");
    await pg.click('button:has-text("Log in")');
    await pg.waitForSelector("text=Pick a move to practice");
    await pg.click("text=Drew Test");
    if (
      await pg
        .waitForSelector("text=Warm up first", { timeout: 3000 })
        .then(() => true)
        .catch(() => false)
    )
      await pg.click("text=Skip for now");
    await pg.waitForSelector("text=Pose 1 of 3");
    return { fb, pg };
  }

  // Start gate: upper-body-only webcam → never scores, prompt shown.
  {
    const { fb, pg } = await enterPractice([
      `--use-file-for-fake-video-capture=${WEBCAM_UPPER}`,
    ]);
    const states = new Set();
    let sawNumber = false;
    for (let i = 0; i < 16; i++) {
      await pg.waitForTimeout(280);
      const t = await liveScore(pg);
      if (t) states.add(t.slice(0, 10));
      if (/^\d{1,3}$/.test(t)) sawNumber = true;
    }
    await pg.screenshot({ path: "shot_fullbody_gate.png" });
    check(
      "upper-body-only: scoring never starts (step-back prompt, no number)",
      [...states].some((s) => s.includes("Step back")) && !sawNumber
    );
    check(
      "upper-body-only: no auto-advance (still Pose 1 of 3)",
      await pg.isVisible("text=Pose 1 of 3")
    );
    await fb.close();
  }

  // During session: legs leave then return → pause then resume.
  {
    const { fb, pg } = await enterPractice([
      `--use-file-for-fake-video-capture=${WEBCAM_LEGSOUT}`,
    ]);
    let sawPrompt = false;
    let sawScoreState = false; // a number OR "Get into frame" = gate open
    for (let i = 0; i < 40; i++) {
      await pg.waitForTimeout(250);
      const t = await liveScore(pg);
      if (t.includes("Step back")) sawPrompt = true;
      else if (/^\d{1,3}$/.test(t) || t.includes("Get into frame"))
        sawScoreState = true;
    }
    check(
      "legs leave mid-session → pause (step-back prompt appears)",
      sawPrompt
    );
    check(
      "legs return → resume (gate re-opens to a scoring state)",
      sawScoreState
    );
    await fb.close();
  }

  // ── /author capture guidance enforces the checklist's quality bar ──
  async function openAuthor(y4mFile) {
    const ab = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${y4mFile}`,
      ],
    });
    const ap = await (
      await ab.newContext({ permissions: ["camera"], reducedMotion: "reduce" })
    ).newPage();
    await ap.goto("http://localhost:3000/author");
    await ap.waitForFunction(
      () => {
        const t = document.body.innerText;
        return !t.includes("Loading model…") && !t.includes("Error:");
      },
      null,
      { timeout: 120000 }
    );
    await ap.waitForTimeout(2500); // let a few frames run
    return { ab, ap };
  }
  const promptOpacity = (pg) =>
    pg
      .getByTestId("fullbody-prompt")
      .evaluate((el) => getComputedStyle(el).opacity)
      .catch(() => "?");

  // Full-body webcam: no prompt; capture succeeds, leg-driven, with thumbnail.
  {
    const { ab, ap } = await openAuthor(Y4M);
    check(
      "author: full body → no step-back prompt",
      (await promptOpacity(ap)) === "0"
    );
    await ap.locator('button:has-text("Add Checkpoint")').first().evaluate((el) => el.click()); // raw click avoids post-click nav-wait hang
    await ap.waitForTimeout(500);
    check(
      "author: full-body capture succeeds (1 checkpoint)",
      (await ap.locator('input[value^="Pose"]').count()) === 1
    );
    check(
      "author: checkpoint flagged leg-driven",
      await ap.isVisible("text=✓ leg-driven")
    );
    check(
      "author: checkpoint has a skeleton thumbnail",
      (await ap.locator("img[alt^='Pose']").count()) === 1
    );
    // Capturing the same pose again warns about similarity.
    await ap.locator('button:has-text("Add Checkpoint")').first().evaluate((el) => el.click()); // raw click avoids post-click nav-wait hang
    await ap.waitForTimeout(500);
    check(
      "author: near-identical second pose warns 'very similar'",
      await ap.isVisible("text=very similar to the previous pose")
    );

    // 5s self-timer. Click the timer button by its stable testid (it's a
    // toggle: arms when idle, cancels when running) with a raw DOM click so a
    // single synchronous toggleTimer() runs — no dependence on the button's
    // (re-render-lagged) label, and no retry that could re-arm.
    const cpCount = () => ap.locator('input[value^="Pose"]').count();
    const clickTimer = () =>
      ap.getByTestId("timer-btn").evaluate((el) => el.click());

    // Cancel captures nothing — bulletproof: arm then cancel in ONE synchronous
    // task (two clicks, no await between), so the interval is created and
    // cleared in the same tick and can never fire. (Avoids racing the 5s timer
    // against test latency under heavy inference load.)
    const beforeCancel = await cpCount();
    await ap.getByTestId("timer-btn").evaluate((el) => {
      el.click(); // arm
      el.click(); // cancel
    });
    await ap.waitForTimeout(7000); // past a full fresh 5s window
    check(
      "author timer: cancel mid-countdown captures nothing + overlay gone",
      !(await ap.getByTestId("timer-countdown").isVisible()) &&
        (await cpCount()) === beforeCancel
    );

    // Re-arm and let it run to 0 → captures via the same path. Confirms the
    // countdown overlay appears while armed, then the capture lands (the
    // countdown can run slow under CPU load, so poll for the capture).
    const beforeTimed = await cpCount();
    await clickTimer();
    check(
      "author timer: countdown overlay shows while armed",
      await ap
        .waitForSelector('[data-testid="timer-countdown"]', { timeout: 8000 })
        .then(() => true)
        .catch(() => false)
    );
    const timedCaptured = await ap
      .waitForFunction(
        (n) =>
          document.querySelectorAll('input[value^="Pose"]').length === n + 1,
        beforeTimed,
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
    check("author timer: reaches 0 and captures a checkpoint (same path)", timedCaptured);
    await ap.screenshot({ path: "shot_author.png" });
    await ab.close();
  }

  // Upper-body webcam: prompt shown; capture refused (legs not in frame).
  {
    const { ab, ap } = await openAuthor(WEBCAM_UPPER);
    check(
      "author: legs out of frame → step-back prompt visible",
      (await promptOpacity(ap)) === "1"
    );
    await ap.locator('button:has-text("Add Checkpoint")').first().evaluate((el) => el.click()); // raw click avoids post-click nav-wait hang
    await ap.waitForTimeout(400);
    check(
      "author: capture refused when legs aren't in frame",
      (await ap.locator('input[value^="Pose"]').count()) === 0 &&
        (await ap.isVisible("text=Legs aren’t fully in frame"))
    );
    // The 5s timer at 0 applies the SAME refusal — saves nothing. Wait for the
    // refusal note to (re)appear, allowing for slow countdown under load.
    await ap.getByTestId("timer-btn").evaluate((el) => el.click());
    const refusedAtZero = await ap
      .waitForFunction(
        () =>
          document.body.innerText.includes("Legs aren’t fully in frame") &&
          document.querySelectorAll('input[value^="Pose"]').length === 0 &&
          !document.querySelector('[data-testid="timer-countdown"]'),
        null,
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false);
    check(
      "author timer: refuses at 0 when legs aren't in frame (nothing saved)",
      refusedAtZero
    );
    await ab.close();
  }

  // ── Pass-through scoring: score while MOVING (no freeze-and-hold) ──
  // A warrior move practiced against a webcam where the matching pose appears
  // only briefly (well under the old 800ms hold). Brief match → passes;
  // sub-window blip → never passes.
  async function warriorPracticeWith(y4mFile) {
    const wb = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${y4mFile}`,
      ],
    });
    const wp = await (
      await wb.newContext({ permissions: ["camera"], reducedMotion: "reduce" })
    ).newPage();
    await wp.goto("http://localhost:3000/");
    await wp.fill('input[placeholder="Username"]', "demo");
    await wp.fill('input[placeholder="Password"]', "demo1234");
    await wp.click('button:has-text("Log in")');
    await wp.waitForSelector("text=Pick a move to practice");
    // Build a 2-checkpoint full-body warrior move from DANCE.
    await wp.click("text=⬆ Upload a dance");
    await wp.waitForSelector("text=Choose a video file");
    await wp.setInputFiles('input[type="file"]', DANCE);
    await wp.waitForSelector("text=Capture this frame", { timeout: 180000 });
    while ((await wp.locator('button:has-text("✕ Remove")').count()) > 0)
      await wp.locator('button:has-text("✕ Remove")').first().click();
    for (let i = 0; i < 2; i++) {
      const before = await wp
        .locator('input[aria-label="Checkpoint name"]')
        .count();
      await wp.locator("video").evaluate(
        (v, f) =>
          new Promise((res) => {
            v.pause();
            v.addEventListener("seeked", () => res(), { once: true });
            v.currentTime = v.duration * f;
          }),
        (i + 0.5) / 2
      );
      await wp.click('button:has-text("Capture this frame")');
      await wp.waitForFunction(
        (k) =>
          document.querySelectorAll('input[aria-label="Checkpoint name"]')
            .length === k + 1,
        before,
        { timeout: 30000 }
      );
    }
    await wp.fill('input[placeholder^="Move name"]', "Flow Move");
    await wp.click('button:has-text("Save move")');
    await wp.waitForSelector('button.moveCard:has-text("Flow Move")');
    await wp.click("text=Flow Move");
    await wp.click('button:has-text("Practice this move")');
    if (
      await wp
        .waitForSelector("text=Warm up first", { timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      await wp.click("text=Skip for now");
    await wp.waitForSelector("text=Pose 1 of 2");
    return { wb, wp };
  }

  {
    const { wb, wp } = await warriorPracticeWith(WEBCAM_PASSTHROUGH);
    // The pose is in frame only ~0.5s at a time — old freeze-and-hold (800ms)
    // could never pass it; pass-through must.
    const advanced = await wp
      .waitForFunction(
        () => !document.body.innerText.includes("Pose 1 of 2"),
        null,
        { timeout: 60000 }
      )
      .then(() => true)
      .catch(() => false);
    check("pass-through: brief match while MOVING passes a checkpoint (no freeze)", advanced);
    await wb.close();
  }

  {
    const { wb, wp } = await warriorPracticeWith(WEBCAM_BLIP);
    // The pose flashes for only ~0.1s (below the pass window) — a noise-spike
    // analogue. It must never pass.
    await wp.waitForTimeout(9000);
    check(
      "pass-through: sub-window blip (single-frame spike) does NOT false-pass",
      (await wp.isVisible("text=Pose 1 of 2")) &&
        !(await wp.isVisible("text=Overall score"))
    );
    await wb.close();
  }

  // ── Synced (dance-along) mode ──
  // Reuses the top-level fake window.YT (controllable getCurrentTime +
  // __ytFire). Build a qualifying move via upload (youtubeId + timestamped
  // checkpoints from dance.mp4) and drive video time through the windows.
  // Build a synced move (upload dance.mp4 + youtubeId, capturing at fixed times
  // 1.0s and 3.0s so the checkpoint t values are known) and open it.
  async function openSynced(y4mFile) {
    const sb = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${y4mFile}`,
      ],
    });
    const ctx = await sb.newContext({
      permissions: ["camera"],
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(YT_FAKE);
    const sp = await ctx.newPage();
    await sp.goto("http://localhost:3000/");
    await sp.fill('input[placeholder="Username"]', "demo");
    await sp.fill('input[placeholder="Password"]', "demo1234");
    await sp.click('button:has-text("Log in")');
    await sp.waitForSelector("text=Pick a move to practice");
    await sp.click("text=⬆ Upload a dance");
    await sp.waitForSelector("text=Choose a video file");
    await sp.setInputFiles('input[type="file"]', DANCE);
    await sp.waitForSelector("text=Capture this frame", { timeout: 180000 });
    while ((await sp.locator('button:has-text("✕ Remove")').count()) > 0)
      await sp.locator('button:has-text("✕ Remove")').first().click();
    for (const at of [1.0, 3.0]) {
      const before = await sp
        .locator('input[aria-label="Checkpoint name"]')
        .count();
      await sp.locator("video").evaluate(
        (v, t) =>
          new Promise((res) => {
            v.pause();
            v.addEventListener("seeked", () => res(), { once: true });
            v.currentTime = t;
          }),
        at
      );
      await sp.click('button:has-text("Capture this frame")');
      await sp.waitForFunction(
        (k) =>
          document.querySelectorAll('input[aria-label="Checkpoint name"]')
            .length === k + 1,
        before,
        { timeout: 30000 }
      );
    }
    await sp.fill('input[placeholder^="Move name"]', "Synced Move");
    await sp.fill('input[placeholder^="YouTube"]', "dQw4w9WgXcQ");
    await sp.click('button:has-text("Save move")');
    await sp.waitForSelector('button.moveCard:has-text("Synced Move")');
    await sp.click("text=Synced Move");
    if (
      await sp
        .waitForSelector("text=Warm up first", { timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      await sp.click("text=Skip for now");
    // Synced mode (no standalone Watch step).
    await sp.waitForSelector('[data-testid="synced-practice"]', { timeout: 15000 });
    return { sb, sp };
  }

  {
    const { sb, sp } = await openSynced(Y4M); // full-body warrior webcam
    check(
      "synced: qualifying move opens dance-along (video on top + webcam)",
      (await sp.isVisible('[data-testid="synced-practice"]')) &&
        (await sp.getByTestId("live-score").count()) === 1
    );
    check(
      "synced: no result before it starts",
      !(await sp.isVisible("text=Overall score"))
    );
    // Auto-start: full body held in frame → countdown → run (no click).
    const syncedAutoStarted = await sp
      .waitForFunction(
        () =>
          document
            .querySelector('[data-testid="synced-practice"]')
            ?.getAttribute("data-phase") === "running",
        null,
        { timeout: 20000 }
      )
      .then(() => true)
      .catch(() => false);
    check("synced: AUTO-STARTS when full body in frame (no click)", syncedAutoStarted);

    // Pause pauses scoring.
    await sp.evaluate(() => {
      window.__ytTime = 1.0;
      window.__ytFire(window.YT.PlayerState.PAUSED);
    });
    await sp.waitForTimeout(1200);
    check(
      "synced: pausing the video pauses scoring (chip shows Paused)",
      (await sp.getByTestId("live-score").innerText()).includes("Paused")
    );
    await sp.evaluate(() => window.__ytFire(window.YT.PlayerState.PLAYING));

    // Drive the timeline through each checkpoint window; warrior webcam matches
    // the warrior checkpoints, so each should pass as the video reaches it.
    await sp.evaluate(() => (window.__ytTime = 1.0)); // checkpoint 0 window
    await sp.waitForTimeout(3000);
    await sp.evaluate(() => (window.__ytTime = 3.0)); // checkpoint 1 window
    await sp.waitForTimeout(3000);
    await sp.evaluate(() => (window.__ytTime = 4.2)); // past last window → finish
    const reachedResult = await sp
      .waitForSelector("text=Overall score", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check("synced: scored as it plays, reaches RESULT at the end", reachedResult);
    const overall = await sp
      .locator("text=Overall score")
      .locator("xpath=following-sibling::div[1]")
      .innerText()
      .catch(() => "?");
    check(
      `synced: warrior matched the checkpoints → high overall ("${overall}")`,
      /^\d{1,3}$/.test(overall.trim()) && parseInt(overall, 10) >= 70
    );
    await sp.screenshot({ path: "shot_synced.png" });
    await sb.close();
  }

  {
    // Legs out of frame (upper body only): the full-body gate prevents
    // auto-start — it never accumulates a stable full body, so it never leaves
    // prestart (always showing the step-back prompt) and never starts. This is
    // the exact `!hasFullBody` revert path a mid-countdown cancel reuses: lose
    // the full body and it falls straight back to this prompt.
    const { sb, sp } = await openSynced(WEBCAM_UPPER);
    let everLeftPrestart = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const phase = await sp
        .getByTestId("synced-practice")
        .getAttribute("data-phase")
        .catch(() => null);
      if (phase !== "prestart" && phase !== "loading") everLeftPrestart = true;
      await sp.waitForTimeout(250);
    }
    check(
      "auto-start: legs out of frame → never starts; holds the step-back prompt",
      !everLeftPrestart &&
        !(await sp.isVisible("text=Overall score")) &&
        (await sp.getByTestId("live-score").innerText()).includes("Step back")
    );
    await sb.close();
  }

  // ── Movement mode (score your OWN whole-body movement) ──
  // The Houdini song starter has a youtubeId and NO checkpoints, so it runs the
  // separate movement-scoring path: video plays as background, the webcam
  // scores movement, region indicators light up, RESULT shows a per-region
  // breakdown. (Magnitude assertions — still≈0, upper<full — are the manual
  // acceptance; here we lock the path/layout/finish/result/save are wired.)
  async function openMovement(y4mFile) {
    const mb = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-video-capture=${y4mFile}`,
      ],
    });
    const ctx = await mb.newContext({
      permissions: ["camera"],
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(YT_FAKE);
    const mp = await ctx.newPage();
    await mp.goto("http://localhost:3000/");
    await mp.fill('input[placeholder="Username"]', "demo");
    await mp.fill('input[placeholder="Password"]', "demo1234");
    await mp.click('button:has-text("Log in")');
    await mp.waitForSelector("text=Pick a move to practice");
    await mp.click("text=Houdini"); // movement-mode starter (no checkpoints)
    if (
      await mp
        .waitForSelector("text=Warm up first", { timeout: 2500 })
        .then(() => true)
        .catch(() => false)
    )
      await mp.click("text=Skip for now");
    await mp.waitForSelector('[data-testid="movement-practice"]', { timeout: 15000 });
    return { mb, mp };
  }

  {
    const { mb, mp } = await openMovement(Y4M); // full-body warrior webcam
    check(
      "movement: checkpoint-less YouTube move opens movement mode (video + webcam)",
      (await mp.isVisible('[data-testid="movement-practice"]')) &&
        (await mp.getByTestId("movement-score").count()) === 1
    );
    check(
      "movement: four region indicators present (head/arms/torso/legs)",
      (await mp.getByTestId("region-head").count()) === 1 &&
        (await mp.getByTestId("region-arms").count()) === 1 &&
        (await mp.getByTestId("region-torso").count()) === 1 &&
        (await mp.getByTestId("region-legs").count()) === 1
    );
    check(
      "movement: no result before it starts",
      !(await mp
        .getByTestId("movement-result-message")
        .isVisible()
        .catch(() => false))
    );
    const moveStarted = await mp
      .waitForFunction(
        () =>
          document
            .querySelector('[data-testid="movement-practice"]')
            ?.getAttribute("data-phase") === "running",
        null,
        { timeout: 20000 }
      )
      .then(() => true)
      .catch(() => false);
    check("movement: AUTO-STARTS when full body in frame (no click)", moveStarted);
    // Let it score a couple seconds, then end via the Finish button.
    await mp.waitForTimeout(2500);
    await mp.getByTestId("movement-finish").evaluate((el) => el.click());
    const reachedResult = await mp
      .waitForSelector('[data-testid="movement-result-message"]', {
        timeout: 10000,
      })
      .then(() => true)
      .catch(() => false);
    check(
      "movement: Finish → RESULT with an encouraging message (no bare score)",
      reachedResult
    );
    const closingMv = await mp
      .getByTestId("movement-result-message")
      .innerText()
      .catch(() => "");
    check(
      `movement: result headline is an encouraging message ("${closingMv.trim()}")`,
      /crushed it|great moves|warm-?up/i.test(closingMv)
    );
    check(
      "movement: per-region breakdown shown (Head/Arms/Torso/Legs)",
      (await mp.isVisible("text=Head")) &&
        (await mp.isVisible("text=Arms")) &&
        (await mp.isVisible("text=Torso")) &&
        (await mp.isVisible("text=Legs"))
    );
    const savedMv = await mp
      .waitForSelector("text=Attempt saved", { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    check("movement: attempt saved to backend (region breakdown)", savedMv);
    await mp.screenshot({ path: "shot_movement.png" });
    await mb.close();
  }

  await browser.close();
  console.log(
    "Screenshots: shot_login.png, shot_upload_review.png, shot_practice.png, shot_dashboard.png, shot_camera_denied.png, shot_author.png, shot_synced.png, shot_movement.png"
  );
  console.log(failures === 0 ? "\nALL E2E CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})();
