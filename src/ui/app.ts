// Component shell bootstrap (PASS-01 stub; the real UI is PASS-03). Bundled by esbuild into one
// IIFE at build time (implementation/DEPENDENCIES.md — esbuild is the only UI bundler, no
// framework). Mounts the SDK iframe bridge and renders a static status line.

import { createClockifyBridge } from "@apet97/clockify-addon-sdk/ui";

function main(): void {
  const statusElement = document.getElementById("status");
  const parentOrigin = document.body.dataset.parentOrigin;

  if (!parentOrigin) {
    if (statusElement) statusElement.textContent = "RestoreTime could not verify its parent frame.";
    return;
  }

  createClockifyBridge({ window, parentOrigin });
  // Static text only — no interpolation, so textContent is sufficient (AGENTS.md rule 12).
  if (statusElement) statusElement.textContent = "RestoreTime is installed.";
}

main();
