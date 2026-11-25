/** One renderer lifetime and its single authorized profile switch during Create. */
export class CreationTransition {
  #generation = 0;
  #expectedVault: string | null = null;

  begin(): number {
    return ++this.#generation;
  }

  active(generation: number): boolean {
    return generation === this.#generation;
  }

  expect(vault: string): void {
    this.#expectedVault = vault;
  }

  vaultChanged(vault: string): boolean {
    if (vault === this.#expectedVault) {
      this.#expectedVault = null;
      return true;
    }
    this.end();
    return false;
  }

  clearExpected(): void {
    this.#expectedVault = null;
  }

  end(): void {
    this.clearExpected();
    this.#generation += 1;
  }
}
