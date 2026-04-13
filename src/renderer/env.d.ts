import type { HostBridge } from "../shared/contracts";

declare global {
  interface Window {
    labelauHost?: HostBridge;
  }
}

export {};
