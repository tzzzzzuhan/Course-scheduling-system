import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const seed = JSON.parse(readFileSync(path.join(ROOT, "data/seed.json")));
export function createStore(file = ":memory:") {
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const initial = {
    requests: [],
    notifications: [],
    audit: [],
    enrollments: [],
    review: {},
  };
  if (!db.prepare("SELECT key FROM kv WHERE key=?").get("state"))
    db.prepare("INSERT INTO kv VALUES (?,?)").run(
      "state",
      JSON.stringify(initial),
    );
  const subscribers = new Set();
  return {
    read: () =>
      JSON.parse(
        db.prepare("SELECT value FROM kv WHERE key=?").get("state").value,
      ),
    write: (s) => {
      db.prepare("UPDATE kv SET value=? WHERE key=?").run(
        JSON.stringify(s),
        "state",
      );
      for (const notify of subscribers) notify();
    },
    subscribe: (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    close: () => {
      subscribers.clear();
      db.close();
    },
  };
}
const assert = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { status: 400 });
};
export function validWeek(week) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(week || ""), "日期格式錯誤");
  const d = new Date(week + "T00:00:00Z");
  assert(
    !Number.isNaN(+d) &&
      d.toISOString().slice(0, 10) === week &&
      d.getUTCDay() === 1,
    "請選擇週一作為週次",
  );
  assert(week >= seed.start && week <= seed.end, "日期超出本學期範圍");
}
export function schedule(state, week) {
  const lessons = seed.lessons.map((l) => ({
    ...l,
    ...state.review[l.id],
    teachers: [...l.teachers],
  }));
  for (const r of state.requests.filter(
    (r) => r.status === "approved" && r.week === week,
  ))
    for (const c of r.changes) {
      const l = lessons.find((l) => l.id === c.id);
      Object.assign(l, c, {
        changeType: r.type,
        requestId: r.id,
        original: seed.lessons.find((x) => x.id === c.id),
      });
    }
  return lessons;
}
export function conflicts(state, week, changes, exclude = null) {
  const current = schedule(
    { ...state, requests: state.requests.filter((r) => r.id !== exclude) },
    week,
  );
  const result = current.map((l) => ({
    ...l,
    ...changes.find((c) => c.id === l.id),
  }));
  const issues = [];
  const affected = new Set(changes.map((x) => x.id));
  for (let i = 0; i < result.length; i++)
    for (let j = i + 1; j < result.length; j++) {
      const a = result[i],
        b = result[j];
      if (
        (!affected.has(a.id) && !affected.has(b.id)) ||
        a.day !== b.day ||
        a.period !== b.period
      )
        continue;
      const t = a.teachers.filter((t) => b.teachers.includes(t));
      if (t.length)
        issues.push(`${t.join("、")}老師與「${b.name}／${a.name}」衝堂`);
      if (a.room === b.room)
        issues.push(
          `${a.room} 教室在週${"一二三四五"[a.day]}第 ${a.period} 節已有「${a.name}／${b.name}」`,
        );
      for (const e of state.enrollments)
        if (e.lessonIds.includes(a.id) && e.lessonIds.includes(b.id))
          issues.push(`${e.name} 的選課「${a.name}／${b.name}」衝堂`);
    }
  return [...new Set(issues)];
}
export function makeRequest(state, b) {
  validWeek(b.week);
  assert(["substitute", "move", "swap"].includes(b.type), "異動類型錯誤");
  assert(
    typeof b.reason === "string" &&
      b.reason.trim().length >= 2 &&
      b.reason.length <= 500,
    "請填寫 2–500 字申請原因",
  );
  const all = schedule(state, b.week),
    l = all.find((l) => l.id === b.lessonId);
  assert(l, "找不到課程");
  const occurrence = new Date(b.week + "T00:00:00Z");
  occurrence.setUTCDate(occurrence.getUTCDate() + l.day);
  assert(
    occurrence.toISOString().slice(0, 10) <= seed.end,
    "該堂課日期超出學期範圍",
  );
  assert(
    !state.requests.some(
      (r) =>
        r.week === b.week &&
        ["pending", "approved"].includes(r.status) &&
        r.changes.some((c) => c.id === l.id),
    ),
    "此堂課已有有效或待審申請，請先撤銷",
  );
  let changes;
  if (b.type === "substitute") {
    assert(seed.teachers.includes(b.teacher), "請選擇已登錄老師");
    assert(!l.teachers.includes(b.teacher), "代課老師不可與原授課老師相同");
    assert(l.teachers.includes(b.replacedTeacher), "請選擇要被代課的老師");
    changes = [
      {
        id: l.id,
        teachers: l.teachers.map((t) =>
          t === b.replacedTeacher ? b.teacher : t,
        ),
      },
    ];
  } else if (b.type === "move") {
    assert(
      Number.isInteger(b.day) &&
        b.day >= 0 &&
        b.day <= 4 &&
        Number.isInteger(b.period) &&
        b.period >= 1 &&
        b.period <= 8,
      "時段無效",
    );
    assert(
      seed.lessons.some((l) => l.room === b.room),
      "教室無效",
    );
    assert(
      l.day !== b.day || l.period !== b.period || l.room !== b.room,
      "請選擇不同的時間或教室",
    );
    changes = [{ id: l.id, day: b.day, period: b.period, room: b.room }];
  } else {
    const other = all.find((x) => x.id === b.otherId);
    assert(other && other.id !== l.id, "請選擇另一堂課");
    assert(
      l.day !== other.day || l.period !== other.period,
      "兩堂課已在同一時段",
    );
    assert(
      !state.requests.some(
        (r) =>
          r.week === b.week &&
          ["pending", "approved"].includes(r.status) &&
          r.changes.some((c) => c.id === other.id),
      ),
      "交換課程已有申請",
    );
    changes = [
      { id: l.id, day: other.day, period: other.period },
      { id: other.id, day: l.day, period: l.period },
    ];
  }
  for (const c of changes) {
    const target = { ...all.find((l) => l.id === c.id), ...c };
    const d = new Date(b.week + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + target.day);
    assert(d.toISOString().slice(0, 10) <= seed.end, "調整後日期超出學期範圍");
  }
  const issues = conflicts(state, b.week, changes);
  assert(!issues.length, issues.join("；"));
  return {
    id: crypto.randomUUID(),
    week: b.week,
    type: b.type,
    lessonId: l.id,
    changes,
    reason: b.reason.trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}
function audit(state, event, detail) {
  state.audit.unshift({
    id: crypto.randomUUID(),
    event,
    detail,
    at: new Date().toISOString(),
  });
}
export function createApp(store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        const unsubscribe = store.subscribe(() =>
          res.write("data: updated\n\n"),
        );
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          25000,
        );
        req.on("close", () => {
          unsubscribe();
          clearInterval(heartbeat);
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        let b = {};
        if (req.method !== "GET") {
          assert(
            req.headers["content-type"]?.startsWith("application/json"),
            "需要 JSON",
          );
          assert(
            !req.headers.origin ||
              req.headers.origin === `http://${req.headers.host}` ||
              req.headers.origin === `https://${req.headers.host}`,
            "來源不允許",
          );
          let body = "";
          for await (const c of req) {
            body += c;
            assert(body.length < 50000, "請求過大");
          }
          b = JSON.parse(body || "{}");
        }
        const state = store.read();
        if (req.method === "GET" && url.pathname === "/api/state") {
          const week = url.searchParams.get("week") || "2026-10-19";
          validWeek(week);
          return send(200, {
            ...seed,
            ...state,
            lessons: schedule(state, week),
            week,
            demo: true,
          });
        }
        if (req.method === "POST" && url.pathname === "/api/requests") {
          const r = makeRequest(state, b);
          state.requests.unshift(r);
          audit(state, "送出申請", r.id);
          store.write(state);
          return send(201, r);
        }
        if (req.method === "POST" && url.pathname === "/api/decision") {
          const r = state.requests.find((r) => r.id === b.id);
          assert(r, "找不到申請");
          assert(
            ["approve", "reject", "cancel"].includes(b.action),
            "操作無效",
          );
          if (b.action === "cancel")
            assert(["pending", "approved"].includes(r.status), "無法撤銷");
          else assert(r.status === "pending", "此申請已處理");
          if (b.action === "approve") {
            const issues = conflicts(state, r.week, r.changes, r.id);
            assert(!issues.length, issues.join("；"));
          }
          r.status = {
            approve: "approved",
            reject: "rejected",
            cancel: "cancelled",
          }[b.action];
          r.decidedAt = new Date().toISOString();
          audit(state, `申請${r.status}`, r.id);
          if (["approve", "cancel"].includes(b.action))
            state.notifications.unshift({
              id: crypto.randomUUID(),
              title:
                b.action === "approve" ? "課表異動已生效" : "課表異動已撤銷",
              body: `${r.week} 週・${seed.lessons.find((l) => l.id === r.lessonId).name}：${r.reason}。${r.changes
                .map((c) => {
                  const l = seed.lessons.find((l) => l.id === c.id);
                  return `${l.teachers.join("、")} → ${(c.teachers || l.teachers).join("、")}；週${"一二三四五"[c.day ?? l.day]}第 ${c.period ?? l.period} 節／${c.room || l.room}`;
                })
                .join("；")}`,
              lessonIds: r.changes.map((c) => c.id),
              at: r.decidedAt,
              read: false,
              channel: "站內通知（未寄送 LINE／Email）",
            });
          store.write(state);
          return send(200, r);
        }
        if (req.method === "POST" && url.pathname === "/api/enrollments") {
          assert(
            typeof b.name === "string" &&
              b.name.trim().length > 0 &&
              b.name.length <= 40,
            "請輸入學生名稱（最多 40 字）",
          );
          assert(
            Array.isArray(b.lessonIds) &&
              b.lessonIds.every((id) => seed.lessons.some((l) => l.id === id)),
            "課程無效",
          );
          const ids = [...new Set(b.lessonIds)];
          for (const week of [
            seed.start,
            ...new Set(
              state.requests
                .filter((r) => r.status === "approved")
                .map((r) => r.week),
            ),
          ]) {
            const ls = schedule(state, week).filter((l) => ids.includes(l.id));
            for (let i = 0; i < ls.length; i++)
              for (let j = i + 1; j < ls.length; j++)
                assert(
                  ls[i].day !== ls[j].day || ls[i].period !== ls[j].period,
                  `${week} 週選課衝堂：${ls[i].name}／${ls[j].name}`,
                );
          }
          const e = {
            id: b.id || crypto.randomUUID(),
            name: b.name.trim(),
            lessonIds: ids,
          };
          if (b.id)
            assert(
              state.enrollments.some((e) => e.id === b.id),
              "學生不存在",
            );
          state.enrollments = state.enrollments.filter((x) => x.id !== e.id);
          state.enrollments.push(e);
          audit(state, "更新個人選課", e.name);
          store.write(state);
          return send(200, e);
        }
        if (req.method === "POST" && url.pathname === "/api/review") {
          assert(
            seed.lessons.some((l) => l.id === b.id),
            "課程不存在",
          );
          assert(
            ["必修", "選修", "校定必修", "待核定"].includes(b.kind),
            "課程類型錯誤",
          );
          assert(
            Array.isArray(b.classes) &&
              b.classes.every((c) => /^\d{3}$/.test(c)),
            "班級格式錯誤",
          );
          state.review[b.id] = {
            kind: b.kind,
            classes: b.classes,
            needsReview: false,
          };
          audit(state, "核對匯入課程", b.id);
          store.write(state);
          return send(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/read") {
          state.notifications.forEach((n) => (n.read = true));
          store.write(state);
          return send(200, { ok: true });
        }
        return send(404, { error: "找不到 API" });
      }
      if (!["GET", "HEAD"].includes(req.method))
        return send(405, { error: "不支援的操作" });
      const name =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).slice(1);
      const file = path.resolve(ROOT, "public", name);
      assert(file.startsWith(path.join(ROOT, "public") + path.sep), "路徑無效");
      if (!existsSync(file)) return send(404, { error: "找不到檔案" });
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".pdf": "application/pdf",
      };
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(readFileSync(file));
    } catch (e) {
      send(e.status || 400, { error: e.message });
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  mkdirSync(path.join(ROOT, "data"), { recursive: true });
  const store = createStore(
    process.env.DB_PATH || path.join(ROOT, "data/app.sqlite"),
  );
  createApp(store).listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
    console.log("Course Flow ready on port " + (process.env.PORT || 3000)),
  );
}
