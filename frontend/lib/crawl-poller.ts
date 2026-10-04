/** One bounded poll at a time. Terminal data sleeps until an explicit refresh. */
export function createCrawlPoller<T>(options: {
  load: (signal: AbortSignal) => Promise<T>;
  publish: (data: T) => void;
  failed: (error: unknown) => void;
  active: (data: T) => boolean;
  visible?: boolean;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout;
  const clear = options.clear ?? clearTimeout;
  let visible = options.visible ?? true;
  let disposed = false;
  let generation = 0;
  let failures = 0;
  let keepPolling = false;
  let dirty = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  function pause() {
    generation++;
    if (timer !== undefined) clear(timer);
    timer = undefined;
    if (pending) dirty = true;
    pending?.abort();
    pending = undefined;
  }
  async function run() {
    if (disposed || !visible) return;
    pause();
    const ticket = generation;
    const controller = new AbortController();
    pending = controller;
    try {
      const data = await options.load(controller.signal);
      if (
        disposed ||
        !visible ||
        ticket !== generation ||
        controller.signal.aborted
      )
        return;
      pending = undefined;
      dirty = false;
      failures = 0;
      keepPolling = options.active(data);
      options.publish(data);
      if (keepPolling)
        timer = schedule(() => {
          timer = undefined;
          void run();
        }, 3000);
    } catch (error) {
      if (
        disposed ||
        !visible ||
        ticket !== generation ||
        controller.signal.aborted
      )
        return;
      pending = undefined;
      dirty = true;
      failures = Math.min(4, failures + 1);
      options.failed(error);
      timer = schedule(
        () => {
          timer = undefined;
          void run();
        },
        Math.min(30000, 3000 * 2 ** (failures - 1)),
      );
    }
  }
  return {
    refresh() {
      dirty = true;
      failures = 0;
      void run();
    },
    setVisible(next: boolean) {
      if (disposed || next === visible) return;
      visible = next;
      if (!visible) pause();
      else if (dirty || keepPolling) void run();
    },
    dispose() {
      disposed = true;
      pause();
    },
  };
}
