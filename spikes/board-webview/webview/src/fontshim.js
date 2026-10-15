// Runs before the bundle. Excalidraw loads its fonts with `new FontFace(family, "url(<asset path>/fonts/...woff2)")`.
// The page ships its fonts inside itself (window.__AIWB_FONTS, made by build.mjs: file name -> data: URL), so a
// font address is swapped for its data: URL here and no font is ever fetched. A font that is not shipped (the
// Chinese fallback) gets an empty data: URL: it fails to load and the text falls back, with no network.
(function () {
  window.EXCALIDRAW_ASSET_PATH = "https://aiwb-assets.invalid/";
  var Native = window.FontFace;
  var fonts = window.__AIWB_FONTS || {};
  function swap(src) {
    return String(src).replace(/url\(\s*["']?([^)"']+)["']?\s*\)/g, function (_, u) {
      if (u.indexOf("data:") === 0) return "url(" + u + ")";
      var key = u.replace(/^.*\/fonts\//, "");
      return "url(" + (fonts[key] || "data:font/woff2;base64,") + ")";
    });
  }
  window.FontFace = function (family, source, descriptors) {
    return new Native(family, typeof source === "string" ? swap(source) : source, descriptors);
  };
  window.FontFace.prototype = Native.prototype;
})();
