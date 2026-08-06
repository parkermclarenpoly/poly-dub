const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputPath = path.resolve(process.argv[2] || "poly-dub.zip");
const accessToken = fs.readFileSync(0, "utf8").trim();
const tokenPlaceholder = "__POLY_DUB_ACCESS_TOKEN__";
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

if (!/^pd_[a-f0-9]{64}$/i.test(accessToken)) {
  throw new Error("A valid Poly Dub proxy token must be provided on stdin");
}

const stagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "poly-dub-release-"));
try {
  for (const file of releaseFiles) {
    fs.cpSync(path.resolve(file), path.join(stagingDirectory, file), { recursive: true });
  }

  const backgroundPath = path.join(stagingDirectory, "background.js");
  const background = fs.readFileSync(backgroundPath, "utf8");
  if (!background.includes(tokenPlaceholder)) {
    throw new Error("Poly Dub token placeholder is missing from background.js");
  }
  fs.writeFileSync(backgroundPath, background.replace(tokenPlaceholder, accessToken));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  execFileSync("zip", ["-qrFS", outputPath, ...releaseFiles], { cwd: stagingDirectory });
  console.log(`Created ${outputPath}`);
} finally {
  fs.rmSync(stagingDirectory, { force: true, recursive: true });
}
