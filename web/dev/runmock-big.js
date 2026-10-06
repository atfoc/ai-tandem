// Read by runmock.mjs when BIG=1 (evaluated inside it): adds r_big, a running run of about 300 tasks and 100 turns, made of copies of r_live's detail.
(() => {
  const src = runs.r_live.detail, span = Date.now() - src.startedAt + 60000;
  const TC = 7, C = 9, nT = src.turns.length, nK = src.tasks.length;
  const d = { run: "r_big", version: 1, status: "running", startedAt: src.startedAt - (TC - 1) * span, goalSize: src.goalSize, git: clone(src.git), stops: [], turns: [], tasks: [], chatOps: [], agents: {}, notes: [] };
  const tid = (id, c) => "T" + String(Number(id.slice(1)) + nK * c).padStart(3, "0");
  const aid = (id, c) => id.replace("a_live_", "a_big_") + "~" + c;
  for (let tc = 0; tc < TC; tc++) {
    const by = -(TC - 1 - tc) * span, lastCopy = tc === TC - 1;
    for (const t0 of src.turns) {
      const t = shift(clone(t0), by); t.n = t0.n + nT * tc; t.agent = aid(t0.agent, "t" + tc);
      for (const o of t.ops) { o.t ??= t.startedAt; if (o.task) o.task = tid(o.task, tc); if (o.dependsOn) o.dependsOn = o.dependsOn.map((x) => tid(x, tc)); if (o.needsReport) o.needsReport = o.needsReport.map((x) => tid(x, tc)); if (o.tasks) o.tasks = o.tasks.map((x) => tid(x, tc)); if (o.notesVersion) o.notesVersion += src.notes.length * tc; }
      for (const e of [...t.wokenBy, ...t.learned]) if (e.task) e.task = tid(e.task, tc);
      if (t.wait) t.wait = { ...t.wait, tasks: t.wait.tasks.map((x) => tid(x, tc)), turn: t.wait.turn + nT * tc };
      if (!lastCopy && t.status === "running") { t.status = "done"; t.endedAt = t.startedAt + 60000; t.cost = 0.4; t.summary = "Done."; }
      d.turns.push(t);
      const a = shift(clone(src.agents[t0.agent]), by); a.id = t.agent; a.turn = t.n; a.name = "turn-" + String(t.n).padStart(3, "0");
      if (!lastCopy && a.status === "running") { a.status = "done"; a.endedAt = t.endedAt; a.launches.at(-1).endedAt = t.endedAt; a.cost = 0.4; delete a.activity; }
      d.agents[a.id] = a;
    }
    for (const n0 of src.notes) { const n = shift(clone(n0), by); n.v = n0.v + src.notes.length * tc; if (n.turn) n.turn += nT * tc; d.notes.push(n); }
  }
  for (let c = 0; c < C; c++) {
    const tc = c % TC, by = -(TC - 1 - tc) * span, live = c === TC - 1;
    for (const k0 of src.tasks) {
      const k = shift(clone(k0), by); k.id = tid(k0.id, c); k.dependsOn = k.dependsOn.map((x) => tid(x, c)); k.needsReport = k.needsReport.map((x) => tid(x, c)); k.addedTurn += nT * tc; k.changedTurns = k.changedTurns.map((n) => n + nT * tc);
      for (const b of k.briefs) if (b.turn) b.turn += nT * tc;
      for (const a of k.attempts) {
        a.queuedTurn += nT * tc;
        for (const p of a.phases) { if (p.on) p.on = p.on.map((x) => tid(x, c)); if (p.turn) p.turn += nT * tc; }
        for (const w of ["work", "merge"]) if (a.agents[w]) {
          const g = shift(clone(src.agents[a.agents[w]]), by); g.id = aid(a.agents[w], c); g.task = k.id; g.name = g.name.replace(k0.id, k.id);
          if (!live && g.status === "running") { g.status = "done"; g.endedAt = g.startedAt + 600000; g.launches.at(-1).endedAt = g.endedAt; g.cost = 1; delete g.activity; }
          d.agents[g.id] = g; a.agents[w] = g.id;
        }
        if (!live && !a.outcome) { if (!a.startedAt) { a.startedAt = a.queuedAt + 1000; a.phases.push({ k: "work", t: a.startedAt }); } a.outcome = "done"; a.endedAt = a.startedAt + 600000; a.cost = 1; a.result = { outcome: "completed", summary: "Done as briefed.", reportSize: 3000 }; }
      }
      d.tasks.push(k);
    }
  }
  d.tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  d.tasks = d.tasks.slice(0, 300); d.turns = d.turns.slice(0, 100);
  // one working task with 10 attempts (nine failed before), one with a title of 200 characters
  const open = d.tasks.filter((t) => { const a = t.attempts.at(-1); return !a.outcome && a.phases.at(-1).k === "work" && a.agents.work; });
  const ten = open[0], long = open[1] ?? open[0];
  if (ten) {
    const cur = ten.attempts.at(-1), g0 = d.agents[cur.agents.work], olds = [];
    for (let n = 1; n <= 9; n++) {
      const back = (10 - n) * 20 * 60000, a = shift(clone(cur), -back); a.n = n; a.outcome = "failed"; a.endedAt = a.startedAt + 15 * 60000; a.error = `attempt ${n} failed: the tests fail on the integration branch (exit status 1)`; a.cost = 1.2 + n / 10;
      const g = shift(clone(g0), -back); g.id = g0.id + "-a" + n; g.name = g0.name.replace("-work", `-a${n}-work`); g.attempt = n; g.status = "failed"; g.endedAt = a.endedAt; g.error = a.error; g.cost = a.cost; delete g.activity;
      g.launches = [0, 1, 2].map((i) => ({ n: i + 1, startedAt: a.startedAt + i * 5 * 60000, endedAt: a.startedAt + (i + 1) * 5 * 60000, resume: i > 0, error: "the agent's process exited (code 1)" }));
      a.agents = { work: g.id }; d.agents[g.id] = g; olds.push(a);
    }
    cur.n = 10; g0.attempt = 10; ten.attempts = [...olds, cur];
  }
  if (long) long.title = "Make the context split of a never-messaged Claude fork work without a process, and while there also check that the fork banner, the tree popup, the quote references and the model pickers keep their state — 200 chars!".slice(0, 200);
  const name = "Verify, review, debug and fix everything the last few commits added to chat forking, push delivery of subagent results, the model pickers and quote references, and keep every test suite green while doing so!!".slice(0, 200);
  const R = addRun({ id: "r_big", name, userNamed: true, created: iso(d.startedAt), settings: { ...DEFAULT_SETTINGS, maxTurns: 200, maxParallel: 8 } }, d, GOAL_QA);
  R.eng.off = true; R.tag = "big";
  R.sent = JSON.stringify(view(R));
  globalThis.BIG = { ten: ten?.id, long: long?.id, tasks: d.tasks.length, turns: d.turns.length, agents: Object.keys(d.agents).length, bytes: JSON.stringify(d).length };
  /** One run_detail event that changes one task (and its agent). */
  globalThis.touch = (run, id) => { const R = runs[run], d = R.detail, t = d.tasks.find((x) => x.id === id) ?? d.tasks.findLast((x) => !x.attempts.at(-1).outcome); const a = t.attempts.at(-1), g = d.agents[a.agents.work ?? ""];
    t.title = t.title.endsWith(" ·") ? t.title.slice(0, -2) : t.title + " ·";
    const p = { tasks: [t] }; if (g) { g.tools = (g.tools ?? 0) + 1; p.agents = { [g.id]: g }; }
    commit(R, p); return t.id; };
  return BIG;
})()
