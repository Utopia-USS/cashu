// One write queue per store (each vault, the device store): commands, applies and job writes of every
// session run one at a time, so this device's stream has one appender and never interleaves. An
// asynchronous step holds the queue until it settles; a synchronous SQLite transaction must still
// complete before any await.
//
// Long work (a genesis-size apply, a rebuild) is a sliced job: one slice (one transaction) per step.
// After a slice the job goes to the back of the queue, so a command another session sent meanwhile
// runs before the next slice: a big batch never starves the others. The queue yields to the event loop
// between steps (setImmediate), so socket reads keep arriving while it drains.

type Step = () =>
  | { readonly done: boolean; readonly value?: unknown }
  | Promise<{ readonly done: boolean; readonly value?: unknown }>;

interface Job {
  readonly step: Step;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class QueueClosedError extends Error {
  constructor() {
    super("the store is closing");
    this.name = "QueueClosedError";
  }
}

export class WriteQueue {
  readonly #jobs: Job[] = [];
  readonly #idle: (() => void)[] = [];
  readonly #beforeStep: () => void;
  #running = false;
  #active = false;
  #closed = false;

  /** `beforeStep` runs before every step and may throw to fail it (the writer lease check). */
  constructor(beforeStep: () => void = () => {}) {
    this.#beforeStep = beforeStep;
  }

  /** Jobs queued or running. */
  get pending(): number {
    return this.#jobs.length + Number(this.#active);
  }

  /** Runs `task` as one step after everything queued before it. */
  run<T>(task: () => T | Promise<T>): Promise<T> {
    return this.#push(async () => ({ done: true, value: await task() })) as Promise<T>;
  }

  /**
   * Runs `slices` one per step, other jobs interleaved between them; resolves with the iterator's
   * return value. A throwing slice ends the job (slices committed before it stay committed).
   */
  runSliced<T>(slices: Iterator<unknown, T>): Promise<T> {
    return this.#push(() => {
      const r = slices.next();
      return r.done ? { done: true, value: r.value } : { done: false };
    }) as Promise<T>;
  }

  /** Resolves once nothing is queued or running. */
  idle(): Promise<void> {
    if (this.#jobs.length === 0 && !this.#running) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  /** Refuses new jobs; queued ones still run. */
  close(): void {
    this.#closed = true;
  }

  #push(step: Step): Promise<unknown> {
    if (this.#closed) return Promise.reject(new QueueClosedError());
    return new Promise((resolve, reject) => {
      this.#jobs.push({ step, resolve, reject });
      if (!this.#running) {
        this.#running = true;
        setImmediate(() => void this.#pump());
      }
    });
  }

  async #pump(): Promise<void> {
    const job = this.#jobs.shift();
    if (job === undefined) {
      this.#running = false;
      for (const resolve of this.#idle.splice(0)) resolve();
      return;
    }
    try {
      this.#beforeStep();
      this.#active = true;
      const r = await job.step();
      if (r.done) job.resolve(r.value);
      else this.#jobs.push(job);
    } catch (error) {
      job.reject(error);
    } finally {
      this.#active = false;
    }
    setImmediate(() => void this.#pump());
  }
}
