// Included only in the explicit debug build used by the native isolation probe.
declare global {
  interface Window {
    __CITY_ISOLATION_FAULTS__?: {
      runtimeError(): void;
      rejection(): void;
      hang(): void;
    };
  }
}

window.__CITY_ISOLATION_FAULTS__ = {
  runtimeError() { setTimeout(() => { throw new TypeError("synthetic_city_fault"); }, 0); },
  rejection() { void Promise.reject(new Error("synthetic_city_rejection")); },
  // Observable writes prevent the bundler from removing an empty infinite loop.
  hang() { while (true) { Reflect.set(window, "__CITY_PROBE_SPIN__", performance.now()); } },
};

export {};
