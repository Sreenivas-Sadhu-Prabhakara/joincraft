# joincraft — corpus provenance & verification

joincraft's corpus is not a set of external "facts" to cite — it is a set of
**tiny in-memory tables** plus the **result rows a real SQL engine produces for
them**. Every result row in `data/corpus.js` is verified two independent ways:

1. **Authoring-time, against a real SQL engine.** Each of the four table pairs
   and all twelve gotcha scenarios were written as SQL, loaded into an in-memory
   SQLite database, and their output diffed against the `expected` arrays in the
   corpus. The exact script is `sources/verify.sql`. Reproduce:

   ```sh
   sqlite3 :memory: < sources/verify.sql
   ```

   SQLite is the reference engine because it implements ANSI three-valued logic
   for `NULL` and (from 3.39) `RIGHT`/`FULL OUTER JOIN`. This build was verified
   against **SQLite 3.51.0**. Row *ordering* differs between SQLite and joincraft
   (joincraft imposes a deterministic teaching order; SQL guarantees none without
   `ORDER BY`) — the verification compares row *sets* and scalar aggregates, and
   the teaching order is then locked by the Node tests.

2. **Permanently, in the test suite.** `test/joincraft.test.js` asserts the
   in-app evaluator (`data/engine.js`) `deepStrictEqual`s every `expected` array,
   byte-for-byte, in teaching order. If the engine ever drifts from the corpus,
   `node --test` fails. Run:

   ```sh
   node --test
   ```

## Three-valued logic (3VL) truth tables

The 33-entry `TRUTH` corpus follows the **ISO/IEC 9075 (SQL standard)**
three-valued-logic tables for `AND`, `OR`, `NOT`, and comparison/predicate
results over `NULL` operands. Every entry is cross-checked in SQLite, e.g.:

| SQL expression        | SQLite result | 3VL token |
|-----------------------|---------------|-----------|
| `SELECT NULL = NULL`      | `NULL`    | UNKNOWN |
| `SELECT NULL <> NULL`     | `NULL`    | UNKNOWN |
| `SELECT NULL IS NULL`     | `1`       | TRUE    |
| `SELECT NULL IS NOT NULL` | `0`       | FALSE   |
| `SELECT (1=1) AND (NULL=NULL)` | `NULL` | UNKNOWN |
| `SELECT (1=1) OR (NULL=NULL)`  | `1`    | TRUE    |
| `SELECT NOT (NULL=NULL)`       | `NULL` | UNKNOWN |

The canonical AND/OR/NOT matrices (`UNKNOWN AND FALSE = FALSE`,
`UNKNOWN OR TRUE = TRUE`, `NOT UNKNOWN = UNKNOWN`) are the published SQL 3VL
tables and are re-derived by `eval3` in the test suite.

## Honesty note

joincraft is a **teaching model**, not a SQL engine. It supports one join
between two small tables plus one optional `GROUP BY` aggregate — no `WHERE`,
`HAVING`, `ORDER BY`, subqueries, or free-text SQL. The SQL text it shows is
illustrative ANSI syntax for reading and copying, not the output of a parser.
Real databases can differ in collation, type coercion, and dialect extensions;
verify anything important on your actual database.

## Scope kills honored

No free-text SQL / parser / query engine · no `WHERE`/`HAVING`/`ORDER BY`/
subqueries/multi-join chains/self-join UI/semi-anti-lateral joins/`USING` ·
no dialect emulation beyond the "verified against ANSI semantics via SQLite"
note · no quiz/scoring mode · no cloud sync/sharing/URLs carrying table data ·
hard cap of 8 rows per side.
