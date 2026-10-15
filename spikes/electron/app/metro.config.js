// SPIKE: the app imports the page's real transport types (web/src/transport/types.ts, outside this folder),
// so Metro must watch that folder.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders || []), path.resolve(__dirname, '../../../web/src/transport')];
module.exports = config;
