// HTTP Cache-Control owns storage and expiry. Only coalesce in-flight requests here.
export function createRecipeCache(load) {
  const pending = new Map();

  function get(id) {
    if (pending.has(id)) return pending.get(id);
    const request = Promise.resolve().then(() => load(id)).finally(() => pending.delete(id));
    pending.set(id, request);
    return request;
  }

  function prefetch(id) {
    // Speculation never blocks real navigation or fans out across the collection.
    if (pending.size >= 2) return;
    void get(id).catch(() => {});
  }

  return { get, prefetch };
}
