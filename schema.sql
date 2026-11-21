CREATE TABLE IF NOT EXISTS orders(
 code TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'nuevo',   -- nuevo | pagado | enviado | cancelado
 name TEXT, ci TEXT, tel TEXT, email TEXT,
 prov TEXT, city TEXT, addr TEXT,
 items TEXT,            -- JSON
 sub REAL, ship REAL, pay_now REAL, pay_later REAL,
 method TEXT,
 proof_key TEXT,        -- clave en R2 (si hay bucket)
 proof_b64 TEXT,        -- foto en la base (si no hay bucket)
 tracking TEXT,
 note TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
