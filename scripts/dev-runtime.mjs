import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const runtimeDir = resolve(rootDir, "runtime");
const goEnv = { ...process.env };

delete goEnv.GOROOT;
delete goEnv.GOTOOLDIR;

let runtimeArgs = process.argv.slice(2);

if (runtimeArgs[0] === "--") {
  runtimeArgs = runtimeArgs.slice(1);
}

if (runtimeArgs.length === 0 && (await runtimeIsHealthy())) {
  console.log("apix-runtime is already listening on http://127.0.0.1:4317");
  setInterval(() => {}, 2 ** 31 - 1);
} else {
  startRuntime(runtimeArgs);
}

function startRuntime(args) {
  const child = spawn("go", ["run", ".", ...args], {
    cwd: runtimeDir,
    env: goEnv,
    stdio: "inherit"
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }

    process.exit(code ?? 0);
  });
}

function runtimeIsHealthy() {
  return new Promise((resolveHealthy) => {
    const request = http.get("http://127.0.0.1:4317/health", (response) => {
      let body = "";

      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolveHealthy(
          response.statusCode === 200 &&
            body.includes('"service":"apix-runtime"') &&
            body.includes('"status":"ok"')
        );
      });
    });

    request.setTimeout(500, () => {
      request.destroy();
      resolveHealthy(false);
    });
    request.on("error", () => {
      resolveHealthy(false);
    });
  });
}
