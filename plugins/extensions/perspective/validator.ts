import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { AnalysisInspectOptions, AnalysisQueryWindow } from '../../../shared/analysis';
import type { AnalysisInput } from './data-input';

/** A bounded queue isolates engine failures and never writes engine logs to MCP stdout. */
export function createAnalysisValidator(directory: string) {
  let worker: Worker | undefined,
    closed = false,
    nextId = 0;
  let running = false;
  type Job = {
    id: number;
    task: 'validate' | 'query' | 'inspect' | 'decode' | 'visualizations';
    data?: Record<string, unknown>;
    options?: unknown;
    input?: AnalysisInput;
    resolve(result: unknown): void;
    reject(error: Error): void;
    timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
  };
  const jobs: Job[] = [];
  const cleanup = (job: Job) => {
    clearTimeout(job.timer);
    if (job.abort) job.signal?.removeEventListener('abort', job.abort);
  };
  const stop = (error: Error) => {
    const previous = worker;
    worker = undefined;
    running = false;
    for (const job of jobs.splice(0)) {
      cleanup(job);
      job.reject(error);
    }
    void previous?.terminate();
  };
  function dispatch() {
    if (closed || running || !jobs.length) return;
    if (!worker) {
      let instance: Worker;
      try {
        instance = new Worker(join(directory, 'validation-worker.mjs'), {
          stdout: true,
          stderr: true,
        });
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      worker = instance;
      instance.stdout.pipe(process.stderr, { end: false });
      instance.stderr.pipe(process.stderr, { end: false });
      instance.on('error', error => {
        if (worker === instance) stop(error);
      });
      instance.on('exit', () => {
        if (worker === instance) stop(new Error('Analysis validation worker stopped. Try again.'));
      });
      instance.on('message', (result: { id: number; error?: string; result?: unknown }) => {
        if (worker !== instance || jobs[0]?.id !== result.id) return;
        const job = jobs.shift()!;
        cleanup(job);
        running = false;
        if (result.error) {
          // An engine Abort may poison its WASM instance. Never reuse it.
          worker = undefined;
          void instance.terminate();
          job.reject(new Error(`Invalid analysis configuration: ${result.error}`));
        } else job.resolve(result.result);
        dispatch();
      });
    }
    const job = jobs[0];
    running = true;
    job.timer = setTimeout(
      () => stop(new Error('Analysis validation timed out. Reduce the view and try again.')),
      15000,
    );
    try {
      worker.postMessage({ id: job.id, task: job.task, data: job.data, options: job.options, input: job.input });
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)));
    }
  }
  function enqueue<T>(request: Pick<Job, 'task' | 'data' | 'options' | 'input'>, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(new Error('Analysis validation is closed.'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (jobs.length >= 16)
        return Promise.reject(new Error('BUSY: Too many pending analysis validations.'));
      return new Promise((resolve, reject) => {
        const job: Job = { ...request, id: ++nextId, resolve: value => resolve(value as T), reject, signal };
        job.abort = () => {
          const index = jobs.indexOf(job);
          if (index < 0) return;
          jobs.splice(index, 1);
          cleanup(job);
          job.reject(new Error('Analysis validation was cancelled.'));
          if (index === 0 && running) {
            const previous = worker;
            worker = undefined;
            running = false;
            void previous?.terminate();
          }
          dispatch();
        };
        jobs.push(job);
        signal?.addEventListener('abort', job.abort, { once: true });
        dispatch();
      });
    }
  return {
    validate: (data: Record<string, unknown>, signal?: AbortSignal): Promise<void> =>
      enqueue({ task: 'validate', data }, signal),
    query: (data: Record<string, unknown>, options: AnalysisQueryWindow, signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'query', data, options }, signal),
    inspect: (data: Record<string, unknown>, options: AnalysisInspectOptions, signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'inspect', data, options }, signal),
    decode: (input: AnalysisInput, signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'decode', input }, signal),
    visualizations: (signal?: AbortSignal): Promise<Record<string, unknown>> =>
      enqueue({ task: 'visualizations' }, signal),
    close() {
      if (closed) return;
      closed = true;
      stop(new Error('Analysis validation is closed.'));
    },
  };
}
