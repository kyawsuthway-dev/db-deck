CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT,
  total DECIMAL(10, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  FOREIGN KEY (customer_id) REFERENCES customers(id)
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
