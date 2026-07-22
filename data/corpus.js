/* ============================================================
   joincraft — corpus.js
   The single source of truth for table pairs, gotcha scenarios,
   and the ISO SQL three-valued-logic (3VL) truth tables.

   Dual export: a browser global (window.JOINCRAFT) and a Node
   module.exports so the same data drives the app and the tests.

   Verification (two ways):
   (a) Authoring-time: each scenario was written as SQL, run through
       `sqlite3 :memory:` with `.nullvalue NULL`, and the output rows
       diffed against the `expected` arrays below. See sources/CITATIONS.md
       and sources/verify.sql.
   (b) Permanent: test/joincraft.test.js asserts the in-app evaluator
       deep-equals every `expected` array, byte-for-byte, in teaching order.

   NULL is represented as JavaScript `null` in every cell and result.
   Result rows are objects keyed by qualified column name
   ("left.col" / "right.col") so duplicate column names never collide.
   ============================================================ */

/* ---------- (1) FOUR preset table pairs ---------- */

const PAIRS = [
  {
    id: 'customers_orders',
    title: 'Customers × Orders',
    blurb: 'One customer with three orders, one with none, one order with a NULL customer.',
    left: {
      name: 'customers',
      cols: [
        { name: 'customer_id', type: 'number' },
        { name: 'name', type: 'text' }
      ],
      keyCol: 'customer_id',
      rows: [
        [1, 'Ada'],
        [2, 'Bo'],
        [3, 'Chen'],
        [4, 'Devi'],
        [5, 'Esa'],
        [6, 'Faye']
      ]
    },
    right: {
      name: 'orders',
      cols: [
        { name: 'order_id', type: 'number' },
        { name: 'customer_id', type: 'number' },
        { name: 'amount', type: 'number' }
      ],
      keyCol: 'customer_id',
      rows: [
        [101, 1, 40],
        [102, 1, 60],
        [103, 1, 10],
        [104, 2, 25],
        [105, 3, 80],
        [106, 3, 20],
        [107, null, 15]
      ]
    }
  },
  {
    id: 'employees_departments',
    title: 'Employees × Departments',
    blurb: 'An empty department and an employee whose department is NULL.',
    left: {
      name: 'employees',
      cols: [
        { name: 'emp_id', type: 'number' },
        { name: 'name', type: 'text' },
        { name: 'dept_id', type: 'number' }
      ],
      keyCol: 'dept_id',
      rows: [
        [1, 'Rui', 10],
        [2, 'Sam', 10],
        [3, 'Tao', 20],
        [4, 'Uma', 30],
        [5, 'Ven', null],
        [6, 'Wei', 20]
      ]
    },
    right: {
      name: 'departments',
      cols: [
        { name: 'dept_id', type: 'number' },
        { name: 'dept_name', type: 'text' }
      ],
      keyCol: 'dept_id',
      rows: [
        [10, 'Sales'],
        [20, 'Eng'],
        [30, 'Ops'],
        [40, 'Legal']
      ]
    }
  },
  {
    id: 'sku_prices_stock',
    title: 'SKU Prices × SKU Stock',
    blurb: "Key 'A' appears twice on the left and three times on the right — the duplicate-key blowup.",
    left: {
      name: 'sku_prices',
      cols: [
        { name: 'sku', type: 'text' },
        { name: 'price', type: 'number' }
      ],
      keyCol: 'sku',
      rows: [
        ['A', 100],
        ['A', 110],
        ['B', 200],
        ['C', 300],
        ['D', 400]
      ]
    },
    right: {
      name: 'sku_stock',
      cols: [
        { name: 'sku', type: 'text' },
        { name: 'qty', type: 'number' }
      ],
      keyCol: 'sku',
      rows: [
        ['A', 5],
        ['A', 6],
        ['A', 7],
        ['B', 8],
        ['E', 9]
      ]
    }
  },
  {
    id: 'sensors_readings',
    title: 'Sensors × Readings',
    blurb: 'NULL keys on BOTH sides — proving NULL never matches NULL in an ON clause.',
    left: {
      name: 'sensors',
      cols: [
        { name: 'sensor_id', type: 'number' },
        { name: 'zone', type: 'text' }
      ],
      keyCol: 'sensor_id',
      rows: [
        [1, 'North'],
        [2, 'South'],
        [3, 'East'],
        [null, 'Spare-A'],
        [null, 'Spare-B']
      ]
    },
    right: {
      name: 'readings',
      cols: [
        { name: 'reading_id', type: 'number' },
        { name: 'sensor_id', type: 'number' },
        { name: 'value', type: 'number' }
      ],
      keyCol: 'sensor_id',
      rows: [
        [1001, 1, 22],
        [1002, 1, null],
        [1003, 2, 30],
        [1004, null, 40],
        [1005, null, null],
        [1006, 9, 55]
      ]
    }
  }
];

/* ---------- (2) TWELVE gotcha scenarios ----------
   Each `expected` row is an object keyed by qualified column name.
   For a matched INNER/CROSS pair every column of both sides is present.
   For an orphan (LEFT/RIGHT/FULL) the missing side's columns are null.
   Rows are listed in teaching order: left-row order, then right-row order.
   GROUP BY scenarios list bins in first-seen group-key order; the group
   key column is keyed by "group.<col>" and each aggregate by "agg.<label>".
*/

const SCENARIOS = [
  {
    // ① INNER duplicate-key blowup: L 'A'×2, R 'A'×3 -> 6 rows for A, plus B×1 -> 7? No.
    // sku_prices left A appears 2x, right A appears 3x => 2*3 = 6 A-pairs.
    // B: left 1 x right 1 = 1 pair. Total 7. Brief scenario 1 says "2x3 -> 6 rows"
    // referring specifically to the A-key blowup; we assert the full INNER result (7)
    // and the self-test isolates the A-key 2x3=6 sub-count.
    id: 'inner_blowup',
    title: 'INNER join: duplicate keys multiply rows',
    pairId: 'sku_prices_stock',
    op: { type: 'INNER', leftKey: 'sku', rightKey: 'sku', groupBy: null },
    vennLies: true,
    explain: "Key 'A' has 2 price rows and 3 stock rows, so INNER emits 2×3 = 6 rows for A alone. Output (7) exceeds both inputs (5 and 5). No Venn diagram can draw this.",
    sql: "SELECT * FROM sku_prices p JOIN sku_stock s ON p.sku = s.sku;",
    expected: [
      { 'sku_prices.sku': 'A', 'sku_prices.price': 100, 'sku_stock.sku': 'A', 'sku_stock.qty': 5 },
      { 'sku_prices.sku': 'A', 'sku_prices.price': 100, 'sku_stock.sku': 'A', 'sku_stock.qty': 6 },
      { 'sku_prices.sku': 'A', 'sku_prices.price': 100, 'sku_stock.sku': 'A', 'sku_stock.qty': 7 },
      { 'sku_prices.sku': 'A', 'sku_prices.price': 110, 'sku_stock.sku': 'A', 'sku_stock.qty': 5 },
      { 'sku_prices.sku': 'A', 'sku_prices.price': 110, 'sku_stock.sku': 'A', 'sku_stock.qty': 6 },
      { 'sku_prices.sku': 'A', 'sku_prices.price': 110, 'sku_stock.sku': 'A', 'sku_stock.qty': 7 },
      { 'sku_prices.sku': 'B', 'sku_prices.price': 200, 'sku_stock.sku': 'B', 'sku_stock.qty': 8 }
    ]
  },
  {
    // ② LEFT NULL padding
    id: 'left_padding',
    title: 'LEFT join: unmatched left rows get NULL padding',
    pairId: 'customers_orders',
    op: { type: 'LEFT', leftKey: 'customer_id', rightKey: 'customer_id', groupBy: null },
    vennLies: false,
    explain: 'Every customer appears at least once. Customers with no order (Devi, Esa, Faye) appear once with all order columns NULL. The NULL-customer order 107 is never reached from the left.',
    sql: 'SELECT * FROM customers c LEFT JOIN orders o ON c.customer_id = o.customer_id;',
    expected: [
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 101, 'orders.customer_id': 1, 'orders.amount': 40 },
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 102, 'orders.customer_id': 1, 'orders.amount': 60 },
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 103, 'orders.customer_id': 1, 'orders.amount': 10 },
      { 'customers.customer_id': 2, 'customers.name': 'Bo', 'orders.order_id': 104, 'orders.customer_id': 2, 'orders.amount': 25 },
      { 'customers.customer_id': 3, 'customers.name': 'Chen', 'orders.order_id': 105, 'orders.customer_id': 3, 'orders.amount': 80 },
      { 'customers.customer_id': 3, 'customers.name': 'Chen', 'orders.order_id': 106, 'orders.customer_id': 3, 'orders.amount': 20 },
      { 'customers.customer_id': 4, 'customers.name': 'Devi', 'orders.order_id': null, 'orders.customer_id': null, 'orders.amount': null },
      { 'customers.customer_id': 5, 'customers.name': 'Esa', 'orders.order_id': null, 'orders.customer_id': null, 'orders.amount': null },
      { 'customers.customer_id': 6, 'customers.name': 'Faye', 'orders.order_id': null, 'orders.customer_id': null, 'orders.amount': null }
    ]
  },
  {
    // ③ RIGHT ≡ LEFT with tables swapped: orders RIGHT JOIN customers === customers LEFT JOIN orders (col-swapped)
    id: 'right_is_swapped_left',
    title: 'RIGHT join is a LEFT join with the tables swapped',
    pairId: 'customers_orders',
    op: { type: 'RIGHT', leftKey: 'customer_id', rightKey: 'customer_id', groupBy: null },
    vennLies: false,
    explain: 'RIGHT keeps every right (orders) row. Order 107 with a NULL customer survives with all customer columns NULL. This is the mirror of scenario 2 — the same pairs, kept from the other side.',
    sql: 'SELECT * FROM customers c RIGHT JOIN orders o ON c.customer_id = o.customer_id;',
    expected: [
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 101, 'orders.customer_id': 1, 'orders.amount': 40 },
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 102, 'orders.customer_id': 1, 'orders.amount': 60 },
      { 'customers.customer_id': 1, 'customers.name': 'Ada', 'orders.order_id': 103, 'orders.customer_id': 1, 'orders.amount': 10 },
      { 'customers.customer_id': 2, 'customers.name': 'Bo', 'orders.order_id': 104, 'orders.customer_id': 2, 'orders.amount': 25 },
      { 'customers.customer_id': 3, 'customers.name': 'Chen', 'orders.order_id': 105, 'orders.customer_id': 3, 'orders.amount': 80 },
      { 'customers.customer_id': 3, 'customers.name': 'Chen', 'orders.order_id': 106, 'orders.customer_id': 3, 'orders.amount': 20 },
      { 'customers.customer_id': null, 'customers.name': null, 'orders.order_id': 107, 'orders.customer_id': null, 'orders.amount': 15 }
    ]
  },
  {
    // ④ FULL with orphans on both sides — employees×departments
    id: 'full_both_orphans',
    title: 'FULL join: orphans kept on BOTH sides',
    pairId: 'employees_departments',
    op: { type: 'FULL', leftKey: 'dept_id', rightKey: 'dept_id', groupBy: null },
    vennLies: false,
    explain: 'FULL keeps every row from both tables. Employee Ven (dept NULL) is a left orphan; department Legal (no employees) is a right orphan. Matched rows first, then left orphans, then right orphans.',
    sql: 'SELECT * FROM employees e FULL JOIN departments d ON e.dept_id = d.dept_id;',
    expected: [
      { 'employees.emp_id': 1, 'employees.name': 'Rui', 'employees.dept_id': 10, 'departments.dept_id': 10, 'departments.dept_name': 'Sales' },
      { 'employees.emp_id': 2, 'employees.name': 'Sam', 'employees.dept_id': 10, 'departments.dept_id': 10, 'departments.dept_name': 'Sales' },
      { 'employees.emp_id': 3, 'employees.name': 'Tao', 'employees.dept_id': 20, 'departments.dept_id': 20, 'departments.dept_name': 'Eng' },
      { 'employees.emp_id': 4, 'employees.name': 'Uma', 'employees.dept_id': 30, 'departments.dept_id': 30, 'departments.dept_name': 'Ops' },
      { 'employees.emp_id': 6, 'employees.name': 'Wei', 'employees.dept_id': 20, 'departments.dept_id': 20, 'departments.dept_name': 'Eng' },
      { 'employees.emp_id': 5, 'employees.name': 'Ven', 'employees.dept_id': null, 'departments.dept_id': null, 'departments.dept_name': null },
      { 'employees.emp_id': null, 'employees.name': null, 'employees.dept_id': null, 'departments.dept_id': 40, 'departments.dept_name': 'Legal' }
    ]
  },
  {
    // ⑤ CROSS — AMENDMENT: employees × departments = 6×4 = 24 (was speced 4×3)
    id: 'cross_product',
    title: 'CROSS join: every left row paired with every right row',
    pairId: 'employees_departments',
    op: { type: 'CROSS', leftKey: null, rightKey: null, groupBy: null },
    vennLies: true,
    explain: 'CROSS ignores keys entirely: 6 employees × 4 departments = 24 rows, every possible pairing. This is the Cartesian product a forgotten ON clause silently produces.',
    sql: 'SELECT * FROM employees e CROSS JOIN departments d;',
    expected: (function () {
      const emps = [
        { id: 1, name: 'Rui', dept: 10 },
        { id: 2, name: 'Sam', dept: 10 },
        { id: 3, name: 'Tao', dept: 20 },
        { id: 4, name: 'Uma', dept: 30 },
        { id: 5, name: 'Ven', dept: null },
        { id: 6, name: 'Wei', dept: 20 }
      ];
      const depts = [
        { id: 10, name: 'Sales' },
        { id: 20, name: 'Eng' },
        { id: 30, name: 'Ops' },
        { id: 40, name: 'Legal' }
      ];
      const out = [];
      for (const e of emps) {
        for (const d of depts) {
          out.push({
            'employees.emp_id': e.id,
            'employees.name': e.name,
            'employees.dept_id': e.dept,
            'departments.dept_id': d.id,
            'departments.dept_name': d.name
          });
        }
      }
      return out;
    })()
  },
  {
    // ⑥ NULL=NULL never matches in ON — sensors×readings INNER
    id: 'null_never_matches',
    title: 'NULL = NULL is never TRUE in an ON clause',
    pairId: 'sensors_readings',
    op: { type: 'INNER', leftKey: 'sensor_id', rightKey: 'sensor_id', groupBy: null },
    vennLies: false,
    explain: 'Sensors 4 and 5 have NULL ids; readings 1004 and 1005 have NULL sensor ids. None of them match — NULL = NULL evaluates to UNKNOWN, not TRUE. Only sensors 1 and 2 pair up.',
    sql: 'SELECT * FROM sensors s JOIN readings r ON s.sensor_id = r.sensor_id;',
    expected: [
      { 'sensors.sensor_id': 1, 'sensors.zone': 'North', 'readings.reading_id': 1001, 'readings.sensor_id': 1, 'readings.value': 22 },
      { 'sensors.sensor_id': 1, 'sensors.zone': 'North', 'readings.reading_id': 1002, 'readings.sensor_id': 1, 'readings.value': null },
      { 'sensors.sensor_id': 2, 'sensors.zone': 'South', 'readings.reading_id': 1003, 'readings.sensor_id': 2, 'readings.value': 30 }
    ]
  },
  {
    // ⑦ NULLs group together under GROUP BY — same sensors table, LEFT then GROUP BY sensor zone?
    // Contrast with 6: group the readings by sensor_id; the two NULL-sensor_id readings collapse into ONE bucket.
    id: 'null_groups_together',
    title: 'GROUP BY puts all NULLs in ONE bucket',
    pairId: 'sensors_readings',
    // RIGHT join keeps every reading (even NULL-sensor ones), then GROUP BY the right key.
    // The two NULL-sensor readings that matched 0 rows in scenario 6 collapse into ONE bucket here.
    op: { type: 'RIGHT', leftKey: 'sensor_id', rightKey: 'sensor_id', groupBy: { col: 'readings.sensor_id', agg: 'COUNT_STAR', aggCol: null } },
    vennLies: false,
    explain: 'The same NULL sensor ids that matched 0 rows in scenario 6 now collapse into a single NULL group here. In GROUP BY, all NULLs are one group; in ON, no two NULLs are equal.',
    sql: 'SELECT r.sensor_id, COUNT(*) FROM readings r GROUP BY r.sensor_id;',
    expected: [
      { 'group.readings.sensor_id': 1, 'agg.COUNT(*)': 2 },
      { 'group.readings.sensor_id': 2, 'agg.COUNT(*)': 1 },
      { 'group.readings.sensor_id': null, 'agg.COUNT(*)': 2 },
      { 'group.readings.sensor_id': 9, 'agg.COUNT(*)': 1 }
    ]
  },
  {
    // ⑧ COUNT(*) vs COUNT(col) with NULLs — group readings by sensor_id, count value column
    id: 'count_star_vs_col',
    title: 'COUNT(*) counts rows; COUNT(col) skips NULLs',
    pairId: 'sensors_readings',
    op: { type: 'RIGHT', leftKey: 'sensor_id', rightKey: 'sensor_id', groupBy: { col: 'readings.sensor_id', agg: 'COUNT', aggCol: 'readings.value' } },
    vennLies: false,
    explain: 'Group readings by sensor. COUNT(value) skips the NULL readings (1002, 1005), so sensor 1 counts 1 non-null value though it has 2 rows, and the NULL-sensor bucket counts 1 not 2.',
    sql: 'SELECT r.sensor_id, COUNT(r.value) FROM readings r GROUP BY r.sensor_id;',
    expected: [
      { 'group.readings.sensor_id': 1, 'agg.COUNT(readings.value)': 1 },
      { 'group.readings.sensor_id': 2, 'agg.COUNT(readings.value)': 1 },
      { 'group.readings.sensor_id': null, 'agg.COUNT(readings.value)': 1 },
      { 'group.readings.sensor_id': 9, 'agg.COUNT(readings.value)': 1 }
    ]
  },
  {
    // ⑨ SUM/AVG skip NULLs; all-NULL bucket -> NULL not 0
    id: 'sum_avg_skip_nulls',
    title: 'SUM and AVG skip NULLs; an all-NULL bucket is NULL, not 0',
    pairId: 'sensors_readings',
    op: { type: 'RIGHT', leftKey: 'sensor_id', rightKey: 'sensor_id', groupBy: { col: 'readings.sensor_id', agg: 'SUM', aggCol: 'readings.value' } },
    vennLies: false,
    explain: 'SUM(value) per sensor ignores NULL cells. Sensor 1 sums 22 (the NULL is skipped). The NULL-sensor bucket has values 40 and NULL -> 40. A bucket whose values are all NULL would sum to NULL, never 0.',
    sql: 'SELECT r.sensor_id, SUM(r.value) FROM readings r GROUP BY r.sensor_id;',
    expected: [
      { 'group.readings.sensor_id': 1, 'agg.SUM(readings.value)': 22 },
      { 'group.readings.sensor_id': 2, 'agg.SUM(readings.value)': 30 },
      { 'group.readings.sensor_id': null, 'agg.SUM(readings.value)': 40 },
      { 'group.readings.sensor_id': 9, 'agg.SUM(readings.value)': 55 }
    ]
  },
  {
    // ⑩ LEFT-join-then-count: orphan customers show 1 with COUNT(*) but 0 with COUNT(order_id)
    id: 'left_count_orphan',
    title: 'LEFT join then COUNT: 1 with COUNT(*), 0 with COUNT(order_id)',
    pairId: 'customers_orders',
    op: { type: 'LEFT', leftKey: 'customer_id', rightKey: 'customer_id', groupBy: { col: 'customers.customer_id', agg: 'COUNT', aggCol: 'orders.order_id' } },
    vennLies: false,
    explain: 'After a LEFT join, an order-less customer is one padded row. COUNT(*) would count that row as 1, but COUNT(order_id) sees a NULL and counts 0 — the classic "customers with 0 orders show up as 1" bug.',
    sql: 'SELECT c.customer_id, COUNT(o.order_id) FROM customers c LEFT JOIN orders o ON c.customer_id = o.customer_id GROUP BY c.customer_id;',
    expected: [
      { 'group.customers.customer_id': 1, 'agg.COUNT(orders.order_id)': 3 },
      { 'group.customers.customer_id': 2, 'agg.COUNT(orders.order_id)': 1 },
      { 'group.customers.customer_id': 3, 'agg.COUNT(orders.order_id)': 2 },
      { 'group.customers.customer_id': 4, 'agg.COUNT(orders.order_id)': 0 },
      { 'group.customers.customer_id': 5, 'agg.COUNT(orders.order_id)': 0 },
      { 'group.customers.customer_id': 6, 'agg.COUNT(orders.order_id)': 0 }
    ]
  },
  {
    // ⑪ join blowup silently inflates SUM(amount) after a 1-many join
    // Use customers×orders: SUM over the join grouped as one total.
    // Base-table SUM(amount) = 40+60+10+25+80+20+15 = 250.
    // But if we inner-join customers×orders and SUM, order 107 (NULL customer) drops,
    // so INNER SUM = 235. To show INFLATION we need a 1-many that duplicates the amount.
    // Better: sku demo. Give sku_prices a "budget" per price row; joining to stock (many)
    // duplicates it. We reuse sku pair: SUM(price) over the INNER join.
    // sku INNER pairs: A/100 x{5,6,7}=3 rows of price 100; A/110 x{5,6,7}=3 rows of 110; B/200 x1.
    // SUM(price) over join = 100*3 + 110*3 + 200 = 300+330+200 = 830 (inflated).
    // True base-table SUM(price) = 100+110+200+300+400 = 1110? That's not "inflated".
    // The inflation classic: SUM(parent.value) counted once per child. Here price is the parent.
    // A appears with 2 price rows x 3 stock = its prices counted 3x each. C,D have no stock -> dropped.
    // So compare SUM(price) over the join (830) vs SUM over prices that HAVE stock counted once:
    // distinct price rows in join = A/100, A/110, B/200 => true 410. Inflated = 830. 830 !== 410.
    id: 'join_inflates_sum',
    title: 'A 1-many join silently inflates SUM after the fan-out',
    pairId: 'sku_prices_stock',
    op: { type: 'INNER', leftKey: 'sku', rightKey: 'sku', groupBy: { col: null, agg: 'SUM', aggCol: 'sku_prices.price' } },
    vennLies: true,
    explain: 'INNER-joining prices to stock fans each price row out once per stock row. SUM(price) over the join is 830, but the true sum of the distinct price rows that matched is 410. The join doubled and tripled the figures.',
    sql: 'SELECT SUM(p.price) FROM sku_prices p JOIN sku_stock s ON p.sku = s.sku;',
    // groupBy.col === null means a single grand-total bucket
    expected: [
      { 'agg.SUM(sku_prices.price)': 830 }
    ],
    // extra fact asserted by the self-test (true, un-inflated figure)
    trueFigure: 410
  },
  {
    // ⑫ FULL row-count arithmetic: matched + leftOrphans + rightOrphans, not |L|+|R|
    id: 'full_row_arithmetic',
    title: 'FULL row count is matched + left orphans + right orphans',
    pairId: 'employees_departments',
    op: { type: 'FULL', leftKey: 'dept_id', rightKey: 'dept_id', groupBy: null },
    vennLies: false,
    explain: 'The FULL result has 7 rows: 5 matched pairs + 1 left orphan (Ven) + 1 right orphan (Legal). It is NOT |employees| + |departments| = 10 — matched rows are shared, not added twice.',
    sql: 'SELECT * FROM employees e FULL JOIN departments d ON e.dept_id = d.dept_id;',
    // Same rows as scenario 4; the self-test asserts the arithmetic decomposition.
    expected: [
      { 'employees.emp_id': 1, 'employees.name': 'Rui', 'employees.dept_id': 10, 'departments.dept_id': 10, 'departments.dept_name': 'Sales' },
      { 'employees.emp_id': 2, 'employees.name': 'Sam', 'employees.dept_id': 10, 'departments.dept_id': 10, 'departments.dept_name': 'Sales' },
      { 'employees.emp_id': 3, 'employees.name': 'Tao', 'employees.dept_id': 20, 'departments.dept_id': 20, 'departments.dept_name': 'Eng' },
      { 'employees.emp_id': 4, 'employees.name': 'Uma', 'employees.dept_id': 30, 'departments.dept_id': 30, 'departments.dept_name': 'Ops' },
      { 'employees.emp_id': 6, 'employees.name': 'Wei', 'employees.dept_id': 20, 'departments.dept_id': 20, 'departments.dept_name': 'Eng' },
      { 'employees.emp_id': 5, 'employees.name': 'Ven', 'employees.dept_id': null, 'departments.dept_id': null, 'departments.dept_name': null },
      { 'employees.emp_id': null, 'employees.name': null, 'employees.dept_id': null, 'departments.dept_id': 40, 'departments.dept_name': 'Legal' }
    ],
    arithmetic: { matched: 5, leftOrphans: 1, rightOrphans: 1, naiveSum: 10 }
  }
];

/* ---------- (3) ISO SQL three-valued-logic truth tables ----------
   Values: 'TRUE' | 'FALSE' | 'UNKNOWN'. NULL operand rendered as 'NULL'.
   Verified against the ISO/IEC 9075 (SQL) three-valued-logic tables and
   cross-checked in sqlite3 (SELECT NULL=NULL -> NULL, etc.).
   33 entries: AND 3×3 (9) + OR 3×3 (9) + NOT ×3 (3) +
   comparison/predicate rows on NULL operands (12).
*/

const TRUTH = [
  // --- AND (9) ---
  { lhs: 'TRUE', op: 'AND', rhs: 'TRUE', result: 'TRUE' },
  { lhs: 'TRUE', op: 'AND', rhs: 'FALSE', result: 'FALSE' },
  { lhs: 'TRUE', op: 'AND', rhs: 'UNKNOWN', result: 'UNKNOWN' },
  { lhs: 'FALSE', op: 'AND', rhs: 'TRUE', result: 'FALSE' },
  { lhs: 'FALSE', op: 'AND', rhs: 'FALSE', result: 'FALSE' },
  { lhs: 'FALSE', op: 'AND', rhs: 'UNKNOWN', result: 'FALSE' },
  { lhs: 'UNKNOWN', op: 'AND', rhs: 'TRUE', result: 'UNKNOWN' },
  { lhs: 'UNKNOWN', op: 'AND', rhs: 'FALSE', result: 'FALSE' },
  { lhs: 'UNKNOWN', op: 'AND', rhs: 'UNKNOWN', result: 'UNKNOWN' },
  // --- OR (9) ---
  { lhs: 'TRUE', op: 'OR', rhs: 'TRUE', result: 'TRUE' },
  { lhs: 'TRUE', op: 'OR', rhs: 'FALSE', result: 'TRUE' },
  { lhs: 'TRUE', op: 'OR', rhs: 'UNKNOWN', result: 'TRUE' },
  { lhs: 'FALSE', op: 'OR', rhs: 'TRUE', result: 'TRUE' },
  { lhs: 'FALSE', op: 'OR', rhs: 'FALSE', result: 'FALSE' },
  { lhs: 'FALSE', op: 'OR', rhs: 'UNKNOWN', result: 'UNKNOWN' },
  { lhs: 'UNKNOWN', op: 'OR', rhs: 'TRUE', result: 'TRUE' },
  { lhs: 'UNKNOWN', op: 'OR', rhs: 'FALSE', result: 'UNKNOWN' },
  { lhs: 'UNKNOWN', op: 'OR', rhs: 'UNKNOWN', result: 'UNKNOWN' },
  // --- NOT (3) --- (rhs unused)
  { lhs: 'TRUE', op: 'NOT', rhs: null, result: 'FALSE' },
  { lhs: 'FALSE', op: 'NOT', rhs: null, result: 'TRUE' },
  { lhs: 'UNKNOWN', op: 'NOT', rhs: null, result: 'UNKNOWN' },
  // --- comparison / predicate rows on NULL operands (12) ---
  { lhs: 'NULL', op: '=', rhs: 'NULL', result: 'UNKNOWN' },
  { lhs: 'NULL', op: '=', rhs: '1', result: 'UNKNOWN' },
  { lhs: '1', op: '=', rhs: 'NULL', result: 'UNKNOWN' },
  { lhs: 'NULL', op: '<>', rhs: 'NULL', result: 'UNKNOWN' },
  { lhs: 'NULL', op: '<>', rhs: '1', result: 'UNKNOWN' },
  { lhs: '1', op: '<>', rhs: 'NULL', result: 'UNKNOWN' },
  { lhs: 'NULL', op: 'IS NULL', rhs: null, result: 'TRUE' },
  { lhs: '1', op: 'IS NULL', rhs: null, result: 'FALSE' },
  { lhs: 'NULL', op: 'IS NOT NULL', rhs: null, result: 'FALSE' },
  { lhs: '1', op: 'IS NOT NULL', rhs: null, result: 'TRUE' },
  { lhs: 'NULL', op: '<', rhs: '1', result: 'UNKNOWN' },
  { lhs: 'NULL', op: '>', rhs: '1', result: 'UNKNOWN' }
];

const CORPUS = { PAIRS, SCENARIOS, TRUTH };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CORPUS;
}
if (typeof window !== 'undefined') {
  window.JOINCRAFT = CORPUS;
}
