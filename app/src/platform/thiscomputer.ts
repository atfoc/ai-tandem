// Whether this app has a server of its own, and so a "This computer" section (goal 4.1). The web build runs in the desktop app or
// in the test host, which have one; a phone's and a tablet's native app lists remote servers only.
import { Platform } from "react-native";

export const hasThisComputer = (): boolean => Platform.OS === "web";
