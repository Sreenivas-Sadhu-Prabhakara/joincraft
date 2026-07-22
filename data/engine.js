/* ============================================================
   joincraft — engine.js
   A hand-rolled, dependency-free join + GROUP BY evaluator.
   Pure functions only: no DOM, no globals, no network. The browser
   (app.js) and the Node self-tests both import this exact module, so
   what the tests prove is what ships.

   Contract:
   - A "table" is { name, cols:[{name,type}], keyCol, rows:[[...]] }.
   - NULL is JavaScript `null` everywhere (cells and outputs).
   - A join result is an array of row objects keyed by qualified name
     "<table>.<col>"; unmatched sides are filled with null.
   - Result rows are in deterministic TEACHING order (left row, then
     right row). Real SQL guarantees no order without ORDER BY — this
     app imposes one purely to teach.
   ============================================================ */

'use strict';

/* ---------- helpers ---------- */

// Build a row object { "table.col": value } from a raw row array.
function rowObj(table, row) {
  const o = {};
  for (let i = 0; i < table.cols.length; i++) {
    o[table.name + '.' + table.cols[i].name] = row[i];
  }
  return o;
}

// An all-null padding object for a table (used for orphan padding).
function nullObj(table) {
  const o = {};
  for (const c of table.cols) o[table.name + '.' + c.name] = null;
  return o;
}

function keyIndex(table, keyCol) {
  return table.cols.findIndex((c) => c.name === keyCol);
}

// SQL ON-equality between two key cells under three-valued logic:
// two cells match ONLY if both are non-null and strictly equal.
// NULL = anything is UNKNOWN, which is not TRUE, so it never matches.
function keysMatch(a, b) {
  if (a === null || a === undefined) return false;
  if (b === null || b === undefined) return false;
  return a === b;
}

/* ---------- the join evaluator (nested loop) ---------- */

// INNER join: emit a paired row for every (l,r) whose keys match.
function innerJoin(left, right, leftKey, rightKey) {
  const li = keyIndex(left, leftKey);
  const ri = keyIndex(right, rightKey);
  const out = [];
  for (const lrow of left.rows) {
    for (const rrow of right.rows) {
      if (keysMatch(lrow[li], rrow[ri])) {
        out.push(Object.assign({}, rowObj(left, lrow), rowObj(right, rrow)));
      }
    }
  }
  return out;
}

// LEFT join: every left row at least once; matched pairs, else null-padded.
function leftJoin(left, right, leftKey, rightKey) {
  const li = keyIndex(left, leftKey);
  const ri = keyIndex(right, rightKey);
  const rpad = nullObj(right);
  const out = [];
  for (const lrow of left.rows) {
    let matched = false;
    for (const rrow of right.rows) {
      if (keysMatch(lrow[li], rrow[ri])) {
        matched = true;
        out.push(Object.assign({}, rowObj(left, lrow), rowObj(right, rrow)));
      }
    }
    if (!matched) out.push(Object.assign({}, rowObj(left, lrow), rpad));
  }
  return out;
}

// RIGHT join === LEFT join with the tables swapped, columns re-ordered
// back to (left, right). Defined this way so the metamorphic law holds
// by construction and the test can prove it.
function rightJoin(left, right, leftKey, rightKey) {
  const swapped = leftJoin(right, left, rightKey, leftKey);
  const lpad = nullObj(left);
  const rpad = nullObj(right);
  return swapped.map((r) => Object.assign({}, lpad, rpad, r));
}

// FULL join: matched pairs (in left-row order), then left orphans,
// then right orphans. Teaching order groups the three classes.
function fullJoin(left, right, leftKey, rightKey) {
  const li = keyIndex(left, leftKey);
  const ri = keyIndex(right, rightKey);
  const lpad = nullObj(left);
  const rpad = nullObj(right);
  const matched = [];
  const leftOrphans = [];
  const matchedRight = new Set();
  for (const lrow of left.rows) {
    let hit = false;
    for (let j = 0; j < right.rows.length; j++) {
      const rrow = right.rows[j];
      if (keysMatch(lrow[li], rrow[ri])) {
        hit = true;
        matchedRight.add(j);
        matched.push(Object.assign({}, rowObj(left, lrow), rowObj(right, rrow)));
      }
    }
    if (!hit) leftOrphans.push(Object.assign({}, rowObj(left, lrow), rpad));
  }
  const rightOrphans = [];
  for (let j = 0; j < right.rows.length; j++) {
    if (!matchedRight.has(j)) {
      rightOrphans.push(Object.assign({}, lpad, rowObj(right, right.rows[j])));
    }
  }
  return matched.concat(leftOrphans, rightOrphans);
}

// CROSS join: every ordered (l,r) pair; keys ignored entirely.
function crossJoin(left, right) {
  const out = [];
  for (const lrow of left.rows) {
    for (const rrow of right.rows) {
      out.push(Object.assign({}, rowObj(left, lrow), rowObj(right, rrow)));
    }
  }
  return out;
}

// Dispatch a join by op.type.
function joinOnly(op, left, right) {
  switch (op.type) {
    case 'INNER': return innerJoin(left, right, op.leftKey, op.rightKey);
    case 'LEFT': return leftJoin(left, right, op.leftKey, op.rightKey);
    case 'RIGHT': return rightJoin(left, right, op.leftKey, op.rightKey);
    case 'FULL': return fullJoin(left, right, op.leftKey, op.rightKey);
    case 'CROSS': return crossJoin(left, right);
    default: throw new Error('unknown join type: ' + op.type);
  }
}

// Column-swap a (left,right)-keyed result so left/right column groups
// exchange places — used to state the RIGHT ≡ swapped-LEFT law.
function columnSwap(rows, left, right) {
  return rows.map((r) => {
    const o = {};
    for (const c of left.cols) o[left.name + '.' + c.name] = r[left.name + '.' + c.name];
    for (const c of right.cols) o[right.name + '.' + c.name] = r[right.name + '.' + c.name];
    return o;
  });
}

/* ---------- GROUP BY + aggregates ---------- */

// Aggregate a set of rows for one bin. Returns the scalar aggregate value.
// SQL NULL rules: COUNT(*) counts rows; COUNT(col)/SUM/AVG/MIN/MAX skip
// nulls; SUM/AVG/MIN/MAX over an all-null (or empty) set === null.
function aggregate(rows, agg, aggCol) {
  if (agg === 'COUNT_STAR') return rows.length;

  const vals = rows
    .map((r) => r[aggCol])
    .filter((v) => v !== null && v !== undefined);

  switch (agg) {
    case 'COUNT':
      return vals.length;
    case 'SUM':
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0);
    case 'AVG':
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    case 'MIN':
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => (b < a ? b : a));
    case 'MAX':
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => (b > a ? b : a));
    default:
      throw new Error('unknown aggregate: ' + agg);
  }
}

function aggLabel(agg, aggCol) {
  if (agg === 'COUNT_STAR') return 'COUNT(*)';
  return agg + '(' + aggCol + ')';
}

// GROUP BY over a join result.
//   groupBy = { col, agg, aggCol }
//   col === null  -> a single grand-total bucket (no group key column).
// Buckets appear in first-seen order over the (teaching-ordered) rows.
// All NULL group-keys collapse into ONE bucket (unlike ON equality).
function groupBy(rows, gb) {
  const label = aggLabel(gb.agg, gb.aggCol);

  if (gb.col === null || gb.col === undefined) {
    return [{ ['agg.' + label]: aggregate(rows, gb.agg, gb.aggCol) }];
  }

  const order = [];          // group-key values in first-seen order
  const seenNull = { hit: false };
  const bins = new Map();    // non-null key -> rows[]
  let nullBin = null;        // rows[] for the single NULL bucket

  for (const r of rows) {
    const k = r[gb.col];
    if (k === null || k === undefined) {
      if (!seenNull.hit) { seenNull.hit = true; order.push({ null: true }); nullBin = []; }
      nullBin.push(r);
    } else {
      if (!bins.has(k)) { bins.set(k, []); order.push({ key: k }); }
      bins.get(k).push(r);
    }
  }

  return order.map((slot) => {
    const bucketRows = slot.null ? nullBin : bins.get(slot.key);
    return {
      ['group.' + gb.col]: slot.null ? null : slot.key,
      ['agg.' + label]: aggregate(bucketRows, gb.agg, gb.aggCol)
    };
  });
}

/* ---------- top-level evaluate ---------- */

// evaluate(op, {left, right}) -> result rows.
// If op.groupBy is set, returns the grouped/aggregated rows; otherwise
// the raw join rows in teaching order.
function evaluate(op, tables) {
  const joined = joinOnly(op, tables.left, tables.right);
  if (op.groupBy) return groupBy(joined, op.groupBy);
  return joined;
}

/* ---------- row-math counters ---------- */

// Counter strip figures for a plain (non-grouped) join.
function rowMath(op, tables) {
  const left = tables.left;
  const right = tables.right;
  const L = left.rows.length;
  const R = right.rows.length;

  if (op.type === 'CROSS') {
    return { L, R, matchedPairs: L * R, leftOrphans: 0, rightOrphans: 0, outputRows: L * R };
  }

  const li = keyIndex(left, op.leftKey);
  const ri = keyIndex(right, op.rightKey);
  let matchedPairs = 0;
  const leftMatched = new Set();
  const rightMatched = new Set();
  for (let a = 0; a < left.rows.length; a++) {
    for (let b = 0; b < right.rows.length; b++) {
      if (keysMatch(left.rows[a][li], right.rows[b][ri])) {
        matchedPairs++;
        leftMatched.add(a);
        rightMatched.add(b);
      }
    }
  }
  const leftOrphans = L - leftMatched.size;
  const rightOrphans = R - rightMatched.size;

  let outputRows;
  switch (op.type) {
    case 'INNER': outputRows = matchedPairs; break;
    case 'LEFT': outputRows = matchedPairs + leftOrphans; break;
    case 'RIGHT': outputRows = matchedPairs + rightOrphans; break;
    case 'FULL': outputRows = matchedPairs + leftOrphans + rightOrphans; break;
    default: outputRows = matchedPairs;
  }
  return { L, R, matchedPairs, leftOrphans, rightOrphans, outputRows };
}

// The "a Venn diagram cannot draw this" fact: output exceeds max(|L|,|R|).
function vennBlowup(math) {
  return math.outputRows > Math.max(math.L, math.R);
}

/* ---------- three-valued logic ---------- */

// eval3(a, op, b) for the truth-table corpus. Operands are the string
// tokens the corpus uses: 'TRUE' | 'FALSE' | 'UNKNOWN' | 'NULL' | a literal.
// Returns 'TRUE' | 'FALSE' | 'UNKNOWN'.
function eval3(a, op, b) {
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
  const NOT = { TRUE: 'FALSE', FALSE: 'TRUE', UNKNOWN: 'UNKNOWN' };

  const isNull = (x) => x === null || x === undefined || x === 'NULL';

  switch (op) {
    case 'AND': return AND[a][b];
    case 'OR': return OR[a][b];
    case 'NOT': return NOT[a];
    case 'IS NULL': return isNull(a) ? 'TRUE' : 'FALSE';
    case 'IS NOT NULL': return isNull(a) ? 'FALSE' : 'TRUE';
    case '=':
    case '<>':
    case '<':
    case '>':
    case '<=':
    case '>=': {
      if (isNull(a) || isNull(b)) return 'UNKNOWN';
      const x = Number(a), y = Number(b);
      let r;
      if (op === '=') r = x === y;
      else if (op === '<>') r = x !== y;
      else if (op === '<') r = x < y;
      else if (op === '>') r = x > y;
      else if (op === '<=') r = x <= y;
      else r = x >= y;
      return r ? 'TRUE' : 'FALSE';
    }
    default:
      throw new Error('unknown 3VL op: ' + op);
  }
}

/* ---------- CSV export (RFC 4180) ---------- */

// Escape one field per RFC 4180: wrap in double-quotes and double any
// embedded quote if the field contains a comma, quote, CR or LF.
// NULL cells are emitted as the literal token "NULL" (unquoted) so a
// re-import can distinguish an empty string from a NULL.
function csvField(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Serialize an array of row objects to an RFC-4180 CSV string (CRLF rows).
// Header is the union of keys in first-row order.
function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvField(r[h])).join(','));
  }
  return lines.join('\r\n');
}

/* ---------- exports ---------- */

const ENGINE = {
  keysMatch,
  innerJoin,
  leftJoin,
  rightJoin,
  fullJoin,
  crossJoin,
  joinOnly,
  columnSwap,
  aggregate,
  aggLabel,
  groupBy,
  evaluate,
  rowMath,
  vennBlowup,
  eval3,
  csvField,
  toCSV,
  rowObj,
  nullObj,
  keyIndex
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ENGINE;
}
if (typeof window !== 'undefined') {
  window.JOINCRAFT_ENGINE = ENGINE;
}
