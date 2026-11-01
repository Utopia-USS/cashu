#!/usr/bin/env node
// TRANSITIONAL(S49): the lab / dev host of the outbox bridge. Entry point of `cashu-sync-daemon`.
import { defaultEnv, main } from "./main.js";

process.exitCode = await main(defaultEnv());
