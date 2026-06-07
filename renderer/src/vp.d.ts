import type { VpApi } from "../../electron/preload/index";

declare global {
  interface Window {
    vp: VpApi;
  }
}

export {};
