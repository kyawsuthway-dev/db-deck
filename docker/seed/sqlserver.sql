CREATE DATABASE sample;
GO
USE sample;
GO

CREATE TABLE customers (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  name NVARCHAR(200) NOT NULL,
  email NVARCHAR(200) UNIQUE,
  created_at DATETIMEOFFSET DEFAULT SYSDATETIMEOFFSET()
);

CREATE TABLE orders (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  total DECIMAL(10, 2) NOT NULL,
  status NVARCHAR(50) DEFAULT 'pending'
);

INSERT INTO customers (name, email) VALUES
  (N'Aung Aung', 'aung@example.com'),
  (N'Somchai', 'somchai@example.com'),
  (N'Mya Mya', 'mya@example.com');

INSERT INTO orders (customer_id, total, status) VALUES
  (1, 250.00, 'paid'),
  (2, 99.50, 'pending'),
  (3, 1200.00, 'shipped');
GO

CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid';
GO

-- SQL Server types whose values a driver can easily get wrong (DB Deck shows them exactly).
CREATE TABLE value_types (
  id INT PRIMARY KEY,
  big_decimal DECIMAL(38, 10),
  money_value MONEY,
  small_money SMALLMONEY,
  precise_time DATETIME2(7),
  with_offset DATETIMEOFFSET(7),
  time_only TIME(7),
  legacy_datetime DATETIME,
  guid UNIQUEIDENTIFIER,
  big BIGINT,
  bytes VARBINARY(16),
  doc XML,
  text_value NVARCHAR(MAX)
);

INSERT INTO value_types VALUES
  (1, 1234567890123456789012345678.1234567891, 922337203685477.5807, 214748.3647,
   '2026-11-28 13:45:12.1234567', '2026-11-28 13:45:12.1234567 +06:30', '23:59:59.9999999',
   '2026-11-28 13:45:12.997', '6F9619FF-8B86-D011-B42D-00C04FC964FF', 9223372036854775807,
   0x00FF10AB, N'<a b="1">text</a>', N'မင်္ဂလာပါ · สวัสดี · 你好');
-- One row per INSERT: a multi-row VALUES list makes SQL Server combine the rows' literal types first.
INSERT INTO value_types VALUES
  (2, -0.0000000001, -922337203685477.5808, -214748.3648,
   '0001-01-01 00:00:00.0000000', '9999-12-31 23:59:59.9999999 +14:00', '00:00:00',
   '1753-01-01 00:00:00.000', NULL, -9223372036854775808,
   NULL, NULL, N'');
GO
