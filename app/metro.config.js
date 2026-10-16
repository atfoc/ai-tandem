// Metro for the monorepo (AD-1): the packages under packages/ are watched through the repository root.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { cacheVersion } = require("./metro-cache-key.js");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.assetExts.push("html"); // the board's web view page ships as an asset (AD-56): @aiwb/board-view/dist-webview/board.html

// Every EXPO_PUBLIC_* value (the build's version, EXPO_PUBLIC_AIWB_VERSION, AD-40, and the flags of the self-test, gallery and probe builds) is inlined
// into the code Metro transforms, and Metro's cache is keyed by the file alone and shared by every worktree on the machine: without this a build
// with other values reuses the code of the first one (a build made for the browser checks said "uicheck" to every build after it; a normal
// Release build after a self-test build shipped the self-test screen). The key holds all of them, so there is one cache per set of values.
config.cacheVersion = cacheVersion(process.env);

module.exports = config;
