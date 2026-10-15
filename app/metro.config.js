// Metro for the monorepo (AD-1): the packages under packages/ are watched through the repository root.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.assetExts.push("html"); // the board's web view page ships as an asset (AD-56): @aiwb/board-view/dist-webview/board.html

// The build's version (EXPO_PUBLIC_AIWB_VERSION, AD-40) is inlined into the code Metro transforms, and Metro's cache is keyed by the file
// alone: without this a build of another version reuses the code of the first one (a build made for the browser checks said "uicheck" to
// every build after it). The version in the cache key keeps one cache per version.
config.cacheVersion = process.env.EXPO_PUBLIC_AIWB_VERSION ?? "dev";

module.exports = config;
