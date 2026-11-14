/** Serialize route selection while retaining the newest intent and the actual observed selection. */
export class ProfileRouteSync {
  #wanted: string | null = null;
  #current: string | null = null;
  #pending = false;
  #failed: string | null = null;
  #write: (vault: string) => Promise<void> = async () => {};

  update(wanted: string | null, current: string, write: (vault: string) => Promise<void>): void {
    if (wanted !== this.#wanted) this.#failed = null;
    this.#wanted = wanted;
    this.#current = current;
    this.#write = write;
    this.#drain();
  }

  #drain(): void {
    const target = this.#wanted;
    if (this.#pending || target === null || target === this.#current || target === this.#failed)
      return;
    this.#pending = true;
    void this.#write(target).then(
      () => {
        this.#pending = false;
        // A successful command may reach React before its changed snapshot renders. Wait for the
        // next observed selection instead of submitting the same command again.
        if (this.#wanted !== target) this.#drain();
      },
      () => {
        this.#pending = false;
        this.#failed = target;
        if (this.#wanted !== target) this.#drain();
      },
    );
  }
}
