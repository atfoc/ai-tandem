import "react-native-gesture-handler";
import { registerRootComponent } from "expo";

import App from "./src/App.tsx";

// registerRootComponent calls AppRegistry.registerComponent("main", () => App) and sets up the environment for the
// web build, the development client and a release build alike.
registerRootComponent(App);
