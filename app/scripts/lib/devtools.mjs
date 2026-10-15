// Where the Android tools are, shared by the install script (scripts/install.mjs) and the device-test runner (e2e/run.mjs).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function androidHome() { return process.env.ANDROID_HOME || path.join(os.homedir(), "Library/Android/sdk"); }
export function adbPath() { return path.join(androidHome(), "platform-tools/adb"); }

/** A JDK 17 for Gradle: the one the environment names, Homebrew's, Android Studio's, or the system's. Throws when there is none. */
export function jdk17() {
  for (const c of ["/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home", "/Applications/Android Studio.app/Contents/jbr/Contents/Home", "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"]) if (fs.existsSync(path.join(c, "bin/javac"))) return c;
  const r = spawnSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error("no JDK 17 for the Gradle build: set JAVA_HOME (the JRE of .tools cannot compile)");
}
