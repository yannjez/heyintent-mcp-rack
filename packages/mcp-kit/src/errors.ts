import type { Capability } from "./types.js";

export class CapabilityDeniedError extends Error {
  readonly capability: Capability;
  constructor(capability: Capability, reason = "not granted") {
    super(`Capability "${capability}" is ${reason}`);
    this.name = "CapabilityDeniedError";
    this.capability = capability;
  }
}
