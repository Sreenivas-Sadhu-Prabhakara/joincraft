-- joincraft authoring-time verification
-- Run: sqlite3 :memory: < sources/verify.sql
-- SQLite lacks RIGHT/FULL before 3.39; this build's sqlite3 is 3.51 (has them).
.nullvalue NULL
.mode list
.headers on

CREATE TABLE customers(customer_id INTEGER, name TEXT);
INSERT INTO customers VALUES (1,'Ada'),(2,'Bo'),(3,'Chen'),(4,'Devi'),(5,'Esa'),(6,'Faye');
CREATE TABLE orders(order_id INTEGER, customer_id INTEGER, amount INTEGER);
INSERT INTO orders VALUES (101,1,40),(102,1,60),(103,1,10),(104,2,25),(105,3,80),(106,3,20),(107,NULL,15);

CREATE TABLE employees(emp_id INTEGER, name TEXT, dept_id INTEGER);
INSERT INTO employees VALUES (1,'Rui',10),(2,'Sam',10),(3,'Tao',20),(4,'Uma',30),(5,'Ven',NULL),(6,'Wei',20);
CREATE TABLE departments(dept_id INTEGER, dept_name TEXT);
INSERT INTO departments VALUES (10,'Sales'),(20,'Eng'),(30,'Ops'),(40,'Legal');

CREATE TABLE sku_prices(sku TEXT, price INTEGER);
INSERT INTO sku_prices VALUES ('A',100),('A',110),('B',200),('C',300),('D',400);
CREATE TABLE sku_stock(sku TEXT, qty INTEGER);
INSERT INTO sku_stock VALUES ('A',5),('A',6),('A',7),('B',8),('E',9);

CREATE TABLE sensors(sensor_id INTEGER, zone TEXT);
INSERT INTO sensors VALUES (1,'North'),(2,'South'),(3,'East'),(NULL,'Spare-A'),(NULL,'Spare-B');
CREATE TABLE readings(reading_id INTEGER, sensor_id INTEGER, value INTEGER);
INSERT INTO readings VALUES (1001,1,22),(1002,1,NULL),(1003,2,30),(1004,NULL,40),(1005,NULL,NULL),(1006,9,55);

SELECT '--- S1 INNER blowup (expect 7 rows) ---';
SELECT p.sku, p.price, s.sku, s.qty FROM sku_prices p JOIN sku_stock s ON p.sku=s.sku;

SELECT '--- S2 LEFT customers x orders (expect 9) ---';
SELECT c.customer_id, c.name, o.order_id, o.customer_id, o.amount FROM customers c LEFT JOIN orders o ON c.customer_id=o.customer_id;

SELECT '--- S3 RIGHT customers x orders (expect 7) ---';
SELECT c.customer_id, c.name, o.order_id, o.customer_id, o.amount FROM customers c RIGHT JOIN orders o ON c.customer_id=o.customer_id;

SELECT '--- S4 FULL employees x departments (expect 7) ---';
SELECT e.emp_id, e.name, e.dept_id, d.dept_id, d.dept_name FROM employees e FULL JOIN departments d ON e.dept_id=d.dept_id;

SELECT '--- S5 CROSS employees x departments (expect 24) ---';
SELECT count(*) FROM employees e CROSS JOIN departments d;

SELECT '--- S6 INNER sensors x readings NULL never matches (expect 3) ---';
SELECT s.sensor_id, s.zone, r.reading_id, r.sensor_id, r.value FROM sensors s JOIN readings r ON s.sensor_id=r.sensor_id;

SELECT '--- S7 GROUP BY readings.sensor_id COUNT(*) (NULLs one bucket) ---';
SELECT r.sensor_id, COUNT(*) FROM readings r GROUP BY r.sensor_id;

SELECT '--- S8 COUNT(value) per sensor ---';
SELECT r.sensor_id, COUNT(r.value) FROM readings r GROUP BY r.sensor_id;

SELECT '--- S9 SUM(value) per sensor ---';
SELECT r.sensor_id, SUM(r.value) FROM readings r GROUP BY r.sensor_id;

SELECT '--- S10 LEFT then COUNT(order_id) per customer ---';
SELECT c.customer_id, COUNT(o.order_id) FROM customers c LEFT JOIN orders o ON c.customer_id=o.customer_id GROUP BY c.customer_id;

SELECT '--- S11 SUM(price) over sku INNER join (inflated=830) ---';
SELECT SUM(p.price) FROM sku_prices p JOIN sku_stock s ON p.sku=s.sku;
SELECT '--- S11 true distinct matched price sum (410) ---';
SELECT SUM(price) FROM (SELECT DISTINCT p.rowid, p.price FROM sku_prices p JOIN sku_stock s ON p.sku=s.sku);

SELECT '--- 3VL cross-checks ---';
SELECT NULL=NULL, NULL<>NULL, NULL IS NULL, NULL IS NOT NULL, NULL<1, NULL>1;
SELECT (1=1) AND (NULL=NULL), (1=1) OR (NULL=NULL), NOT (NULL=NULL);
