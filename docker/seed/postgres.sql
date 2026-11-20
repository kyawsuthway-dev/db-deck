CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id),
  total NUMERIC(10, 2) NOT NULL,
  status TEXT DEFAULT 'pending'
);

INSERT INTO customers (name, email) VALUES
  ('Aung Aung', 'aung@example.com'),
  ('Somchai', 'somchai@example.com'),
  ('Mya Mya', 'mya@example.com');

INSERT INTO orders (customer_id, total, status) VALUES
  (1, 250.00, 'paid'),
  (2, 99.50, 'pending'),
  (3, 1200.00, 'shipped');

CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid';
