### xo-bench-sim, iOS 26.3, simulator, Release build: simulator-iphone17

Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148; 402×723 CSS px at 3x; idle frame 17 ms; 3 repetitions of 4000 ms; messages to the app held back; 2026-10-15T22:30:26.212Z to 2026-10-15T22:35:26.076Z

**large**

| mode | gesture | fps mean (min–max) | vs light | p95 frame ms | janky % |
|---|---|---|---|---|---|
| light | pan | 60.4 (60.4–60.5) |  | 17 (17–17) | 0 (0–0) |
| light | pinch | 60.1 (60.1–60.2) |  | 17 (17–17) | 0 (0–0) |
| dark | pan | 14 (13.9–14.1) | -77% | 78.3 (77.2–80.5) | 96.5 (96.4–96.5) |
| dark | pinch | 13.6 (13.3–13.7) | -77% | 81.4 (80–84) | 98.2 (98.1–98.2) |
| dark-css | pan | 60.4 (60.3–60.4) | within | 17 (17–17) | 0 (0–0) |
| dark-css | pinch | 60.1 (60–60.1) | within | 17 (17–17) | 0 (0–0) |
| dark-none | pan | 60.2 (60.2–60.2) | 0% | 17 (17–17) | 0.1 (0–0.4) |
| dark-none | pinch | 60.1 (60–60.1) | within | 17 (17–17) | 0 (0–0) |
| dark-matrix | pan | 17.2 (16.7–17.6) | -72% | 64.4 (62.5–67.7) | 97.1 (97–97.2) |
| dark-matrix | pinch | 16.9 (16.7–17) | -72% | 63.9 (63–64.7) | 98.5 (98.5–98.5) |

**images**

| mode | gesture | fps mean (min–max) | vs light | p95 frame ms | janky % |
|---|---|---|---|---|---|
| light | pan | 59.9 (59.8–60) |  | 17 (17–17) | 0.4 (0.4–0.4) |
| light | pinch | 59.9 (59.8–60) |  | 17 (17–17) | 0.4 (0.4–0.4) |
| dark | pan | 14 (13.9–14.2) | -77% | 78.4 (76.8–79.3) | 96.4 (96.4–96.5) |
| dark | pinch | 13.8 (13.6–14) | -77% | 77.4 (76–78.6) | 98.2 (98.2–98.2) |
| dark-css | pan | 60 (59.8–60.1) | within | 17 (17–17) | 0.4 (0.4–0.4) |
| dark-css | pinch | 59.9 (59.8–60) | within | 17 (17–17.1) | 0.4 (0.4–0.4) |
| dark-none | pan | 59.9 (59.8–60) | within | 17.3 (17–18) | 0.4 (0.4–0.4) |
| dark-none | pinch | 59.9 (59.8–60) | within | 17 (17–17) | 0.4 (0.4–0.4) |
| dark-matrix | pan | 17.2 (17.1–17.3) | -71% | 63.3 (63–64) | 97.1 (97.1–97.1) |
| dark-matrix | pinch | 17 (16.9–17) | -72% | 62.6 (62–63) | 98.5 (98.5–98.6) |

Command:

```sh
node packages/board-view/dev/bench/device.mjs --simulator --auto --device EB01D4A7-01B6-418A-84E0-AEA7D629CDED --label simulator-iphone17 --timeout-min 40
```
