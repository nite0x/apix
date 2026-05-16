import { spawn } from "node:child_process";
import http from "node:http";

const frontendUrl = "http://127.0.0.1:1420";

await waitForFrontend();
openBrowser(frontendUrl);

function waitForFrontend() {
  return new Promise((resolveReady) => {
    const timer = setInterval(() => {
      const request = http.get(frontendUrl, (response) => {
        response.resume();
        clearInterval(timer);
        resolveReady();
      });

      request.setTimeout(500, () => {
        request.destroy();
      });
      request.on("error", () => {});
    }, 250);
  });
}

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  spawn(command, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}
