// The key of Metro's transform cache (used by metro.config.js; kept apart so a test can call it).
const crypto = require("node:crypto");

// Every EXPO_PUBLIC_* variable is inlined into the code Metro transforms, so the key is the sorted name=value pairs of all of them (a variable
// that is set differs from one that is not), hashed; the build's version stays readable in front of the hash.
function cacheVersion(env) {
  const pairs = Object.keys(env)
    .filter((name) => name.startsWith("EXPO_PUBLIC_"))
    .sort()
    .map((name) => `${name}=${env[name]}`);
  const hash = crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex").slice(0, 12);
  return `${env.EXPO_PUBLIC_AIWB_VERSION ?? "dev"}-${hash}`;
}

module.exports = { cacheVersion };
