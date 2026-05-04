#!/usr/bin/env node

import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import open from "open";

const signupUrl = "https://dashboard.fingerprint.com/signup";

console.log("Welcome to Fingerprint.com!");
console.log(
  "Would you like to open the browser to create a 14-day unlimited trial account?\nYes/No",
);

const rl = readline.createInterface({ input, output });

let exitCode = 0;

try {
  for await (const line of rl) {
    const answer = line.trim().toLowerCase();

    if (answer === "yes") {
      rl.close();
      await open(signupUrl);
      console.log(
        "Opened the default system browser to complete with the account creation, exiting now.",
      );
      break;
    }

    if (answer === "no") {
      break;
    }

    console.log('Type "yes" or "no"');
  }
} catch {
  exitCode = 1;
} finally {
  rl.close();
  process.exitCode = exitCode;
}
