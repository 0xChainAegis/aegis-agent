/** Coalesce refreshes within one wallet session without delaying a new session. */
export function singleFlightByRevision(
  readRevision: () => number,
  operation: (revision: number, initial: boolean) => Promise<void>,
): (initial?: boolean) => Promise<void> {
  let flight: { revision: number; promise: Promise<void> } | undefined;
  return (initial = false) => {
    const revision = readRevision();
    if (flight?.revision === revision) return flight.promise;
    const promise = Promise.resolve().then(() => {
      if (revision !== readRevision()) return;
      return operation(revision, initial);
    });
    const current = { revision, promise };
    flight = current;
    const release = () => { if (flight === current) flight = undefined; };
    void promise.then(release, release);
    return promise;
  };
}
