import fs from "node:fs";
import path from "node:path";
import { parseState, type State } from "./deploy/state";
import { describeLock, S3StateStore } from "./deploy/state-s3";
import type { StateStore } from "./deploy/state-store";

export interface StateCommandOptions {
  force: boolean;
  workDir: string;
  statePath: string;
  from?: string;
  project?: string;
  provider?: string;
}

const USAGE = "Usage: cloudgear state pull | push [--force] | unlock --force | show";

function remoteStore(store: StateStore): S3StateStore {
  if (!(store instanceof S3StateStore)) {
    throw new Error("No remote state is configured; pass --state s3://<bucket>/<prefix> or set CLOUDGEAR_STATE");
  }
  return store;
}

const relative = (file: string) => path.relative(process.cwd(), file) || file;

export async function stateCommand(sub: string | undefined, store: StateStore, options: StateCommandOptions): Promise<void> {
  if (sub !== "pull" && sub !== "push" && sub !== "unlock" && sub !== "show") throw new Error(USAGE);
  const remote = remoteStore(store);
  switch (sub) {
    case "pull": {
      const pulled = await remote.pull(options.workDir);
      console.log(`cloudgear: pulled state from ${remote.describe()} -> ${relative(path.join(options.workDir, "state.json"))}`);
      console.log(
        pulled.endpoints
          ? `cloudgear: pulled endpoints -> ${relative(path.join(options.workDir, "endpoints.json"))}`
          : "cloudgear: the remote has no endpoints.json; the local one was removed",
      );
      return;
    }
    case "push": {
      const source = options.from ?? options.statePath;
      if (!fs.existsSync(source)) throw new Error(`${relative(source)} not found; there is no local state to push`);
      const text = fs.readFileSync(source, "utf8");
      const local = parseState(text, relative(source), options.project!, options.provider!);
      const existing = await remote.readRemote();
      if (existing && !options.force) {
        const entries = Object.keys((JSON.parse(existing.text) as State).entries ?? {}).length;
        throw new Error(`${remote.describe()} already holds state (${entries} entries); pass --force to overwrite it`);
      }
      await remote.save(local);
      console.log(`cloudgear: pushed ${Object.keys(local.entries).length} entries to ${remote.describe()}${existing ? " (replaced the existing remote state)" : ""}`);
      const endpointsFile = path.join(options.workDir, "endpoints.json");
      if (fs.existsSync(endpointsFile)) {
        await remote.saveEndpoints(fs.readFileSync(endpointsFile, "utf8"));
        console.log("cloudgear: pushed endpoints.json");
      }
      return;
    }
    case "unlock": {
      const held = await remote.readLock();
      if (!held) {
        console.log(`cloudgear: ${remote.describe()} is not locked`);
        return;
      }
      console.log(`cloudgear: lock held by ${describeLock(held.info)}`);
      if (!options.force) {
        throw new Error("Refusing to remove the lock without --force; make sure that run is no longer running, then run cloudgear state unlock --force");
      }
      await remote.forceUnlock();
      console.log("cloudgear: lock removed");
      return;
    }
    case "show": {
      console.log(`location: ${remote.describe()}`);
      const state = await remote.readRemote();
      if (state) {
        console.log(`entries:  ${Object.keys((JSON.parse(state.text) as State).entries ?? {}).length}`);
        console.log(`version:  ${state.etag}`);
      } else {
        console.log("state:    none yet");
      }
      const held = await remote.readLock();
      console.log(`locked:   ${held ? `yes, by ${describeLock(held.info)}` : "no"}`);
      return;
    }
  }
}
