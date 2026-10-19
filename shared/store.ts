import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type AppDocument,
  idSchema,
  type Kind,
  revisionSchema,
  titleSchema,
  validateData,
} from './contracts';

export class DocumentStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly kind: Kind,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
      )`);
  }
  create(title: string, data: unknown): AppDocument {
    const document: AppDocument = {
      id: randomUUID(),
      kind: this.kind,
      title: titleSchema.parse(title),
      revision: 1,
      updatedAt: new Date().toISOString(),
      data: validateData(this.kind, data),
    };
    this.db
      .prepare('INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        document.id,
        document.kind,
        document.title,
        document.revision,
        document.updatedAt,
        JSON.stringify(document.data),
      );
    return document;
  }
  get(id: string): AppDocument {
    const row = this.db
      .prepare('SELECT * FROM documents WHERE id = ? AND kind = ?')
      .get(idSchema.parse(id), this.kind);
    if (!row) throw new Error('Document not found.');
    return this.toDocument(row);
  }
  private toDocument(row: Record<string, unknown>): AppDocument {
    return {
      id: String(row.id),
      kind: this.kind,
      title: String(row.title),
      revision: Number(row.revision),
      updatedAt: String(row.updated_at),
      data: JSON.parse(String(row.data)),
    };
  }
  list() {
    return this.db
      .prepare(
        `SELECT id, title, revision, updated_at AS updatedAt FROM documents
      WHERE kind = ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(this.kind);
  }
  save(id: string, expectedRevision: number, title: string, data: unknown): AppDocument {
    const serialized = JSON.stringify(validateData(this.kind, data));
    const row = this.db
      .prepare(
        `UPDATE documents SET title = ?, data = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND kind = ? AND revision = ? RETURNING *`,
      )
      .get(
        titleSchema.parse(title),
        serialized,
        new Date().toISOString(),
        idSchema.parse(id),
        this.kind,
        revisionSchema.parse(expectedRevision),
      );
    if (!row)
      throw new Error('CONFLICT: Document changed. Read the latest revision before saving.');
    return this.toDocument(row);
  }
  close() {
    this.db.close();
  }
}
