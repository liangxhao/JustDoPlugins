import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** A bounded queue isolates engine failures and never writes engine logs to MCP stdout. */
export function createAnalysisValidator(directory: string) {
  let worker: Worker | undefined,
    closed = false,
    nextId = 0;
  let running = false;
  type Job = {
    id: number;
    data: Record<string, unknown>;
    resolve(): void;
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
      instance.on('message', (result: { id: number; error?: string }) => {
        if (worker !== instance || jobs[0]?.id !== result.id) return;
        const job = jobs.shift()!;
        cleanup(job);
        running = false;
        if (result.error) {
          // An engine Abort may poison its WASM instance. Never reuse it.
          worker = undefined;
          void instance.terminate();
          job.reject(new Error(`Invalid analysis configuration: ${result.error}`));
        } else job.resolve();
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
      worker.postMessage({ id: job.id, data: job.data });
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return {
    validate(data: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
      if (closed) return Promise.reject(new Error('Analysis validation is closed.'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (jobs.length >= 16)
        return Promise.reject(new Error('BUSY: Too many pending analysis validations.'));
      return new Promise((resolve, reject) => {
        const job: Job = { id: ++nextId, data, resolve, reject, signal };
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
    },
    close() {
      if (closed) return;
      closed = true;
      stop(new Error('Analysis validation is closed.'));
    },
  };
}
