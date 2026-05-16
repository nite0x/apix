import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const runtimeDir = resolve(rootDir, "runtime");
const binariesDir = resolve(rootDir, "src-tauri/binaries");

const triples = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc"
};

const key = `${process.platform}-${process.arch}`;
const targetTriple = triples[key];

if (!targetTriple) {
  throw new Error(`Unsupported platform for Sentris runtime sidecar: ${key}`);
}

mkdirSync(binariesDir, { recursive: true });

const binaryName = `sentris-runtime-${targetTriple}${process.platform === "win32" ? ".exe" : ""}`;
const outputPath = resolve(binariesDir, binaryName);
const goEnv = { ...process.env };

delete goEnv.GOROOT;
delete goEnv.GOTOOLDIR;

execFileSync("go", ["build", "-o", outputPath, "."], {
  cwd: runtimeDir,
  env: goEnv,
  stdio: "inherit"
});

console.log(`Built runtime sidecar: ${outputPath}`);
