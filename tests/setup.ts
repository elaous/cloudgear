import { setDefaultTimeout } from "bun:test";

// Analyzing an app and bundling functions can take several seconds when the machine is busy.
setDefaultTimeout(30_000);
