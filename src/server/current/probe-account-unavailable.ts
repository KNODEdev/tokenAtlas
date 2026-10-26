/**
 * The prepared probe index of an account is not ready; screens answer "preparing". Kept apart from
 * the reader so that modules the reader depends on (the projection store, limit windows) can extend it.
 */
export class ProbeAccountIndexUnavailable extends Error {
  readonly code = "probe-account-index-preparing";
  constructor() { super("Probe account index is preparing"); }
}
