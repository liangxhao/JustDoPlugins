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
  private closed = false;
  constructor(
    path: string,
    private readonly kind: Kind,
    private readonly validateDocument?: (
      data: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<void>,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
      )`);
  }
  private assertOpen() {
    if (this.closed) throw new Error('Document store is closed.');
  }
  async create(title: string, data: unknown, signal?: AbortSignal): Promise<AppDocument> {
    this.assertOpen();
    signal?.throwIfAborted();
    const document: AppDocument = {
      id: randomUUID(),
      kind: this.kind,
      title: titleSchema.parse(title),
      revision: 1,
      updatedAt: new Date().toISOString(),
      data: validateData(this.kind, data),
    };
    await this.validateDocument?.(document.data, signal);
    this.assertOpen();
    signal?.throwIfAborted();
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
    this.assertOpen();
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
    this.assertOpen();
    return this.db
      .prepare(
        `SELECT id, title, revision, updated_at AS updatedAt FROM documents
      WHERE kind = ? ORDER BY updated_at DESC LIMIT 100`,
      )
      .all(this.kind);
  }
  async save(
    id: string,
    expectedRevision: number,
    title: string,
    data: unknown,
    signal?: AbortSignal,
  ): Promise<AppDocument> {
    this.assertOpen();
    signal?.throwIfAborted();
    const parsedId = idSchema.parse(id),
      parsedRevision = revisionSchema.parse(expectedRevision);
    const parsedTitle = titleSchema.parse(title);
    const validated = validateData(this.kind, data);
    await this.validateDocument?.(validated, signal);
    this.assertOpen();
    signal?.throwIfAborted();
    const serialized = JSON.stringify(validated);
    const row = this.db
      .prepare(
        `UPDATE documents SET title = ?, data = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND kind = ? AND revision = ? RETURNING *`,
      )
      .get(parsedTitle, serialized, new Date().toISOString(), parsedId, this.kind, parsedRevision);
    if (!row)
      throw new Error('CONFLICT: Document changed. Read the latest revision before saving.');
    return this.toDocument(row);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
