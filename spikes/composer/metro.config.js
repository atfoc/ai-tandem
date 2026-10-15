// The spike imports the page's own logic (web/src/logic/refs.ts, web/src/format.ts) in place, so the message it
// produces is refs.ts's, not a copy of it.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../../web/src")];
module.exports = config;
