/* ============================================================
   joincraft — app.js
   DOM wiring only. All join/GROUP BY/3VL/CSV logic lives in the pure,
   tested module data/engine.js (window.JOINCRAFT_ENGINE). Corpus is
   window.JOINCRAFT. No inline handlers (CSP forbids them); everything
   is wired with addEventListener. No network — the CSP guarantees it.
   ============================================================ */
(function () {
  'use strict';

  var C = window.JOINCRAFT;
  var E = window.JOINCRAFT_ENGINE;
  if (!C || !E) return;

  var LS = 'joincraft.v1';

  /* ---------- state ---------- */
  // Working tables are a deep clone of a preset (so edits don't mutate corpus).
  var state = {
    presetId: C.PAIRS[0].id,
    left: null,
    right: null,
    op: { type: 'INNER', leftKey: null, rightKey: null, groupBy: null },
    activeScenario: null,
    revealed: Infinity, // ribbon playback: how many output rows shown
    understood: {}      // scenario id -> true
  };

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        presetId: state.presetId,
        left: state.left,
        right: state.right,
        op: state.op,
        understood: state.understood
      }));
    } catch (e) { /* storage may be unavailable; app still works */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(LS);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function clonePreset(id) {
    var p = C.PAIRS.find(function (x) { return x.id === id; });
    return {
      left: JSON.parse(JSON.stringify(p.left)),
      right: JSON.parse(JSON.stringify(p.right)),
      blurb: p.blurb
    };
  }

  /* ---------- init ---------- */
  function init() {
    var saved = load();
    if (saved && saved.left && saved.right) {
      state.presetId = saved.presetId || C.PAIRS[0].id;
      state.left = saved.left;
      state.right = saved.right;
      state.op = saved.op || state.op;
      state.understood = saved.understood || {};
    } else {
      loadPreset(C.PAIRS[0].id, false);
    }
    if (!state.op.leftKey) state.op.leftKey = state.left.keyCol;
    if (!state.op.rightKey) state.op.rightKey = state.right.keyCol;

    buildPresetSelect();
    buildScenarios();
    buildThreeVL();
    wireControls();
    syncControlsFromState();
    renderAll();
  }

  function loadPreset(id, keepOp) {
    var c = clonePreset(id);
    state.presetId = id;
    state.left = c.left;
    state.right = c.right;
    if (!keepOp) {
      state.op.leftKey = c.left.keyCol;
      state.op.rightKey = c.right.keyCol;
      state.op.groupBy = null;
    }
  }

  /* ---------- preset select ---------- */
  function buildPresetSelect() {
    var sel = document.getElementById('presetSel');
    sel.innerHTML = '';
    C.PAIRS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.title;
      sel.appendChild(o);
    });
    sel.value = state.presetId;
    updatePresetBlurb();
    sel.addEventListener('change', function () {
      loadPreset(sel.value, false);
      state.activeScenario = null;
      markActiveScenario();
      updatePresetBlurb();
      syncControlsFromState();
      renderAll();
      save();
    });
  }
  function updatePresetBlurb() {
    var p = C.PAIRS.find(function (x) { return x.id === state.presetId; });
    document.getElementById('presetBlurb').textContent = p ? p.blurb : '';
  }

  /* ---------- editable tables ---------- */
  function renderTable(side, wrapId) {
    var t = state[side];
    var wrap = document.getElementById(wrapId);
    wrap.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'tablewrap__name';
    var nm = document.createElement('span');
    nm.textContent = t.name;
    var kt = document.createElement('span');
    kt.className = 'keytag';
    kt.textContent = 'key: ' + t.keyCol;
    head.appendChild(nm); head.appendChild(kt);
    wrap.appendChild(head);

    var table = document.createElement('table');
    table.className = 'grid';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    t.cols.forEach(function (col) {
      var th = document.createElement('th');
      th.textContent = col.name;
      if (col.name === t.keyCol) th.className = 'is-key';
      htr.appendChild(th);
    });
    htr.appendChild(document.createElement('th')); // delete col
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    t.rows.forEach(function (row, ri) {
      var tr = document.createElement('tr');
      t.cols.forEach(function (col, ci) {
        var td = document.createElement('td');
        td.appendChild(buildCell(side, ri, ci, col, row[ci]));
        tr.appendChild(td);
      });
      var delTd = document.createElement('td');
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'rowdel'; del.textContent = '×';
      del.setAttribute('aria-label', 'Delete row ' + (ri + 1) + ' of ' + t.name);
      del.addEventListener('click', function () {
        if (t.rows.length <= 1) return;
        t.rows.splice(ri, 1);
        state.activeScenario = null; markActiveScenario();
        renderAll(); save();
      });
      delTd.appendChild(del);
      tr.appendChild(delTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    var add = document.createElement('button');
    add.type = 'button'; add.className = 'btn btn--tiny rowadd';
    add.textContent = '+ Add row';
    if (t.rows.length >= 8) { add.disabled = true; add.textContent = 'Max 8 rows'; }
    add.addEventListener('click', function () {
      if (t.rows.length >= 8) return;
      t.rows.push(t.cols.map(function (c) { return c.type === 'number' ? 0 : ''; }));
      state.activeScenario = null; markActiveScenario();
      renderAll(); save();
    });
    wrap.appendChild(add);
  }

  function buildCell(side, ri, ci, col, val) {
    var t = state[side];
    var wrap = document.createElement('span');
    wrap.className = 'cell' + (val === null ? ' is-null' : '');

    var input = document.createElement('input');
    input.className = 'cell__in';
    input.type = 'text';
    input.value = val === null ? 'NULL' : String(val);
    input.setAttribute('aria-label', t.name + ' row ' + (ri + 1) + ' ' + col.name);
    input.setAttribute('inputmode', col.type === 'number' ? 'numeric' : 'text');
    if (val === null) input.readOnly = true;

    input.addEventListener('change', function () {
      if (t.rows[ri][ci] === null) return; // NULL toggled off via button
      var raw = input.value;
      if (col.type === 'number') {
        var n = Number(raw);
        t.rows[ri][ci] = raw.trim() === '' ? 0 : (isNaN(n) ? t.rows[ri][ci] : n);
      } else {
        t.rows[ri][ci] = raw;
      }
      state.activeScenario = null; markActiveScenario();
      renderAll(); save();
    });

    var nb = document.createElement('button');
    nb.type = 'button'; nb.className = 'cell__null';
    nb.textContent = 'NULL';
    nb.setAttribute('aria-pressed', val === null ? 'true' : 'false');
    nb.setAttribute('title', 'Toggle NULL for this cell');
    nb.addEventListener('click', function () {
      if (t.rows[ri][ci] === null) {
        t.rows[ri][ci] = col.type === 'number' ? 0 : '';
      } else {
        t.rows[ri][ci] = null;
      }
      state.activeScenario = null; markActiveScenario();
      renderAll(); save();
    });

    wrap.appendChild(input);
    wrap.appendChild(nb);
    return wrap;
  }

  /* ---------- controls ---------- */
  function buildKeyOptions(sel, table, chosen) {
    sel.innerHTML = '';
    table.cols.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.name; o.textContent = c.name;
      sel.appendChild(o);
    });
    if (chosen && table.cols.some(function (c) { return c.name === chosen; })) sel.value = chosen;
  }

  function buildAggCols() {
    // aggregate column choices = all qualified columns of both tables
    var sel = document.getElementById('aggColSel');
    sel.innerHTML = '';
    qualifiedCols().forEach(function (q) {
      var o = document.createElement('option');
      o.value = q; o.textContent = q;
      sel.appendChild(o);
    });
    // group-by column choices
    var gsel = document.getElementById('groupColSel');
    var prev = state.op.groupBy ? state.op.groupBy.col : '';
    gsel.innerHTML = '<option value="">— none —</option>';
    qualifiedCols().forEach(function (q) {
      var o = document.createElement('option');
      o.value = q; o.textContent = q;
      gsel.appendChild(o);
    });
    if (prev) gsel.value = prev;
  }

  function qualifiedCols() {
    var out = [];
    state.left.cols.forEach(function (c) { out.push(state.left.name + '.' + c.name); });
    state.right.cols.forEach(function (c) { out.push(state.right.name + '.' + c.name); });
    return out;
  }

  function wireControls() {
    document.getElementById('joinTypes').addEventListener('change', function (e) {
      if (e.target.name !== 'jtype') return;
      state.op.type = e.target.value;
      state.activeScenario = null; markActiveScenario();
      syncKeyPanel();
      renderAll(); save();
    });
    document.getElementById('leftKeySel').addEventListener('change', function (e) {
      state.op.leftKey = e.target.value;
      state.activeScenario = null; markActiveScenario();
      renderAll(); save();
    });
    document.getElementById('rightKeySel').addEventListener('change', function (e) {
      state.op.rightKey = e.target.value;
      state.activeScenario = null; markActiveScenario();
      renderAll(); save();
    });
    document.getElementById('groupColSel').addEventListener('change', updateGroupBy);
    document.getElementById('aggSel').addEventListener('change', updateGroupBy);
    document.getElementById('aggColSel').addEventListener('change', updateGroupBy);

    document.getElementById('stepBtn').addEventListener('click', function () {
      var n = currentOutputCount();
      if (state.revealed === Infinity) state.revealed = 0;
      state.revealed = Math.min(n, state.revealed + 1);
      renderRibbon();
    });
    document.getElementById('playBtn').addEventListener('click', playRibbon);
    document.getElementById('allBtn').addEventListener('click', function () {
      state.revealed = Infinity; renderRibbon();
    });

    document.getElementById('csvBtn').addEventListener('click', downloadCSV);
    document.getElementById('printBtn').addEventListener('click', function () {
      buildPrintHead(); window.print();
    });
    document.getElementById('copySqlBtn').addEventListener('click', copySql);
    document.getElementById('scenResetBtn').addEventListener('click', function () {
      state.understood = {};
      buildScenarios(); updateProgress(); save();
    });
  }

  function updateGroupBy() {
    var col = document.getElementById('groupColSel').value;
    var agg = document.getElementById('aggSel').value;
    var aggCol = document.getElementById('aggColSel').value;
    var groupSet = document.getElementById('groupColSel').value !== '' ||
      agg !== 'COUNT_STAR';
    if (!groupSet) { state.op.groupBy = null; }
    else {
      state.op.groupBy = { col: col === '' ? null : col, agg: agg, aggCol: aggCol };
    }
    // COUNT_STAR needs no aggCol
    document.getElementById('aggColLabel').style.display = (agg === 'COUNT_STAR') ? 'none' : '';
    state.activeScenario = null; markActiveScenario();
    renderAll(); save();
  }

  function syncKeyPanel() {
    var isCross = state.op.type === 'CROSS';
    document.getElementById('leftKeySel').disabled = isCross;
    document.getElementById('rightKeySel').disabled = isCross;
    document.getElementById('crossHint').hidden = !isCross;
  }

  function syncControlsFromState() {
    // join type radio
    var radios = document.querySelectorAll('input[name="jtype"]');
    radios.forEach(function (r) { r.checked = (r.value === state.op.type); });
    buildKeyOptions(document.getElementById('leftKeySel'), state.left, state.op.leftKey);
    buildKeyOptions(document.getElementById('rightKeySel'), state.right, state.op.rightKey);
    buildAggCols();
    // group-by controls
    var gb = state.op.groupBy;
    document.getElementById('groupColSel').value = gb && gb.col ? gb.col : '';
    document.getElementById('aggSel').value = gb ? gb.agg : 'COUNT_STAR';
    if (gb && gb.aggCol) document.getElementById('aggColSel').value = gb.aggCol;
    document.getElementById('aggColLabel').style.display =
      (document.getElementById('aggSel').value === 'COUNT_STAR') ? 'none' : '';
    syncKeyPanel();
  }

  /* ---------- evaluation helpers ---------- */
  function tables() { return { left: state.left, right: state.right }; }
  function currentResult() {
    try { return E.evaluate(state.op, tables()); }
    catch (e) { return []; }
  }
  function currentJoinRows() {
    try { return E.joinOnly(state.op, state.left, state.right); }
    catch (e) { return []; }
  }
  function currentOutputCount() { return currentJoinRows().length; }

  /* ---------- render orchestration ---------- */
  function renderAll() {
    renderTable('left', 'leftTableWrap');
    renderTable('right', 'rightTableWrap');
    buildAggCols(); // columns may have changed with preset
    state.revealed = Infinity;
    renderRibbon();
    renderCounters();
    renderResult();
    renderSql();
  }

  /* ---------- ribbon SVG ---------- */
  function renderRibbon() {
    var stage = document.getElementById('ribbonStage');
    var annot = document.getElementById('ribbonAnnot');
    stage.innerHTML = '';

    var L = state.left, R = state.right;
    var joinRows = currentJoinRows(); // non-grouped join pairing
    var rowH = 30, gap = 8, padY = 18, colW = 150;
    var nL = L.rows.length, nR = R.rows.length;
    var rows = Math.max(nL, nR);
    var H = padY * 2 + rows * (rowH + gap);
    var W = 620;

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Ribbons from each output row to its source rows');

    var leftX = 14, rightX = W - 14 - colW;
    var keyIdxL = E.keyIndex(L, state.op.leftKey);
    var keyIdxR = E.keyIndex(R, state.op.rightKey);

    function drawStack(table, x, keyIdx) {
      var centers = [];
      table.rows.forEach(function (row, i) {
        var y = padY + i * (rowH + gap);
        var isNullKey = state.op.type !== 'CROSS' && row[keyIdx] === null;
        var rect = document.createElementNS(svg.namespaceURI, 'rect');
        rect.setAttribute('x', x); rect.setAttribute('y', y);
        rect.setAttribute('width', colW); rect.setAttribute('height', rowH);
        rect.setAttribute('rx', 5);
        rect.setAttribute('class', 'rrow' + (isNullKey ? ' rrow--null' : ''));
        svg.appendChild(rect);

        var label = document.createElementNS(svg.namespaceURI, 'text');
        label.setAttribute('x', x + 8); label.setAttribute('y', y + rowH / 2 + 4);
        label.setAttribute('class', 'rlabel');
        var cells = row.map(function (v) { return v === null ? 'NULL' : v; }).join(', ');
        label.textContent = cells.length > 20 ? cells.slice(0, 19) + '…' : cells;
        svg.appendChild(label);

        centers.push({ x: x === leftX ? x + colW : x, y: y + rowH / 2, nullKey: isNullKey });
      });
      return centers;
    }

    var lc = drawStack(L, leftX, keyIdxL);
    var rc = drawStack(R, rightX, keyIdxR);

    // Map join output rows back to their source row indices to draw ribbons.
    // We re-pair deterministically the same way the engine does.
    var ribbons = buildRibbons();
    var shown = state.revealed === Infinity ? ribbons.length : state.revealed;
    ribbons.forEach(function (rb, i) {
      var a = rb.li !== null ? lc[rb.li] : null;
      var b = rb.ri !== null ? rc[rb.ri] : null;
      var path = document.createElementNS(svg.namespaceURI, 'path');
      var orphan = (a === null || b === null);
      // orphan: draw to a NULL pad on the missing side
      var ax = a ? a.x : leftX + colW, ay = a ? a.y : (padY + (rb.padIdx || 0) * (rowH + gap) + rowH / 2);
      var bx = b ? b.x : rightX, by = b ? b.y : (padY + (rb.padIdx || 0) * (rowH + gap) + rowH / 2);
      var mx = (ax + bx) / 2;
      path.setAttribute('d', 'M' + ax + ' ' + ay + ' C ' + mx + ' ' + ay + ', ' + mx + ' ' + by + ', ' + bx + ' ' + by);
      path.setAttribute('class', 'rib' + (orphan ? ' rib--orphan' : '') + (i >= shown ? ' is-hidden' : ''));
      svg.appendChild(path);
    });

    stage.appendChild(svg);

    // annotation
    var math = safeRowMath();
    var msg = '';
    if (state.op.type === 'CROSS') {
      msg = 'CROSS pairs every left row with every right row: ' + math.L + ' × ' + math.R + ' = ' + math.outputRows + ' rows.';
    } else {
      var nullL = L.rows.filter(function (r) { return r[keyIdxL] === null; }).length;
      var nullR = R.rows.filter(function (r) { return r[keyIdxR] === null; }).length;
      if (nullL || nullR) {
        msg = 'NULL-key rows (dashed) never match in ON — <strong>NULL = NULL is UNKNOWN, not TRUE</strong>. They only survive on the kept side of a LEFT/RIGHT/FULL join, padded with NULLs.';
      } else {
        msg = 'Each output row draws a ribbon back to the source rows it was built from. Duplicate keys fan one row out to many.';
      }
    }
    annot.innerHTML = msg;
  }

  // Build an ordered list of ribbons matching the engine's teaching order.
  function buildRibbons() {
    var L = state.left, R = state.right, op = state.op;
    var out = [];
    if (op.type === 'CROSS') {
      for (var a = 0; a < L.rows.length; a++)
        for (var b = 0; b < R.rows.length; b++)
          out.push({ li: a, ri: b });
      return out;
    }
    var li = E.keyIndex(L, op.leftKey), ri = E.keyIndex(R, op.rightKey);
    var leftMatched = {}, rightMatched = {};
    // matched pairs (left-row order)
    for (var i = 0; i < L.rows.length; i++) {
      for (var j = 0; j < R.rows.length; j++) {
        if (E.keysMatch(L.rows[i][li], R.rows[j][ri])) {
          out.push({ li: i, ri: j });
          leftMatched[i] = true; rightMatched[j] = true;
        }
      }
    }
    if (op.type === 'LEFT' || op.type === 'FULL') {
      for (var k = 0; k < L.rows.length; k++) if (!leftMatched[k]) out.push({ li: k, ri: null, padIdx: k });
    }
    if (op.type === 'RIGHT' || op.type === 'FULL') {
      for (var m = 0; m < R.rows.length; m++) if (!rightMatched[m]) out.push({ li: null, ri: m, padIdx: m });
    }
    return out;
  }

  function playRibbon() {
    var n = currentOutputCount();
    state.revealed = 0; renderRibbon();
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { state.revealed = Infinity; renderRibbon(); return; }
    var i = 0;
    var timer = setInterval(function () {
      i++;
      state.revealed = i;
      renderRibbon();
      if (i >= n) { clearInterval(timer); state.revealed = Infinity; renderRibbon(); }
    }, 320);
  }

  function safeRowMath() {
    try { return E.rowMath(state.op, tables()); }
    catch (e) { return { L: 0, R: 0, matchedPairs: 0, leftOrphans: 0, rightOrphans: 0, outputRows: 0 }; }
  }

  /* ---------- counters ---------- */
  function renderCounters() {
    var m = safeRowMath();
    var strip = document.getElementById('counterStrip');
    strip.innerHTML = '';
    var items = [
      { label: '|L| left rows', val: m.L },
      { label: '|R| right rows', val: m.R },
      { label: 'matched pairs', val: m.matchedPairs },
      { label: 'left orphans', val: m.leftOrphans },
      { label: 'right orphans', val: m.rightOrphans },
      { label: 'output rows', val: m.outputRows, out: true }
    ];
    items.forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'counter' + (it.out ? ' counter--out' : '');
      var v = document.createElement('div'); v.className = 'counter__val'; v.textContent = it.val;
      var l = document.createElement('div'); l.className = 'counter__label'; l.textContent = it.label;
      d.appendChild(v); d.appendChild(l);
      strip.appendChild(d);
    });
    document.getElementById('blowupCallout').hidden = !E.vennBlowup(m);
  }

  /* ---------- result table ---------- */
  function renderResult() {
    var wrap = document.getElementById('resultWrap');
    wrap.innerHTML = '';
    var rows = currentResult();
    if (!rows.length) {
      var em = document.createElement('div');
      em.className = 'rtable__empty';
      em.textContent = 'No rows. (An INNER join with no matching keys returns nothing.)';
      wrap.appendChild(em);
      return;
    }
    var headers = Object.keys(rows[0]);
    var table = document.createElement('table');
    table.className = 'rtable';
    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    headers.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h.replace(/^group\./, '').replace(/^agg\./, '');
      if (h.indexOf('group.') === 0 || h.indexOf('agg.') === 0) th.className = 'g-left';
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      headers.forEach(function (h) {
        var td = document.createElement('td');
        if (r[h] === null || r[h] === undefined) { td.textContent = 'NULL'; td.className = 'is-null'; }
        else td.textContent = r[h];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  /* ---------- illustrative SQL ---------- */
  function renderSql() {
    document.getElementById('sqlText').textContent = buildSql();
  }
  function buildSql() {
    var L = state.left, R = state.right, op = state.op;
    var la = 'l', ra = 'r';
    var sel, from;
    if (op.groupBy) {
      var gcol = op.groupBy.col;
      var aggTxt = E.aggLabel(op.groupBy.agg, op.groupBy.aggCol)
        .replace('COUNT(*)', 'COUNT(*)');
      // qualify agg column with table alias
      aggTxt = aggTxt.replace(L.name + '.', la + '.').replace(R.name + '.', ra + '.');
      var gsel = gcol ? qualify(gcol, la, ra) + ', ' : '';
      sel = 'SELECT ' + gsel + aggTxt;
    } else {
      sel = 'SELECT *';
    }
    if (op.type === 'CROSS') {
      from = '\nFROM ' + L.name + ' ' + la + '\nCROSS JOIN ' + R.name + ' ' + ra;
    } else {
      var jt = op.type === 'INNER' ? 'JOIN' : op.type + ' JOIN';
      from = '\nFROM ' + L.name + ' ' + la +
        '\n' + jt + ' ' + R.name + ' ' + ra +
        '\n  ON ' + la + '.' + op.leftKey + ' = ' + ra + '.' + op.rightKey;
    }
    var grp = '';
    if (op.groupBy && op.groupBy.col) grp = '\nGROUP BY ' + qualify(op.groupBy.col, la, ra);
    return sel + from + grp + ';';
  }
  function qualify(qcol, la, ra) {
    if (qcol.indexOf(state.left.name + '.') === 0) return la + '.' + qcol.slice(state.left.name.length + 1);
    if (qcol.indexOf(state.right.name + '.') === 0) return ra + '.' + qcol.slice(state.right.name.length + 1);
    return qcol;
  }

  function copySql() {
    var txt = buildSql();
    var btn = document.getElementById('copySqlBtn');
    // Clipboard write is same-origin/local; no network. Fall back to a textarea.
    function done() { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1400); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  }

  /* ---------- CSV export ---------- */
  function downloadCSV() {
    var rows = currentResult();
    var csv = E.toCSV(rows);
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob); // object URL is local, not a network fetch
    var a = document.createElement('a');
    a.href = url; a.download = 'joincraft-' + state.presetId + '-' + state.op.type.toLowerCase() + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* ---------- 3VL truth tables ---------- */
  function buildThreeVL() {
    var host = document.getElementById('threevl');
    host.innerHTML = '';
    host.appendChild(matrixCard('AND'));
    host.appendChild(matrixCard('OR'));
    host.appendChild(predicateCard());
  }
  function vClass(v) { return 'v-' + v; }
  function matrixCard(op) {
    var vals = ['TRUE', 'FALSE', 'UNKNOWN'];
    var card = document.createElement('div'); card.className = 'tt';
    var t = document.createElement('div'); t.className = 'tt__title'; t.textContent = op + ' (three-valued)';
    card.appendChild(t);
    var table = document.createElement('table'); table.className = 'ttgrid';
    var thead = document.createElement('thead'); var htr = document.createElement('tr');
    htr.appendChild(cell('th', op));
    vals.forEach(function (v) { htr.appendChild(cell('th', short(v))); });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = document.createElement('tbody');
    vals.forEach(function (a) {
      var tr = document.createElement('tr');
      tr.appendChild(cell('th', short(a)));
      vals.forEach(function (b) {
        var res = E.eval3(a, op, b);
        var td = cell('td', short(res)); td.className = vClass(res);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody); card.appendChild(table);
    return card;
  }
  function predicateCard() {
    var card = document.createElement('div'); card.className = 'tt';
    var t = document.createElement('div'); t.className = 'tt__title'; t.textContent = 'NULL predicates';
    card.appendChild(t);
    var ul = document.createElement('ul'); ul.className = 'tt__list';
    var rows = C.TRUTH.filter(function (e) {
      return ['=', '<>', 'IS NULL', 'IS NOT NULL', '<', '>'].indexOf(e.op) >= 0;
    });
    rows.forEach(function (e) {
      var li = document.createElement('li');
      var expr = document.createElement('span'); expr.className = 'expr';
      var rhs = (e.op === 'IS NULL' || e.op === 'IS NOT NULL') ? '' : ' ' + e.rhs;
      expr.textContent = e.lhs + ' ' + e.op + rhs;
      var res = document.createElement('span'); res.className = vClass(e.result); res.textContent = short(e.result);
      li.appendChild(expr); li.appendChild(res);
      ul.appendChild(li);
    });
    card.appendChild(ul);
    return card;
  }
  function short(v) { return v === 'UNKNOWN' ? 'UNK' : v; }
  function cell(tag, txt) { var c = document.createElement(tag); c.textContent = txt; return c; }

  /* ---------- scenarios ---------- */
  function buildScenarios() {
    var grid = document.getElementById('scenGrid');
    grid.innerHTML = '';
    C.SCENARIOS.forEach(function (s, idx) {
      var card = document.createElement('button');
      card.type = 'button'; card.className = 'scen-card'; card.setAttribute('role', 'listitem');
      card.dataset.id = s.id;
      if (state.understood[s.id]) card.classList.add('is-understood');

      var top = document.createElement('div'); top.className = 'scen-card__top';
      var num = document.createElement('span'); num.className = 'scen-card__num'; num.textContent = '#' + (idx + 1);
      var op = document.createElement('span'); op.className = 'scen-card__op';
      op.textContent = s.op.type + (s.op.groupBy ? ' + GROUP BY' : '');
      top.appendChild(num); top.appendChild(op);

      var title = document.createElement('span'); title.className = 'scen-card__title'; title.textContent = s.title;

      var chk = document.createElement('span'); chk.className = 'scen-card__check';
      var box = document.createElement('span'); box.className = 'box'; box.textContent = state.understood[s.id] ? '✓' : '';
      var ctext = document.createElement('span'); ctext.textContent = state.understood[s.id] ? 'understood' : 'mark understood';
      chk.appendChild(box); chk.appendChild(ctext);

      card.appendChild(top); card.appendChild(title); card.appendChild(chk);

      card.addEventListener('click', function (ev) { loadScenario(s, ev); });
      grid.appendChild(card);
    });
    updateProgress();
  }

  function loadScenario(s, ev) {
    // If the click was on the check region, toggle understood instead of loading.
    // Simplest robust behavior: load the scenario, and toggle understood via a
    // second click on an already-active card.
    var wasActive = state.activeScenario === s.id;
    loadPreset(s.pairId, true);
    state.op = JSON.parse(JSON.stringify(s.op));
    if (!state.op.leftKey && s.op.type !== 'CROSS') state.op.leftKey = state.left.keyCol;
    if (!state.op.rightKey && s.op.type !== 'CROSS') state.op.rightKey = state.right.keyCol;
    state.activeScenario = s.id;

    if (wasActive) {
      state.understood[s.id] = !state.understood[s.id];
    }
    updatePresetBlurb();
    document.getElementById('presetSel').value = s.pairId;
    syncControlsFromState();
    renderAll();
    setScenarioAnnot(s);
    markActiveScenario();
    buildScenarios();
    save();
    document.getElementById('ribbonHeading').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setScenarioAnnot(s) {
    var annot = document.getElementById('ribbonAnnot');
    annot.innerHTML = '<strong>' + s.title + '.</strong> ' + escapeHtml(s.explain);
  }

  function markActiveScenario() {
    var cards = document.querySelectorAll('.scen-card');
    cards.forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.id === state.activeScenario);
    });
  }

  function updateProgress() {
    var n = C.SCENARIOS.filter(function (s) { return state.understood[s.id]; }).length;
    document.getElementById('scenProgress').textContent = n + ' / 12 understood';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- print head ---------- */
  function buildPrintHead() {
    var head = document.getElementById('printHead');
    var m = safeRowMath();
    head.innerHTML = '';
    var r1 = document.createElement('div'); r1.className = 'printhead__row';
    r1.textContent = 'joincraft cheat-sheet — ' + state.left.name + ' ' + state.op.type +
      (state.op.type === 'CROSS' ? '' : ' JOIN ' + state.right.name + ' ON ' + state.op.leftKey + ' = ' + state.op.rightKey) + '.';
    var r2 = document.createElement('div'); r2.className = 'printhead__row';
    r2.textContent = 'Row math: |L|=' + m.L + '  |R|=' + m.R + '  matched=' + m.matchedPairs +
      '  leftOrphans=' + m.leftOrphans + '  rightOrphans=' + m.rightOrphans + '  output=' + m.outputRows + '.';
    head.appendChild(r1); head.appendChild(r2);
  }

  /* ---------- go ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
