import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fresh } from "../lib/warehouse.mjs";

// Each entity is a separate SQLite row; document lines have their own table.
// A mutation holds BEGIN IMMEDIATE from read through commit, including its
// idempotency record. A failed line never persists part of a document.
export class Store {
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, barcode TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, serial TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lines(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lines_document ON lines(document_id);
      CREATE TABLE IF NOT EXISTS balances(product_id TEXT PRIMARY KEY REFERENCES products(id), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS staff(id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cash(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES staff(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(user_id TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,key));
      PRAGMA user_version=1;`);
  }
  read() {
    const state = fresh();
    for (const table of [
      "products",
      "units",
      "documents",
      "staff",
      "audit",
      "cash",
      "lots",
    ]) {
      state[table] = this.db
        .prepare(`SELECT payload FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => JSON.parse(row.payload));
    }
    const docs = new Map(
      state.documents.map((document) => [document.id, document]),
    );
    for (const row of this.db
      .prepare("SELECT document_id,payload FROM lines ORDER BY rowid")
      .all()) {
      docs.get(row.document_id).lines.push(JSON.parse(row.payload));
    }
    for (const row of this.db
      .prepare("SELECT product_id,payload FROM balances")
      .all())
      state.balances[row.product_id] = JSON.parse(row.payload);
    return state;
  }
  save(before, state) {
    for (const table of [
      "products",
      "units",
      "documents",
      "staff",
      "audit",
      "cash",
      "lots",
    ]) {
      const previous = new Map(before[table].map((item) => [item.id, item]));
      for (const item of state[table]) {
        const payload = table === "documents" ? { ...item, lines: [] } : item;
        const old = previous.get(item.id);
        const oldPayload =
          old && (table === "documents" ? { ...old, lines: [] } : old);
        if (JSON.stringify(oldPayload) === JSON.stringify(payload)) continue;
        const json = JSON.stringify(payload);
        if (table === "products" || table === "units" || table === "staff") {
          const column = {
            products: "barcode",
            units: "serial",
            staff: "login",
          }[table];
          this.db
            .prepare(
              `INSERT INTO ${table}(id,${column},payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ${column}=excluded.${column},payload=excluded.payload`,
            )
            .run(item.id, item[column].trim().toLowerCase(), json);
        } else
          this.db
            .prepare(
              `INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
            )
            .run(item.id, json);
      }
    }
    const oldLines = new Map(
      before.documents
        .flatMap((document) => document.lines)
        .map((line) => [line.id, JSON.stringify(line)]),
    );
    const currentIds = new Set();
    for (const document of state.documents)
      for (const line of document.lines) {
        currentIds.add(line.id);
        const json = JSON.stringify(line);
        if (oldLines.get(line.id) !== json)
          this.db
            .prepare(
              "INSERT INTO lines(id,document_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            )
            .run(line.id, document.id, json);
      }
    for (const id of oldLines.keys())
      if (!currentIds.has(id))
        this.db.prepare("DELETE FROM lines WHERE id=?").run(id);
    for (const [id, balance] of Object.entries(state.balances)) {
      if (JSON.stringify(before.balances[id]) !== JSON.stringify(balance))
        this.db
          .prepare(
            "INSERT INTO balances(product_id,payload) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET payload=excluded.payload",
          )
          .run(id, JSON.stringify(balance));
    }
  }
  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
