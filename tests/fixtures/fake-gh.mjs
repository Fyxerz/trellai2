#!/usr/bin/env node
// A stand-in for `gh` (TRELLAI_GH). Never touches the real git/gh configuration.
// FAKE_GH_LOGGED_OUT=1 makes `auth status` / `auth setup-git` fail; FAKE_GH_LOGIN_FAIL=1 makes `auth login` exit 1.
import { createInterface } from "node:readline";

const [cmd, sub] = process.argv.slice(2);
const loggedOut = process.env.FAKE_GH_LOGGED_OUT === "1";

if (cmd === "auth" && sub === "login") {
  console.error("! First copy your one-time code: ABCD-1234");
  console.error("Press Enter to open https://github.com/login/device in your browser...");
  const rl = createInterface({ input: process.stdin });
  rl.once("line", () => {
    rl.close();
    if (process.env.FAKE_GH_LOGIN_FAIL === "1") {
      console.error("authentication failed: access denied");
      process.exit(1);
    }
    console.error("✓ Authentication complete.");
    console.error("✓ Logged in as fake-user");
    process.exit(0);
  });
} else if (cmd === "auth" && sub === "status") {
  if (loggedOut) {
    console.error("You are not logged into any GitHub hosts. To log in, run: gh auth login");
    process.exit(1);
  }
  console.log("github.com\n  ✓ Logged in to github.com account fake-user (keyring)");
} else if (cmd === "auth" && sub === "setup-git") {
  process.exit(loggedOut ? 1 : 0);
} else if (cmd === "api" && sub === "user") {
  console.log("fake-user");
} else if (cmd === "config" && sub === "get") {
  console.log("https");
} else {
  console.error(`fake gh: unsupported ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}
