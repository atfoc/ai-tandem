# S5: the Markdown libraries on Hermes (AD-75, `[not verified]` of the architecture's stack table)

**Result: the libraries of AD-75 run on Hermes, unchanged.** `unified`, `remark-parse`, `remark-gfm`, `remark-breaks`
(micromark and its Unicode property escapes), `mdast-util-*`, `lowlight` and `highlight.js` with the fourteen grammars
parse, lower and colour every fixture on the app's own Hermes runtime with **the same output, byte for byte, as on
Node** (91 lines: the 38 messages of `src/dev/markdownfixtures.ts` as an answer and as a user's message, and one code
sample of each language and alias family). The fallback of the stack table (`react-native-marked` for native) is not
needed.

## How it was checked

The engine is the one the app ships: `hermesvm.framework` (macosx slice) of the `hermes-engine` pod of RN 0.86.3
(`app/ios/Pods/hermes-engine/destroot` of any worktree that ran `expo prebuild` + `pod install`; the repository has none,
so another worktree's was used). A ten-line host runs a script in it:

```cpp
// host.cpp: clang++ -std=c++17 -I $D/include -F $D/Library/Frameworks/macosx -framework hermesvm \
//             -Wl,-rpath,$D/Library/Frameworks/macosx host.cpp -o host        (D = the pod's destroot)
#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <fstream>
#include <iostream>
#include <sstream>
using namespace facebook;
int main(int argc, char **argv) {
  std::ifstream f(argv[1], std::ios::binary); std::stringstream ss; ss << f.rdbuf();
  auto rt = facebook::hermes::makeHermesRuntime();
  rt->global().setProperty(*rt, "print", jsi::Function::createFromHostFunction(*rt, jsi::PropNameID::forAscii(*rt, "print"), 1,
    [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *a, size_t n) { for (size_t i = 0; i < n; i++) std::cout << a[i].toString(rt).utf8(rt); std::cout << "\n"; return jsi::Value::undefined(); }));
  rt->evaluateJavaScript(std::make_shared<jsi::StringBuffer>(ss.str()), argv[1]);   // source, or Hermes bytecode
}
```

The script is `app/src/dev/markdownselftest.hermes.ts` bundled with **the app's Metro config** (so the app's own transform: same
Babel preset, same module resolution), with nothing of React Native's runtime set to run before it:

```js
// config = getDefaultConfig(appDir) from expo/metro-config; config.watchFolders = [repo root];
// config.serializer.getModulesRunBeforeMainModule = () => []; config.serializer.getPolyfills = () => [];
Metro.runBuild(config, { entry: "app/src/dev/markdownselftest.hermes.ts", platform: "ios", dev: false, minify: false, out });
```

Then `./host out.js` prints the lines; the same bundle compiled by the pod's `hermesc -O -emit-binary` (the release form) and
run as bytecode printed the same lines. `app/test/fixtures/markdown-selftest.json` holds them; `app/test/markdown.hermes.test.ts`
makes Node give them again, so a change of the parser, the lowering or the highlighter fails there until the file is written
(`WRITE=1 node --test --experimental-strip-types test/markdown.hermes.test.ts`) **and the Hermes run is repeated**.
`Unicode property escapes` (`\p{L}`, `\p{P}`, `\p{S}`) work in the regular expressions of micromark.

## What hermesc warned about, and why it does not matter

`URL` (vfile's `urlToPath`, only for a path that is a URL object), `TextDecoder` (micromark's preprocessor, only for a
Uint8Array), `Promise` (unified's async `process`; the app uses `runSync`): all three are paths the app never takes with a
string. `Promise` and `URL` exist in RN anyway; `TextDecoder` does not, and is not reached.

## Cost on the engine (a host without a JIT, an Apple Silicon Mac; a phone is slower)

One message of 1,566 characters (the fixtures joined, one block because of a link definition): parse and lowering 12 ms;
the same again from the kept trees: under 0.01 ms. Parsing is per block and once per text (`prepare`), so an answer that
streams parses only its last block at each chunk.

## Not verified here

The React components (`app/src/screens/markdown/*.tsx`) were drawn and checked in the web build only; they type-check for
native and both platforms' Metro bundles resolve (`expo-clipboard` among them). Nothing was run in the iOS simulator or the
Android emulator: V-track's job. What to look at there: an inline `View` inside a `Text` (the chip, the task box, the
caret), the horizontal `ScrollView` of a code block holding one `Text` that must not wrap, and a table's cells.
