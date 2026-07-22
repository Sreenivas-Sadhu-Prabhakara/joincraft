'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PAIRS, SCENARIOS, TRUTH } = require('../data/corpus.js');
const E = require('../data/engine.js');

/* ---------- fixtures ---------- */

function pair(id) {
  const p = PAIRS.find((x) => x.id === id);
  assert.ok(p, 'missing pair ' + id);
  return { left: p.left, right: p.right };
}
function scenario(id) {
  const s = SCENARIOS.find((x) => x.id === id);
  assert.ok(s, 'missing scenario ' + id);
  return s;
}
function tablesFor(s) {
  return pair(s.pairId);
}

/* ============================================================
   1. INNER duplicate-key blowup (the anti-Venn fact)
   ============================================================ */
test('INNER duplicate-key blowup: output can exceed BOTH inputs', () => {
  const L = { name: 'l', cols: [{ name: 'k', type: 'text' }], keyCol: 'k', rows: [['A'], ['A'], ['B']] };
  const R = { name: 'r', cols: [{ name: 'k', type: 'text' }], keyCol: 'k', rows: [['A'], ['A'], ['A'], ['C']] };
  const res = E.innerJoin(L, R, 'k', 'k');
  // L keys [A,A,B] x R keys [A,A,A,C] => A: 2*3 = 6 pairs; B,C no match.
  assert.equal(res.length, 6);
  const expected = [];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) expected.push({ 'l.k': 'A', 'r.k': 'A' });
  assert.deepStrictEqual(res, expected);
  // output (6) exceeds BOTH inputs (3 and 4)
  assert.ok(res.length > L.rows.length && res.length > R.rows.length);
});

test('scenario 1 corpus: sku INNER blowup, A-key 2x3=6 sub-count', () => {
  const s = scenario('inner_blowup');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  const aRows = res.filter((r) => r['sku_prices.sku'] === 'A');
  assert.equal(aRows.length, 6); // 2 price rows x 3 stock rows
  assert.equal(res.length, 7);   // + one B pair
});

/* ============================================================
   2. LEFT join NULL padding
   ============================================================ */
test('LEFT join customers x orders: each unmatched left row once, right cols null', () => {
  const s = scenario('left_padding');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  const orphans = res.filter((r) => r['orders.order_id'] === null);
  assert.equal(orphans.length, 3); // Devi, Esa, Faye
  for (const o of orphans) {
    assert.equal(o['orders.order_id'], null);
    assert.equal(o['orders.customer_id'], null);
    assert.equal(o['orders.amount'], null);
  }
});

/* ============================================================
   3. RIGHT metamorphic law across ALL 4 preset pairs
   ============================================================ */
test('RIGHT metamorphic law: rightJoin(L,R) === columnSwap(leftJoin(R,L))', () => {
  const keyByPair = {
    customers_orders: ['customer_id', 'customer_id'],
    employees_departments: ['dept_id', 'dept_id'],
    sku_prices_stock: ['sku', 'sku'],
    sensors_readings: ['sensor_id', 'sensor_id']
  };
  for (const p of PAIRS) {
    const [lk, rk] = keyByPair[p.id];
    const rj = E.rightJoin(p.left, p.right, lk, rk);
    const swapped = E.columnSwap(E.leftJoin(p.right, p.left, rk, lk), p.left, p.right);
    assert.deepStrictEqual(rj, swapped, 'law failed for ' + p.id);
  }
});

test('scenario 3 corpus: RIGHT customers x orders keeps NULL-customer order', () => {
  const s = scenario('right_is_swapped_left');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
});

/* ============================================================
   4. FULL join arithmetic + exact rows (both-sides orphans)
   ============================================================ */
test('FULL join arithmetic: length === matched + leftOrphans + rightOrphans', () => {
  const s = scenario('full_both_orphans');
  const t = tablesFor(s);
  const res = E.evaluate(s.op, t);
  assert.deepStrictEqual(res, s.expected);
  const m = E.rowMath(s.op, t);
  assert.equal(res.length, m.matchedPairs + m.leftOrphans + m.rightOrphans);
  assert.equal(m.matchedPairs, 5);
  assert.equal(m.leftOrphans, 1);  // Ven (dept null)
  assert.equal(m.rightOrphans, 1); // Legal (no employees)
});

test('scenario 12: FULL row count is NOT |L|+|R|', () => {
  const s = scenario('full_row_arithmetic');
  const t = tablesFor(s);
  const res = E.evaluate(s.op, t);
  assert.deepStrictEqual(res, s.expected);
  const a = s.arithmetic;
  assert.equal(res.length, a.matched + a.leftOrphans + a.rightOrphans);
  assert.equal(res.length, 7);
  assert.notEqual(res.length, a.naiveSum); // 7 !== 10
  assert.equal(a.naiveSum, t.left.rows.length + t.right.rows.length);
});

/* ============================================================
   5. CROSS join |L|x|R| (AMENDMENT: employees x departments = 6x4 = 24)
   ============================================================ */
test('CROSS join employees x departments === 6 x 4 = 24 ordered pairs', () => {
  const s = scenario('cross_product');
  const t = tablesFor(s);
  const res = E.evaluate(s.op, t);
  assert.equal(res.length, t.left.rows.length * t.right.rows.length);
  assert.equal(res.length, 24);
  assert.deepStrictEqual(res, s.expected);
});

/* ============================================================
   6. NULL keys never match in ON, yet survive LEFT with padding
   ============================================================ */
test('NULL keys produce 0 INNER pairs but survive LEFT with null padding', () => {
  const s = scenario('null_never_matches');
  const t = tablesFor(s);
  const inner = E.evaluate(s.op, t);
  assert.deepStrictEqual(inner, s.expected);
  // no INNER row has a null sensor key
  for (const r of inner) {
    assert.notEqual(r['sensors.sensor_id'], null);
    assert.notEqual(r['readings.sensor_id'], null);
  }
  // LEFT join: the two null-key sensor rows survive, null-padded
  const left = E.leftJoin(t.left, t.right, 'sensor_id', 'sensor_id');
  const nullLeft = left.filter((r) => r['sensors.sensor_id'] === null);
  assert.equal(nullLeft.length, 2); // Spare-A, Spare-B
  for (const r of nullLeft) {
    assert.equal(r['readings.reading_id'], null);
    assert.equal(r['readings.sensor_id'], null);
    assert.equal(r['readings.value'], null);
  }
});

/* ============================================================
   7. 3VL truth tables vs ISO
   ============================================================ */
test('eval3: NULL = NULL is UNKNOWN; NULL IS NULL is TRUE', () => {
  assert.equal(E.eval3(null, '=', null), 'UNKNOWN');
  assert.equal(E.eval3('NULL', '=', 'NULL'), 'UNKNOWN');
  assert.equal(E.eval3('NULL', 'IS NULL', null), 'TRUE');
  assert.equal(E.eval3('1', 'IS NULL', null), 'FALSE');
});

test('eval3: full 3x3 AND and OR matrices match ISO tables', () => {
  const AND = {
    TRUE: { TRUE: 'TRUE', FALSE: 'FALSE', UNKNOWN: 'UNKNOWN' },
    FALSE: { TRUE: 'FALSE', FALSE: 'FALSE', UNKNOWN: 'FALSE' },
    UNKNOWN: { TRUE: 'UNKNOWN', FALSE: 'FALSE', UNKNOWN: 'UNKNOWN' }
  };
  const OR = {
    TRUE: { TRUE: 'TRUE', FALSE: 'TRUE', UNKNOWN: 'TRUE' },
    FALSE: { TRUE: 'TRUE', FALSE: 'FALSE', UNKNOWN: 'UNKNOWN' },
    UNKNOWN: { TRUE: 'TRUE', FALSE: 'UNKNOWN', UNKNOWN: 'UNKNOWN' }
  };
  for (const a of ['TRUE', 'FALSE', 'UNKNOWN']) {
    for (const b of ['TRUE', 'FALSE', 'UNKNOWN']) {
      assert.equal(E.eval3(a, 'AND', b), AND[a][b], `${a} AND ${b}`);
      assert.equal(E.eval3(a, 'OR', b), OR[a][b], `${a} OR ${b}`);
    }
  }
  // spot facts called out in the brief
  assert.equal(E.eval3('UNKNOWN', 'AND', 'FALSE'), 'FALSE');
  assert.equal(E.eval3('UNKNOWN', 'OR', 'TRUE'), 'TRUE');
  assert.equal(E.eval3('UNKNOWN', 'NOT', null), 'UNKNOWN');
});

test('TRUTH corpus: every entry re-derives via eval3', () => {
  assert.equal(TRUTH.length, 33);
  for (const t of TRUTH) {
    assert.equal(E.eval3(t.lhs, t.op, t.rhs), t.result,
      `${t.lhs} ${t.op} ${t.rhs}`);
  }
});

/* ============================================================
   8. GROUP BY vs ON contrast (scenarios 6 & 7 same pair)
   ============================================================ */
test('NULL keys: 0 join matches (S6) but ONE group bucket (S7)', () => {
  const s6 = scenario('null_never_matches');
  const s7 = scenario('null_groups_together');
  assert.equal(s6.pairId, s7.pairId);
  const t = tablesFor(s7);

  // S6: NULL sensor rows matched 0
  const inner = E.evaluate(s6.op, t);
  assert.equal(inner.filter((r) => r['readings.sensor_id'] === null).length, 0);

  // S7: the NULL readings collapse into exactly ONE bucket
  const grouped = E.evaluate(s7.op, t);
  assert.deepStrictEqual(grouped, s7.expected);
  const nullBuckets = grouped.filter((r) => r['group.readings.sensor_id'] === null);
  assert.equal(nullBuckets.length, 1);
  assert.equal(nullBuckets[0]['agg.COUNT(*)'], 2); // both null-sensor readings
});

/* ============================================================
   9. Aggregate NULL rules
   ============================================================ */
test('COUNT(*) vs COUNT(col): col skips nulls', () => {
  const s = scenario('count_star_vs_col');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  // sensor 1 has 2 rows but 1 non-null value
  const s1 = res.find((r) => r['group.readings.sensor_id'] === 1);
  assert.equal(s1['agg.COUNT(readings.value)'], 1);
});

test('SUM/AVG skip nulls; all-null bucket SUM === null (not 0)', () => {
  const s = scenario('sum_avg_skip_nulls');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  // direct: SUM over [null,null] === null; AVG divides by non-null count
  assert.equal(E.aggregate([{ v: null }, { v: null }], 'SUM', 'v'), null);
  assert.equal(E.aggregate([], 'SUM', 'v'), null);
  assert.equal(E.aggregate([{ v: 4 }, { v: null }, { v: 8 }], 'AVG', 'v'), 6); // (4+8)/2
  assert.equal(E.aggregate([{ v: null }], 'AVG', 'v'), null);
  assert.equal(E.aggregate([{ v: 3 }, { v: null }], 'COUNT', 'v'), 1);
  assert.equal(E.aggregate([{ v: 3 }, { v: null }], 'COUNT_STAR', null), 2);
});

test('scenario 10: LEFT-join-then-count orphan shows 0 with COUNT(order_id)', () => {
  const s = scenario('left_count_orphan');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  const orphans = res.filter((r) => r['agg.COUNT(orders.order_id)'] === 0);
  assert.equal(orphans.length, 3); // Devi, Esa, Faye each 0
});

/* ============================================================
   10. Join-then-SUM inflation (scenario 11 exact numbers)
   ============================================================ */
test('scenario 11: 1-many join inflates SUM(price) to 830, true is 410', () => {
  const s = scenario('join_inflates_sum');
  const res = E.evaluate(s.op, tablesFor(s));
  assert.deepStrictEqual(res, s.expected);
  assert.equal(res[0]['agg.SUM(sku_prices.price)'], 830);
  // the true, un-inflated figure: distinct matched price rows A/100, A/110, B/200
  assert.equal(s.trueFigure, 410);
  assert.notEqual(res[0]['agg.SUM(sku_prices.price)'], s.trueFigure);
  // base-table SUM(price) over all price rows (100+110+200+300+400)
  const baseSum = tablesFor(s).left.rows.reduce((a, r) => a + r[1], 0);
  assert.equal(baseSum, 1110);
  assert.notEqual(res[0]['agg.SUM(sku_prices.price)'], baseSum);
});

/* ============================================================
   11. Corpus gate: ALL 12 scenarios deep-equal expected
   ============================================================ */
test('corpus gate: every gotcha scenario evaluates to its expected rows', () => {
  assert.equal(SCENARIOS.length, 12);
  for (const s of SCENARIOS) {
    const res = E.evaluate(s.op, tablesFor(s));
    assert.deepStrictEqual(res, s.expected, 'scenario ' + s.id);
  }
});

/* ============================================================
   12. Corpus invariants
   ============================================================ */
test('corpus invariants: pairs well-formed, row caps, unique ids', () => {
  assert.equal(PAIRS.length, 4);
  const pairIds = new Set();
  let totalRows = 0;
  for (const p of PAIRS) {
    assert.ok(!pairIds.has(p.id), 'dup pair id ' + p.id);
    pairIds.add(p.id);
    for (const side of [p.left, p.right]) {
      assert.ok(side.rows.length <= 8, side.name + ' exceeds 8-row cap');
      assert.ok(side.cols.some((c) => c.name === side.keyCol), 'keyCol not a column: ' + side.name);
      for (const row of side.rows) assert.equal(row.length, side.cols.length);
      totalRows += side.rows.length;
    }
  }
  // brief: ~44 rows total
  assert.equal(totalRows, 44);

  const scenIds = new Set();
  for (const s of SCENARIOS) {
    assert.ok(!scenIds.has(s.id), 'dup scenario id ' + s.id);
    scenIds.add(s.id);
    assert.ok(pairIds.has(s.pairId), 'scenario points at missing pair: ' + s.id);
    assert.ok(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'].includes(s.op.type));
    assert.ok(s.explain.split(/\s+/).length <= 50, 'explain > 50 words: ' + s.id);
    assert.equal(typeof s.vennLies, 'boolean');
    assert.ok(typeof s.sql === 'string' && s.sql.length > 0);
  }
});

test('vennBlowup fires exactly when output exceeds max(|L|,|R|)', () => {
  // sku INNER blowup (7 > max(5,5)) -> true
  const s1 = scenario('inner_blowup');
  assert.equal(E.vennBlowup(E.rowMath(s1.op, tablesFor(s1))), true);
  // customers LEFT (9 rows, but max(6,7)=7, 9>7) -> true (fan-out)
  const s2 = scenario('left_padding');
  assert.equal(E.vennBlowup(E.rowMath(s2.op, tablesFor(s2))), true);
  // sensors INNER (3 rows <= max(5,6)) -> false
  const s6 = scenario('null_never_matches');
  assert.equal(E.vennBlowup(E.rowMath(s6.op, tablesFor(s6))), false);
});

/* ============================================================
   13. Determinism + CSV RFC-4180 round-trip
   ============================================================ */
test('determinism: evaluating every scenario twice is byte-identical', () => {
  for (const s of SCENARIOS) {
    const a = E.evaluate(s.op, tablesFor(s));
    const b = E.evaluate(s.op, tablesFor(s));
    assert.deepStrictEqual(a, b);
  }
});

test('CSV exporter is RFC-4180: escapes quotes/commas, emits NULL token', () => {
  const rows = [
    { name: 'plain', note: null, amt: 40 },
    { name: 'has,comma', note: 'say "hi"', amt: 0 },
    { name: 'line\nbreak', note: '', amt: null }
  ];
  const csv = E.toCSV(rows);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'name,note,amt');
  assert.equal(lines[1], 'plain,NULL,40');
  assert.equal(lines[2], '"has,comma","say ""hi""",0');
  // embedded newline field is quoted -> the row spans two physical lines
  assert.ok(csv.includes('"line\nbreak"'));
  assert.ok(csv.includes(',NULL')); // trailing NULL amt
  // NULL cell distinct from empty string
  assert.equal(E.csvField(null), 'NULL');
  assert.equal(E.csvField(''), '');
});

/* ============================================================
   14. Property/fuzz test: join-length invariants hold for random tables
   ============================================================ */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: FULL length === matched + leftOrphans + rightOrphans over 3000 random tables', () => {
  const rng = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 3000; iter++) {
    const nL = 1 + Math.floor(rng() * 6);
    const nR = 1 + Math.floor(rng() * 6);
    const mkRows = (n) => {
      const rows = [];
      for (let i = 0; i < n; i++) {
        // key in a small domain so collisions + nulls are frequent
        const k = rng() < 0.25 ? null : Math.floor(rng() * 4);
        rows.push([i, k]);
      }
      return rows;
    };
    const L = { name: 'L', cols: [{ name: 'id', type: 'number' }, { name: 'k', type: 'number' }], keyCol: 'k', rows: mkRows(nL) };
    const R = { name: 'R', cols: [{ name: 'id', type: 'number' }, { name: 'k', type: 'number' }], keyCol: 'k', rows: mkRows(nR) };

    const opFull = { type: 'FULL', leftKey: 'k', rightKey: 'k', groupBy: null };
    const full = E.fullJoin(L, R, 'k', 'k');
    const m = E.rowMath(opFull, { left: L, right: R });
    assert.equal(full.length, m.matchedPairs + m.leftOrphans + m.rightOrphans);

    // INNER length === matchedPairs
    assert.equal(E.innerJoin(L, R, 'k', 'k').length, m.matchedPairs);
    // LEFT length === matched + leftOrphans; every left row appears >= once
    const left = E.leftJoin(L, R, 'k', 'k');
    assert.equal(left.length, m.matchedPairs + m.leftOrphans);
    assert.ok(left.length >= nL);
    // CROSS length === nL * nR
    assert.equal(E.crossJoin(L, R).length, nL * nR);
    // RIGHT metamorphic law holds on random tables too
    assert.deepStrictEqual(
      E.rightJoin(L, R, 'k', 'k'),
      E.columnSwap(E.leftJoin(R, L, 'k', 'k'), L, R)
    );
  }
});
