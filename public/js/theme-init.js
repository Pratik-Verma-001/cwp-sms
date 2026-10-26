/* Theme + logo engine. A classic script (no module) so the theme is applied before first paint. */
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var THEMES = [
    { id: "ember", name: "Ember", note: "Coral and magenta", c1: "#FF9A62", c2: "#FF2D87", bg: "#0c050f" },
    { id: "aurora", name: "Aurora", note: "Teal and emerald", c1: "#14B8A6", c2: "#22C55E", bg: "#03100d" },
    { id: "solar", name: "Solar", note: "Amber and flame", c1: "#F59E0B", c2: "#EA580C", bg: "#120a02" },
    { id: "orchid", name: "Orchid", note: "Violet and rose", c1: "#A78BFA", c2: "#F472B6", bg: "#0d0720" },
    { id: "ocean", name: "Ocean", note: "Sky and indigo", c1: "#38BDF8", c2: "#6366F1", bg: "#040b1c" },
    { id: "graphite", name: "Graphite", note: "Steel and slate", c1: "#8B8B96", c2: "#52525B", bg: "#060607" }
  ];
  var KEY = "cwp.theme";
  function find(id) { for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i]; return THEMES[0]; }
  function saved() { try { return localStorage.getItem(KEY) || "ember"; } catch (e) { return "ember"; } }
  var current = find(saved()).id;

  /* Each theme has its own logo, not just its own colours. 64x64 grid. */
  function shapes(t) {
    var g = "url(#g_" + t.id + ")", w = "#fff", out = [];
    var P = function (d, a) { out.push(["path", Object.assign({ d: d }, a)]); };
    var C = function (cx, cy, r, a) { out.push(["circle", Object.assign({ cx: cx, cy: cy, r: r }, a)]); };
    if (t.id === "ember") {
      out.push(["rect", { width: 64, height: 64, rx: 18, fill: g }]);
      P("M20 14L38 14L48 24L48 42Q48 46 44 46L30 46L22 53L22 46L20 46Q16 46 16 42L16 18Q16 14 20 14Z", { fill: w, "fill-opacity": ".96" });
      P("M38 14L48 24L38 24Z", { fill: t.c2, "fill-opacity": ".35" });
      C(25.5, 29.3, 2.7, { fill: t.c1 }); C(32, 29.3, 2.7, { fill: "#FF4F6D" }); C(38.5, 29.3, 2.7, { fill: t.c2 });
    } else if (t.id === "aurora") {
      C(32, 32, 32, { fill: g });
      P("M20 37a16 16 0 0 1 24 0", { fill: "none", stroke: w, "stroke-width": 4.2, "stroke-linecap": "round" });
      P("M12 28a28 28 0 0 1 40 0", { fill: "none", stroke: w, "stroke-width": 4.2, "stroke-linecap": "round", "stroke-opacity": ".7" });
      C(32, 45, 4.8, { fill: w });
    } else if (t.id === "solar") {
      P("M32 9L55 32L32 55L9 32Z", { fill: g, stroke: g, "stroke-width": 14, "stroke-linejoin": "round" });
      C(32, 32, 8.5, { fill: w });
      for (var k = 0; k < 8; k++) {
        var a = k * Math.PI / 4, x1 = 32 + Math.cos(a) * 14, y1 = 32 + Math.sin(a) * 14, x2 = 32 + Math.cos(a) * 19.5, y2 = 32 + Math.sin(a) * 19.5;
        P("M" + x1.toFixed(1) + " " + y1.toFixed(1) + "L" + x2.toFixed(1) + " " + y2.toFixed(1), { stroke: w, "stroke-width": 3.2, "stroke-linecap": "round" });
      }
    } else if (t.id === "orchid") {
      P("M32 8L54 20.5V45.5L32 58L10 45.5V20.5Z", { fill: g, stroke: g, "stroke-width": 10, "stroke-linejoin": "round" });
      P("M32 15L37.5 27L50 32L37.5 37L32 49L26.5 37L14 32L26.5 27Z", { fill: w, "fill-opacity": ".96" });
      C(32, 32, 3, { fill: t.c2 });
    } else if (t.id === "ocean") {
      out.push(["rect", { width: 64, height: 64, rx: 22, fill: g }]);
      P("M14 29L51 13L39 49L30 36Z", { fill: w, "fill-opacity": ".97" });
      P("M30 36L51 13", { stroke: t.c2, "stroke-width": 2, "stroke-opacity": ".55", fill: "none" });
      P("M12 54q5-5 10 0t10 0t10 0t10 0", { fill: "none", stroke: w, "stroke-width": 2.6, "stroke-linecap": "round", "stroke-opacity": ".65" });
    } else {
      out.push(["rect", { width: 64, height: 64, rx: 16, fill: g }]);
      out.push(["rect", { x: 2.5, y: 2.5, width: 59, height: 59, rx: 14, fill: "none", stroke: w, "stroke-opacity": ".28", "stroke-width": 1.5 }]);
      P("M43 22A14 14 0 1 0 43 42", { fill: "none", stroke: w, "stroke-width": 6.4, "stroke-linecap": "round" });
      C(47, 32, 3.2, { fill: w });
    }
    return out;
  }
  function el(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function logoNode(cls, id) {
    var t = find(id || current), s = el("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", "data-logo": "1" });
    if (cls) s.setAttribute("class", cls);
    var g = el("linearGradient", { id: "g_" + t.id, x1: 0, y1: 0, x2: 1, y2: 1 });
    g.append(el("stop", { offset: 0, "stop-color": t.c1 }), el("stop", { offset: 1, "stop-color": t.c2 }));
    var d = el("defs", {}); d.append(g); s.append(d);
    shapes(t).forEach(function (x) { s.append(el(x[0], x[1])); });
    return s;
  }
  function logoString(id) {
    var t = find(id || current), body = "";
    shapes(t).forEach(function (x) { body += "<" + x[0]; for (var k in x[1]) body += " " + k + '="' + x[1][k] + '"'; body += "/>"; });
    return '<svg xmlns="' + NS + '" viewBox="0 0 64 64"><defs><linearGradient id="g_' + t.id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + t.c1 + '"/><stop offset="1" stop-color="' + t.c2 + '"/></linearGradient></defs>' + body + "</svg>";
  }
  function chrome() {
    var t = find(current);
    document.documentElement.setAttribute("data-theme", t.id);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", t.bg);
    var l = document.querySelector('link[rel="icon"]');
    if (!l) { l = document.createElement("link"); l.rel = "icon"; l.type = "image/svg+xml"; document.head.append(l); }
    l.type = "image/svg+xml"; l.href = "data:image/svg+xml," + encodeURIComponent(logoString(t.id));
  }
  function repaint() {
    var nodes = document.querySelectorAll("svg[data-logo]");
    for (var i = 0; i < nodes.length; i++) { var n = nodes[i], f = logoNode(n.getAttribute("class") || "", current); n.replaceWith(f); }
  }
  function apply(id) {
    current = find(id).id;
    try { localStorage.setItem(KEY, current); } catch (e) { /* private mode */ }
    chrome(); repaint();
    window.dispatchEvent(new CustomEvent("cwp-theme", { detail: current }));
  }
  window.CWPTheme = { list: THEMES, get: function () { return current; }, find: find, apply: apply, logoNode: logoNode, repaint: repaint };
  chrome();
})();
