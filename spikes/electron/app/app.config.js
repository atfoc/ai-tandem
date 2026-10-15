// SPIKE: the Expo config. The export is made with experiments.baseUrl "." so that the paths in index.html and
// in the bundle are relative (the window loads it from file://). SPIKE_BASE_URL=/ makes the default export, to
// show what that does under file://.
module.exports = () => ({
  expo: {
    name: 'aiwb-spike-electron',
    slug: 'aiwb-spike-electron',
    version: '1.0.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    ios: { supportsTablet: true },
    android: { adaptiveIcon: { backgroundColor: '#E6F4FE', foregroundImage: './assets/android-icon-foreground.png' } },
    web: { favicon: './assets/favicon.png' },
    plugins: ['expo-font'],
    experiments: { baseUrl: process.env.SPIKE_BASE_URL ?? '.' },
  },
});
