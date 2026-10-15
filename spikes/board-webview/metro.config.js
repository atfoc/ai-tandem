const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("html"); // the board page ships as an asset: assets/board.html
module.exports = config;
