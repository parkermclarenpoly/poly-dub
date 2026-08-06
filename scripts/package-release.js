const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputPath = path.resolve(process.argv[2] || "poly-dub.zip");
const releaseFiles = [
  "manifest.json",
  "background.js",
  "content-script.js",
  "options.html",
  "options.css",
  "options.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons",
  "README.md",
  "PRIVACY.md",
];

const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-dub-release-"));
try {
  for (const file of releaseFiles) {
    fs.cpSync(path.resolve(file), path.join(stagingDirectory, file), { recursive: true });
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  execFileSync("zip", ["-qrFS", outputPath, ...releaseFiles], { cwd: stagingDirectory });
  console.log(`Created ${outputPath}`);
} finally {
  fs.rmSync(stagingDirectory, { force: true, recursive: true });
}
