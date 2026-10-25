// The testIDs of the images screens that the phone's viewer adds (package T3-4). The ones that were there before (`image-large`,
// `image-large-pic`, `-name`, `-close`, `-off`, `-backdrop`, `-prev`, `-next`, `msg-images`, `image-thumb*`) are written where they are drawn.
export const IMAGE_TID = {
  /** The line under the name: "Image 1 of 2 · your message". */
  sub: "image-large-sub",
  /** The page dots (dataSet `at`, `count`); not drawn for one image. */
  dots: "image-large-dots",
  /** The bottom row's three actions. */
  share: "image-large-share",
  save: "image-large-save",
  ask: "image-large-ask",
  /** The zoomable layer around the picture (dataSet `zoom`: the scale, "1" at rest). */
  zoom: "image-large-zoom",
} as const;
