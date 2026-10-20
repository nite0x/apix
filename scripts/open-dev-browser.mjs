import { spawn } from "node:child_process";
import http from "node:http";

const workbenchUrl = "http://127.0.0.1:4317";

await waitForRuntime();
openBrowser(workbenchUrl);
setInterval(() => {}, 2 ** 31 - 1);

function waitForRuntime() {
  return new Promise((resolveReady) => {
    const timer = setInterval(() => {
      const request = http.get(`${workbenchUrl}/health`, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try {
            const health = JSON.parse(body);
            if (response.statusCode === 200 && health.service === "apix-runtime" && health.status === "ok") {
              clearInterval(timer);
              resolveReady();
            }
          } catch {
            // Keep waiting until the Apix runtime is ready.
          }
        });
      });

      request.setTimeout(500, () => {
        request.destroy();
      });
      request.on("error", () => {});
    }, 250);
  });
}

function openBrowser(url) {
  const inWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  const command = inWsl
    ? "rundll32.exe"
    : process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = inWsl
    ? ["url.dll,FileProtocolHandler", url]
    : process.platform === "win32" ? ["/c", "start", "", url] : [url];

  spawn(command, args, {
    detached: true,
    stdio: "ignore",
  }).unref();
}
