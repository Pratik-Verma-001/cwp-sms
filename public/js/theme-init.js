/* Theme + logo engine. A classic script (no module) so the theme is applied before first paint. */
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var THEMES = [
    { id: "ember", name: "Ember", note: "Coral, pink and violet", c1: "#FFB067", c2: "#FF2D87", c3: "#9B4DFF", bg: "#0c050f" },
    { id: "aurora", name: "Aurora", note: "Teal and emerald", c1: "#14B8A6", c2: "#22C55E", bg: "#03100d" },
    { id: "solar", name: "Solar", note: "Amber and flame", c1: "#F59E0B", c2: "#EA580C", bg: "#120a02" },
    { id: "orchid", name: "Orchid", note: "Violet and rose", c1: "#A78BFA", c2: "#F472B6", bg: "#0d0720" },
    { id: "ocean", name: "Ocean", note: "Sky and indigo", c1: "#38BDF8", c2: "#6366F1", bg: "#040b1c" },
    { id: "graphite", name: "Graphite", note: "Steel and slate", c1: "#8B8B96", c2: "#52525B", bg: "#060607" },
    { id: "neon", name: "Neon", note: "Lime and cyan", c1: "#84CC16", c2: "#0891B2", bg: "#040a05" },
    { id: "sunset", name: "Sunset", note: "Orange, magenta, violet", c1: "#FB923C", c2: "#D4258F", c3: "#7C3AED", bg: "#11051a" },
    { id: "crimson", name: "Crimson", note: "Rose and wine", c1: "#FB5F7D", c2: "#9F1239", bg: "#12030a" },
    { id: "mocha", name: "Mocha", note: "Latte and espresso", c1: "#D49A66", c2: "#7C4A2D", bg: "#0f0a06" }
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
      out.push(["rect", { width: 64, height: 64, rx: 18, fill: "url(#gl_ember)" }]);
      P("M20 14L38 14L48 24L48 42Q48 46 44 46L30 46L22 53L22 46L20 46Q16 46 16 42L16 18Q16 14 20 14Z", { fill: "url(#bb_ember)" });
      P("M38 14L48 24L38 24Z", { fill: t.c2, "fill-opacity": ".4" });
      C(25.5, 30, 2.7, { fill: t.c1 }); C(32, 30, 2.7, { fill: t.c2 }); C(38.5, 30, 2.7, { fill: t.c3 });
      P("M52 8L53.8 13.2L59 15L53.8 16.8L52 22L50.2 16.8L45 15L50.2 13.2Z", { fill: w });
    } else if (t.id === "aurora") {
      C(32, 32, 32, { fill: g });
      C(32, 32, 32, { fill: "url(#gl_aurora)" });
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
      out.push(["rect", { width: 64, height: 64, rx: 22, fill: "url(#gl_ocean)" }]);
      P("M14 29L51 13L39 49L30 36Z", { fill: w, "fill-opacity": ".97" });
      P("M30 36L51 13", { stroke: t.c2, "stroke-width": 2, "stroke-opacity": ".55", fill: "none" });
      P("M12 54q5-5 10 0t10 0t10 0t10 0", { fill: "none", stroke: w, "stroke-width": 2.6, "stroke-linecap": "round", "stroke-opacity": ".65" });
    } else if (t.id === "neon") {
      out.push(["rect", { width: 64, height: 64, rx: 20, fill: g }]);
      out.push(["rect", { width: 64, height: 64, rx: 20, fill: "url(#gl_neon)" }]);
      P("M37 9L17 36H30L26 55L47 26H34Z", { fill: w, stroke: w, "stroke-width": 2, "stroke-linejoin": "round" });
    } else if (t.id === "sunset") {
      C(32, 32, 32, { fill: g });
      C(32, 32, 32, { fill: "url(#gl_sunset)" });
      P("M20 36a12 12 0 0 1 24 0Z", { fill: w });
      P("M17 41.5H47", { stroke: w, "stroke-width": 3, "stroke-linecap": "round" });
      P("M22 47H42", { stroke: w, "stroke-width": 3, "stroke-linecap": "round", "stroke-opacity": ".8" });
      P("M27 52.5H37", { stroke: w, "stroke-width": 3, "stroke-linecap": "round", "stroke-opacity": ".6" });
    } else if (t.id === "crimson") {
      out.push(["rect", { width: 64, height: 64, rx: 20, fill: g }]);
      out.push(["rect", { width: 64, height: 64, rx: 20, fill: "url(#gl_crimson)" }]);
      P("M32 49C19 40.5 14 33.5 14 26.5A9.5 9.5 0 0 1 32 22.5A9.5 9.5 0 0 1 50 26.5C50 33.5 45 40.5 32 49Z", { fill: w, "fill-opacity": ".97" });
      P("M23 27.5A4.5 4.5 0 0 1 27.5 23", { fill: "none", stroke: t.c1, "stroke-width": 2.4, "stroke-linecap": "round" });
    } else if (t.id === "mocha") {
      C(32, 32, 32, { fill: g });
      C(32, 32, 32, { fill: "url(#gl_mocha)" });
      P("M19 28H43V40Q43 49 34 49H28Q19 49 19 40Z", { fill: w, "fill-opacity": ".97" });
      P("M43 31H46A5 5 0 0 1 46 41H42.5", { fill: "none", stroke: w, "stroke-width": 3.2, "stroke-linecap": "round" });
      P("M26 22Q24 19 26 16M32 23Q30 19 32 15M38 22Q36 19 38 16", { fill: "none", stroke: w, "stroke-width": 2.4, "stroke-linecap": "round", "stroke-opacity": ".75" });
    } else {
      out.push(["rect", { width: 64, height: 64, rx: 16, fill: g }]);
      out.push(["rect", { x: 2.5, y: 2.5, width: 59, height: 59, rx: 14, fill: "none", stroke: w, "stroke-opacity": ".28", "stroke-width": 1.5 }]);
      P("M43 22A14 14 0 1 0 43 42", { fill: "none", stroke: w, "stroke-width": 6.4, "stroke-linecap": "round" });
      C(47, 32, 3.2, { fill: w });
    }
    return out;
  }
  /* Gradients: main fill (3 stops when the theme has c3), a soft top gloss, and the ember bubble fill. */
  function defsOf(t) {
    var D = [], stops = [[0, t.c1], [t.c3 ? 0.55 : 1, t.c2]]; if (t.c3) stops.push([1, t.c3]);
    D.push(["linearGradient", { id: "g_" + t.id, x1: 0, y1: 0, x2: 1, y2: 1 }, stops.map(function (x) { return ["stop", { offset: x[0], "stop-color": x[1] }]; })]);
    D.push(["linearGradient", { id: "gl_" + t.id, x1: 0, y1: 0, x2: 0, y2: 1 }, [["stop", { offset: 0, "stop-color": "#fff", "stop-opacity": ".4" }], ["stop", { offset: 0.5, "stop-color": "#fff", "stop-opacity": "0" }]]]);
    if (t.id === "ember") D.push(["linearGradient", { id: "bb_ember", x1: 0, y1: 0, x2: 0, y2: 1 }, [["stop", { offset: 0, "stop-color": "#fff" }], ["stop", { offset: 1, "stop-color": "#FFE3EE" }]]]);
    return D;
  }
  function el(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function logoNode(cls, id) {
    var t = find(id || current), s = el("svg", { viewBox: "0 0 64 64", "aria-hidden": "true", "data-logo": "1" });
    if (cls) s.setAttribute("class", cls);
    var d = el("defs", {});
    defsOf(t).forEach(function (x) { var n = el(x[0], x[1]); x[2].forEach(function (c) { n.append(el(c[0], c[1])); }); d.append(n); });
    s.append(d);
    shapes(t).forEach(function (x) { s.append(el(x[0], x[1])); });
    return s;
  }
  function logoString(id) {
    var t = find(id || current), body = "";
    shapes(t).forEach(function (x) { body += "<" + x[0]; for (var k in x[1]) body += " " + k + '="' + x[1][k] + '"'; body += "/>"; });
    var defs = "";
    defsOf(t).forEach(function (x) { defs += "<" + x[0]; for (var k in x[1]) defs += " " + k + '="' + x[1][k] + '"'; defs += ">"; x[2].forEach(function (c) { defs += "<" + c[0]; for (var k2 in c[1]) defs += " " + k2 + '="' + c[1][k2] + '"'; defs += "/>"; }); defs += "</" + x[0] + ">"; });
    return '<svg xmlns="' + NS + '" viewBox="0 0 64 64"><defs>' + defs + "</defs>" + body + "</svg>";
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
