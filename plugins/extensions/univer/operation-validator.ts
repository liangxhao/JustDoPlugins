import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { SpreadsheetInspect, SpreadsheetOperation } from './operations';
import type { IWorkbookData } from '@univerjs/core';
import type { readRangeSchema } from '../../../shared/spreadsheet';

export function createSpreadsheetOperationValidator(directory: string) {
  type Job = {
    id: number; task: 'preview' | 'inspect' | 'read'; data: Record<string, unknown>;
    operation?: SpreadsheetOperation; options?: SpreadsheetInspect | ReturnType<typeof readRangeSchema.parse>;
    resolve(value: unknown): void; reject(error: Error): void;
    signal?: AbortSignal; abort?: () => void; timer?: ReturnType<typeof setTimeout>;
  };
  let worker: Worker | undefined, nextId = 0, running = false, closed = false;
  const jobs: Job[] = [];
  const cleanup = (job: Job) => {
    clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
  };
  const terminate = () => {
    const previous = worker; worker = undefined; running = false;
    previous?.stdout.unpipe(process.stderr);
    previous?.stderr.unpipe(process.stderr);
    void previous?.terminate();
  };
  const stop = (error: Error) => {
    terminate();
    for (const job of jobs.splice(0)) { cleanup(job); job.reject(error); }
  };
  function dispatch() {
    if (closed || running || !jobs.length) return;
    if (!worker) {
      let instance: Worker;
      try { instance = new Worker(join(directory, 'operations-worker.mjs'), { stdout: true, stderr: true }); }
      catch (cause) { stop(cause instanceof Error ? cause : new Error(String(cause))); return; }
      worker = instance;
      instance.stdout.pipe(process.stderr, { end: false });
      instance.stderr.pipe(process.stderr, { end: false });
      instance.on('error', error => { if (worker === instance) stop(error); });
      instance.on('exit', () => { if (worker === instance) stop(new Error('Spreadsheet operation worker stopped.')); });
      instance.on('message', (result: { id: number; result?: unknown; error?: string }) => {
        if (worker !== instance || jobs[0]?.id !== result.id) return;
        const job = jobs.shift()!;
        cleanup(job);
        // A job owns one complete Univer lifecycle. Fresh isolates avoid stale
        // module-level formula sessions and also bound retained parser caches.
        terminate();
        if (result.error) job.reject(new Error(result.error));
        else job.resolve(result.result);
        dispatch();
      });
    }
    const job = jobs[0]; running = true;
    job.timer = setTimeout(() => stop(new Error('Spreadsheet operation timed out. Reduce the range and try again.')), 15000);
    try { worker.postMessage({ id: job.id, task: job.task, data: job.data, operation: job.operation, options: job.options }); }
    catch (cause) { stop(cause instanceof Error ? cause : new Error(String(cause))); }
  }
  function enqueue<T>(request: Pick<Job, 'task' | 'data' | 'operation' | 'options'>, signal?: AbortSignal): Promise<T> {
    if (closed) return Promise.reject(new Error('Spreadsheet operations are closed.'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (jobs.length >= 16) return Promise.reject(new Error('BUSY: Too many pending spreadsheet operations.'));
    return new Promise((resolve, reject) => {
      const job: Job = { ...request, id: ++nextId, resolve: value => resolve(value as T), reject, signal };
      job.abort = () => {
        const index = jobs.indexOf(job);
        if (index < 0) return;
        jobs.splice(index, 1); cleanup(job); reject(new Error('Spreadsheet operation was cancelled.'));
        if (!index && running) terminate();
        dispatch();
      };
      jobs.push(job); signal?.addEventListener('abort', job.abort, { once: true }); dispatch();
    });
  }
  return {
    preview: (data: Record<string, unknown>, operation: SpreadsheetOperation, signal?: AbortSignal): Promise<{ workbook: IWorkbookData; operation: SpreadsheetOperation }> =>
      enqueue({ task: 'preview', data, operation }, signal),
    inspect: (data: Record<string, unknown>, options: SpreadsheetInspect, signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'inspect', data, options }, signal),
    readRange: (data: Record<string, unknown>, options: ReturnType<typeof readRangeSchema.parse>, signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'read', data, options }, signal),
    close() { if (!closed) { closed = true; stop(new Error('Spreadsheet operations are closed.')); } },
  };
}
