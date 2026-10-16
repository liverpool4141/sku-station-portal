/* SKU Station core — shared by admin.html (portal) and index.html (scanner). Also loadable in Node.
 * Data model (same JSON a future FastAPI backend will serve):
 *  Project  = {schema:1, id, name, updated, config:{rows:["A","B","C","D"], perRow:100, defaultMode:"pallet"|"single", defaultN:30},
 *              skus:[{sku, name, boxes, mode:null|"pallet"|"single", n:null|int, slots:[...], zone:null|"A"}]}
 *  State    = {projectId, counts:{sku:int}, extra:{sku:[slot]}, hist:[{t, sku, slot, k, scanned, total, src}], unsynced:[...] }
 *  Future API: GET /api/project -> Project; PUT /api/project; POST /api/scans {deviceId, scans:[hist items]}; GET /api/state
 *  Devices call Core.sync() every 30 min (Core.SYNC_MS) when config.syncUrl is set. */
(function (root) {
  const SCHEMA = 1, SYNC_MS = 30 * 60 * 1000;
  const K_PROJECT = "skuProject", K_STATE = "skuState2";
  const SKU_RE = /A\d{3}-[A-Z0-9]{4,}(?:-(?:[A-Z]|\d{1,2}))?/;

  function newProject(name) {
    return { schema: SCHEMA, id: "p" + Date.now().toString(36), name: name || "新柜", updated: new Date().toISOString(),
      config: { rows: ["A", "B", "C", "D"], coordStyle: "letter", perRow: 100, defaultMode: "pallet", defaultN: 30, syncUrl: "" }, skus: [] };
  }
  const newState = (pid) => ({ projectId: pid, counts: {}, extra: {}, hist: [], unsynced: [] });
  const modeOf = (p, s) => s.mode || p.config.defaultMode;
  const nOf = (p, s) => Math.max(1, +(s.n || p.config.defaultN) || 30);
  const normSku = (x) => String(x || "").trim().toUpperCase().replace(/\s+/g, "");

  // ---------- parsing ----------
  /** Parse pasted text / CSV / extracted PDF text into [{sku,name,boxes}]. Merges duplicate SKUs (sums boxes). */
  function parseText(text) {
    const out = new Map();
    const add = (sku, name, boxes) => {
      sku = normSku(sku); if (!sku) return;
      const o = out.get(sku) || { sku, name: "", boxes: 0 };
      o.boxes += +boxes || 0; if (name && !o.name) o.name = name.trim(); out.set(sku, o);
    };
    for (let line of String(text).split(/\r?\n/)) {
      line = line.trim(); if (!line) continue;
      const cells = line.includes("\t") ? line.split("\t") : line.includes(",") ? splitCsv(line) : line.split(/\s{2,}|\s+(?=\d+\s*$)/);
      const c = cells.map((x) => x.trim()).filter((x) => x !== "");
      const si = c.findIndex((x) => SKU_RE.test(x.toUpperCase().replace(/\s/g, "")) || /^[A-Z]\d{2,}-[A-Z0-9-]+$/i.test(x));
      if (si < 0) continue;                                      // header / junk line
      const sku = c[si].toUpperCase().match(SKU_RE)?.[0] || c[si];
      const nums = c.filter((x, i) => i !== si && /^\d+$/.test(x));
      const boxes = nums.length ? +nums[nums.length - 1] : 0;    // last integer = box count (forecast PDF: qty column)
      const name = c.filter((x, i) => i !== si && !/^\d+$/.test(x) && !/^IB\w+$/i.test(x)).join(" ");
      add(sku, name, boxes);
    }
    return [...out.values()];
  }
  function splitCsv(line) { const r = []; let cur = "", q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; }
    r.push(cur); return r; }
  /** rows from SheetJS sheet_to_json(header:1) -> text the parser understands */
  const rowsToText = (rows) => rows.map((r) => r.map((x) => (x == null ? "" : String(x))).join("\t")).join("\n");

  // ---------- table parsing + column detection (admin PDF flow) ----------
  /** text -> array of cell arrays. Splits on tab, CSV comma, or 2+ spaces; drops empty lines. */
  function parseTable(text) {
    const rows = [];
    for (let line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = line.includes("\t") ? line.split("\t") : line.includes(",") ? splitCsv(line) : line.trim().split(/\s{2,}/);
      const c = cells.map((x) => x.trim()).filter((x) => x !== "");
      if (c.length >= 2) rows.push(c);
    }
    return rows;
  }
  const SKU_LIKE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_.\/]+(?:-[A-Za-z0-9_.\/]+)+$/;
  const isInt = (x) => /^\d{1,7}$/.test(String(x).trim());
  /** Guess {sku, qty, name} column indexes (-1 = none) + hasHeader from data rows. */
  function detectColumns(rows) {
    const n = Math.max(0, ...rows.map((r) => r.length)); const col = (i) => rows.map((r) => r[i]).filter((x) => x != null && x !== "");
    const stat = Array.from({ length: n }, (_, i) => { const c = col(i), t = Math.max(1, c.length);
      return { i, sku: c.filter((x) => SKU_LIKE.test(x.replace(/\s/g, ""))).length / t, int: c.filter(isInt).length / t,
        ord: c.filter((x) => /^IB\w+$/i.test(x)).length / t, cjk: c.filter((x) => /[\u4e00-\u9fff]/.test(x)).length / t, n: c.length }; });
    const by = (f) => stat.filter(f.filter).sort(f.sort)[0];
    const skuC = stat.filter((s) => s.sku > 0.5).sort((a, b) => b.sku - a.sku || a.i - b.i)[0];
    const sku = skuC ? skuC.i : -1;
    const qtyC = stat.filter((s) => s.i !== sku && s.int > 0.5).sort((a, b) => b.int - a.int || b.i - a.i)[0];
    const qty = qtyC ? qtyC.i : -1;
    const nameC = stat.filter((s) => s.i !== sku && s.i !== qty && s.ord < 0.5 && s.int < 0.5 && s.sku < 0.5 && s.n > 0).sort((a, b) => b.cjk - a.cjk || b.n - a.n)[0];
    const name = nameC ? nameC.i : -1;
    const first = rows[0] || []; const hasHeader = sku >= 0 && first[sku] != null && !SKU_LIKE.test(String(first[sku]).replace(/\s/g, ""));
    return { sku, qty, name, hasHeader };
  }
  /** Build [{sku,name,boxes}] from rows + chosen columns; skips non-data rows (no SKU, or qty not integer). Merges duplicates. */
  function fromColumns(rows, cols, skipHeader) {
    const out = new Map(); let skipped = 0;
    rows.forEach((r, ri) => {
      if (skipHeader && ri === 0) return;
      const sku = normSku(r[cols.sku]); if (!sku || !SKU_LIKE.test(sku)) { skipped++; return; }
      const q = cols.qty >= 0 ? String(r[cols.qty] ?? "").replace(/[,\s]/g, "") : "0"; if (cols.qty >= 0 && !isInt(q)) { skipped++; return; }
      const o = out.get(sku) || { sku, name: "", boxes: 0 }; o.boxes += +q || 0;
      const nm = cols.name >= 0 ? String(r[cols.name] ?? "").trim() : ""; if (nm && !o.name) o.name = nm; out.set(sku, o);
    });
    return { list: [...out.values()], skipped };
  }

  function mergeSkus(p, list, replace) {
    if (replace) p.skus = [];
    for (const it of list) {
      const ex = p.skus.find((s) => s.sku === it.sku);
      if (ex) { ex.boxes = it.boxes; if (it.name) ex.name = it.name; }
      else p.skus.push({ sku: it.sku, name: it.name || "", boxes: +it.boxes || 0, mode: null, n: null, slots: [], zone: null });
    }
    touch(p); return p;
  }

  // ---------- allocation ----------
  const numeric = (p) => p.config.coordStyle === "number";
  const rowsOf = (p) => (numeric(p) ? [""] : p.config.rows);               // number style = one row with empty prefix: "1","2",...
  const maxLen = (p) => (numeric(p) ? p.config.perRow * p.config.rows.length : p.config.perRow);
  const pool = (p) => rowsOf(p).flatMap((r) => Array.from({ length: maxLen(p) }, (_, i) => r + (i + 1)));
  const slotNum = (x) => +String(x).replace(/^[A-Z]*/, "");
  const slotRow = (x) => String(x).replace(/\d+$/, "");
  const slotsNeeded = (p, s) => (modeOf(p, s) === "single" ? 0 : Math.max(1, Math.ceil((+s.boxes || 0) / nOf(p, s))));

  /** Auto-assign contiguous slots per SKU across rows; SKUs are never split across rows.
   *  keepManual=true keeps SKUs whose slots/zone were set (s.locked) and fills around them. */
  function autoAssign(p, opts = {}) {
    const rows = rowsOf(p), keep = opts.keepManual !== false;
    const taken = new Set();
    for (const s of p.skus) if (keep && s.locked) (modeOf(p, s) === "single" ? [] : s.slots).forEach((x) => taken.add(x));
    const pal = p.skus.filter((s) => !(keep && s.locked) && modeOf(p, s) === "pallet").sort((a, b) => a.sku.localeCompare(b.sku));
    const total = pal.reduce((a, s) => a + slotsNeeded(p, s), 0);
    let L = Math.max(1, Math.ceil((total + taken.size) / rows.length), ...pal.map((s) => slotsNeeded(p, s)));
    L = Math.min(L, maxLen(p));
    // free runs per row
    const tryFit = (len) => {
      const plan = new Map(); const used = new Set(taken); let r = 0, pos = 1;
      for (const s of pal) {
        const need = slotsNeeded(p, s);
        for (;;) {
          if (r >= rows.length) return null;
          if (pos + need - 1 > len) { r++; pos = 1; continue; }
          const run = Array.from({ length: need }, (_, i) => rows[r] + (pos + i));
          const clash = run.findIndex((x) => used.has(x));
          if (clash >= 0) { pos += clash + 1; continue; }
          run.forEach((x) => used.add(x)); plan.set(s.sku, run); pos += need; break;
        }
      }
      return plan;
    };
    let plan = null;
    for (; L <= maxLen(p) && !(plan = tryFit(L)); L++);
    if (!plan) throw new Error("库位不足：请增加每排库位数 perRow");
    for (const s of pal) s.slots = plan.get(s.sku);
    // single-mode SKUs: zone defaults to first row letter if unset
    for (const s of p.skus) if (modeOf(p, s) === "single") { s.zone = s.zone || (numeric(p) ? "1" : rows[0]); s.slots = []; }
    touch(p); return { rowLength: L, totalSlots: total + taken.size };
  }

  /** Returns list of problems: duplicate slots, bad format, missing slots. */
  function validate(p) {
    const errs = [], seen = new Map(), re = new RegExp("^(" + rowsOf(p).join("|") + ")\\d+$");
    const skus = new Set();
    for (const s of p.skus) {
      if (skus.has(s.sku)) errs.push({ sku: s.sku, msg: "SKU 重复" }); skus.add(s.sku);
      if (modeOf(p, s) === "single") { if (!s.zone) errs.push({ sku: s.sku, msg: "未设置区域" }); continue; }
      if (!s.slots || !s.slots.length) errs.push({ sku: s.sku, msg: "未分配库位" });
      else if (s.slots.length < slotsNeeded(p, s)) errs.push({ sku: s.sku, msg: `库位不足：需要 ${slotsNeeded(p, s)} 个，已有 ${s.slots.length}` });
      for (const x of s.slots || []) {
        if (!re.test(x)) errs.push({ sku: s.sku, slot: x, msg: "库位格式错误" });
        if (seen.has(x)) errs.push({ sku: s.sku, slot: x, msg: `库位与 ${seen.get(x)} 重复` }); else seen.set(x, s.sku);
      }
    }
    return errs;
  }
  const parseSlots = (txt) => String(txt).toUpperCase().split(/[\s,，;；]+/).filter(Boolean).flatMap((t) => {
    const m = t.match(/^([A-Z]?)(\d+)[-–~]\1?(\d+)$/); if (!m) return [t];
    const a = +m[2], b = +m[3]; return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => m[1] + (a + i));
  });

  // ---------- scanning ----------
  /** Register one scan. Returns {sku, name, slot, mode, k, n, scanned, total, isNew, planned, over}. */
  function scan(p, st, skuRaw, src) {
    const sku = normSku(skuRaw); const s = p.skus.find((x) => x.sku === sku);
    const scanned = (st.counts[sku] || 0) + 1; st.counts[sku] = scanned;
    let r;
    if (s && modeOf(p, s) === "single") {
      r = { slot: s.zone, mode: "single", k: scanned, n: null, isNew: scanned === 1 };
    } else {
      const n = s ? nOf(p, s) : p.config.defaultN, idx = Math.floor((scanned - 1) / n);
      const lst = (s ? s.slots : []).concat(st.extra[sku] || []);
      while (lst.length <= idx) {
        const used = new Set([...p.skus.flatMap((x) => x.slots || []), ...Object.values(st.extra).flat()]);
        const fr = pool(p).find((x) => !used.has(x)); if (!fr) { lst.push("FULL"); break; }
        (st.extra[sku] = st.extra[sku] || []).push(fr); lst.push(fr);
      }
      const k = (scanned - 1) % n + 1;
      r = { slot: lst[Math.min(idx, lst.length - 1)], mode: "pallet", k, n, isNew: k === 1 };
    }
    Object.assign(r, { sku, name: s ? s.name : "", scanned, total: s ? +s.boxes || 0 : 0, planned: !!s });
    r.over = r.total > 0 && scanned > r.total;
    const h = { t: new Date().toISOString(), sku, slot: r.slot, k: r.k, scanned, total: r.total, src: src || "scan" };
    st.hist.unshift(h); st.hist = st.hist.slice(0, 5000); st.unsynced.push(h);
    return r;
  }
  /** Current slot without counting (for display). */
  function progress(p, st) {
    return p.skus.map((s) => ({ sku: s.sku, name: s.name, boxes: +s.boxes || 0, scanned: st.counts[s.sku] || 0,
      mode: modeOf(p, s), where: modeOf(p, s) === "single" ? s.zone : rangeText(s.slots) }));
  }
  function rangeText(sl) { if (!sl || !sl.length) return ""; if (sl.length === 1) return sl[0];
    const same = sl.every((x, i) => i === 0 || (slotRow(x) === slotRow(sl[0]) && slotNum(x) === slotNum(sl[i - 1]) + 1));
    return same ? `${sl[0]}–${sl[sl.length - 1]}` : sl.join(" "); }

  // ---------- speech text ----------
  const EN = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
  const ENT = { 2: "twenty", 3: "thirty", 4: "forty", 5: "fifty", 6: "sixty", 7: "seventy", 8: "eighty", 9: "ninety" };
  const ES = "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciséis diecisiete dieciocho diecinueve veinte veintiuno veintidós veintitrés veinticuatro veinticinco veintiséis veintisiete veintiocho veintinueve".split(" ");
  const EST = { 3: "treinta", 4: "cuarenta", 5: "cincuenta", 6: "sesenta", 7: "setenta", 8: "ochenta", 9: "noventa" };
  const ESL = { A: "a", B: "be", C: "ce", D: "de", E: "e", F: "efe", G: "ge", H: "hache" };
  const en = (n) => (n < 20 ? EN[n] : n < 100 ? ENT[Math.floor(n / 10)] + (n % 10 ? "-" + EN[n % 10] : "") : String(n));
  const es = (n) => (n < 30 ? ES[n] : n < 100 ? EST[Math.floor(n / 10)] + (n % 10 ? " y " + ES[n % 10] : "") : String(n));
  function phrases(slot) {
    if (/^\d+$/.test(String(slot))) return [`Slot ${en(+slot)}`, `Posición ${es(+slot)}`];   // numeric coordinate: "one" / "uno"
    const m = String(slot).match(/^([A-Z])(\d+)?$/); if (!m) return [String(slot), String(slot)];
    if (!m[2]) return [`Zone ${m[1]}`, `Zona ${ESL[m[1]] || m[1]}`];
    return [`Slot ${m[1]} ${en(+m[2])}`, `Posición ${ESL[m[1]] || m[1]} ${es(+m[2])}`];
  }

  // ---------- storage (localStorage now; API later) ----------
  const LS = () => root.localStorage;
  function touch(p) { p.updated = new Date().toISOString(); }
  function loadProject(fallback) { try { const j = JSON.parse(LS().getItem(K_PROJECT)); if (j && j.schema) return j; } catch (e) {} return fallback === undefined ? newProject() : fallback; }
  const K_DRAFT = "skuDraft";
  function loadDraft(fallback) { try { const j = JSON.parse(LS().getItem(K_DRAFT)); if (j && j.schema) return j; } catch (e) {} return fallback; }
  function saveDraft(p) { touch(p); LS().setItem(K_DRAFT, JSON.stringify(p)); }
  /** Approve: copy the draft to the live project the scanner reads. Nothing is live before this. */
  function publishDraft(p) { p.published = new Date().toISOString(); LS().setItem(K_PROJECT, JSON.stringify(p)); LS().setItem(K_DRAFT, JSON.stringify(p)); }
  function saveProject(p) { touch(p); LS().setItem(K_PROJECT, JSON.stringify(p)); }
  function loadState(p) { let s; try { s = JSON.parse(LS().getItem(K_STATE)); } catch (e) {}
    if (!s || s.projectId !== p.id) s = Object.assign(newState(p.id), s && s.projectId === p.id ? s : {}); return s; }
  function saveState(s) { LS().setItem(K_STATE, JSON.stringify(s)); }
  const exportBundle = (p, s) => JSON.stringify({ kind: "sku-station-bundle", schema: SCHEMA, project: p, state: s || null }, null, 1);
  function importBundle(txt) { const j = JSON.parse(txt); if (j.kind === "sku-station-bundle") return j; if (j.schema && j.skus) return { project: j, state: null }; throw new Error("不是有效的导出文件"); }
  function csvEscape(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  const toCsv = (rows) => "\ufeff" + rows.map((r) => r.map(csvEscape).join(",")).join("\n");
  function exportProgressCsv(p, s) { return toCsv([["sku", "name", "boxes", "scanned", "mode", "location"], ...progress(p, s).map((r) => [r.sku, r.name, r.boxes, r.scanned, r.mode, r.where])]); }
  function exportHistCsv(s) { return toCsv([["time", "sku", "slot", "k", "scanned", "total", "source"], ...s.hist.map((h) => [h.t, h.sku, h.slot, h.k, h.scanned, h.total, h.src])]); }
  /** Future backend sync: push unsynced scans, pull newer project. No-op without config.syncUrl. */
  async function sync(p, s) {
    const url = p.config.syncUrl; if (!url) return { skipped: true };
    const r = await fetch(url + "/api/scans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: deviceId(), projectId: p.id, scans: s.unsynced }) });
    if (r.ok) { s.unsynced = []; saveState(s); }
    const pr = await fetch(url + "/api/project"); const np = pr.ok ? await pr.json() : null;
    if (np && np.updated > p.updated) saveProject(np);
    return { ok: r.ok, projectUpdated: !!(np && np.updated > p.updated) };
  }
  function deviceId() { let d = LS().getItem("skuDevice"); if (!d) { d = "dev-" + Math.random().toString(36).slice(2, 10); LS().setItem("skuDevice", d); } return d; }

  const Core = { parseTable, detectColumns, fromColumns, SKU_LIKE, rowsOf, SCHEMA, SYNC_MS, SKU_RE, newProject, newState, parseText, rowsToText, mergeSkus, autoAssign, validate, parseSlots,
    slotsNeeded, modeOf, nOf, scan, progress, rangeText, phrases, loadProject, saveProject, loadDraft, saveDraft, publishDraft, loadState, saveState,
    exportBundle, importBundle, exportProgressCsv, exportHistCsv, sync, normSku, pool };
  if (typeof module !== "undefined") module.exports = Core; else root.Core = Core;
})(typeof window !== "undefined" ? window : globalThis);
