/**
 * "Señalar" — injected by Trellai's Vista proxy (vista.ts) into the app's pages.
 *
 * Inside the Vista's iframe it lets Pedro point at an element: hovering outlines it, clicking
 * sends Trellai what an agent needs to find it in the code (its tag, text, a selector, the
 * components around it and their source file when the framework exposes it, its neighbours and
 * styles). It also draws the numbered pins of what he has already pointed at.
 *
 * Messages (postMessage, `source: "trellai-vista"`):
 *   to Trellai:  hello {url} · picked {id, pin, keep} · picking {on}
 *   from Trellai: pick {on} · pins {pins: [{id, n, selector, page}]} · focus {id} · reload
 * Opened outside Trellai (a tab of its own) it does nothing.
 */
(function () {
  if (window.top === window || window.__trellaiVista) return;
  window.__trellaiVista = true;

  var SOURCE = "trellai-vista";
  var ACCENT = "#f43f5e";
  var picking = false;
  var hovered = null;
  var pins = [];
  var picked = {}; // id → element picked in this page
  var host, root, hoverBox, hoverLabel, pinLayer;

  function send(msg) {
    msg.source = SOURCE;
    try {
      window.parent.postMessage(msg, "*");
    } catch (e) {
      /* parent gone */
    }
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay() {
    if (host && host.isConnected) return;
    host = document.createElement("trellai-vista");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>" +
      ".box{position:fixed;border:2px solid " + ACCENT + ";background:rgba(244,63,94,.08);border-radius:3px;pointer-events:none;box-sizing:border-box;transition:all 60ms ease-out}" +
      ".label{position:fixed;font:600 11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:" + ACCENT + ";padding:0 6px;border-radius:3px;white-space:nowrap;pointer-events:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis}" +
      ".pin{position:fixed;border:2px dashed " + ACCENT + ";border-radius:3px;pointer-events:none;box-sizing:border-box}" +
      ".pin b{position:absolute;top:-11px;left:-11px;min-width:20px;height:20px;border-radius:10px;background:" + ACCENT + ";color:#fff;font:700 11px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)}" +
      ".flash{animation:flash .9s ease-out 2}@keyframes flash{50%{background:rgba(244,63,94,.25)}}" +
      "</style>";
    hoverBox = document.createElement("div");
    hoverBox.className = "box";
    hoverLabel = document.createElement("div");
    hoverLabel.className = "label";
    pinLayer = document.createElement("div");
    root.appendChild(pinLayer);
    root.appendChild(hoverBox);
    root.appendChild(hoverLabel);
    hoverBox.style.display = hoverLabel.style.display = "none";
    document.documentElement.appendChild(host);
  }

  function place(el, box) {
    var r = el.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.top + "px";
    box.style.width = Math.max(r.width, 2) + "px";
    box.style.height = Math.max(r.height, 2) + "px";
    return r;
  }

  var cursorStyle = null;
  function setPicking(on) {
    picking = !!on;
    ensureOverlay();
    if (picking && !cursorStyle) {
      cursorStyle = document.createElement("style");
      cursorStyle.textContent = "*{cursor:crosshair!important}";
      (document.head || document.documentElement).appendChild(cursorStyle);
    } else if (!picking && cursorStyle) {
      cursorStyle.remove();
      cursorStyle = null;
    }
    if (!picking) {
      hovered = null;
      hoverBox.style.display = hoverLabel.style.display = "none";
    }
  }

  function isOurs(el) {
    return el === host || (host && host.contains(el));
  }

  function targetOf(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (el && el.nodeType === 1 && !isOurs(el)) return el;
    }
    return null;
  }

  function onMove(e) {
    if (!picking) return;
    var el = targetOf(e);
    if (!el || el === document.documentElement || el === document.body) return;
    hovered = el;
    hoverBox.style.display = hoverLabel.style.display = "block";
    var r = place(el, hoverBox);
    hoverLabel.textContent = shortName(el) + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    hoverLabel.style.left = Math.max(0, r.left) + "px";
    hoverLabel.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 2) + "px";
  }

  function swallow(e) {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!picking) return;
    swallow(e);
    var el = targetOf(e) || hovered;
    if (!el) return;
    var id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    picked[id] = el;
    var pin = describe(el);
    var keep = e.shiftKey;
    if (!keep) setPicking(false);
    exactSource(pin.source).then(function (exact) {
      pin.source = exact;
      send({ type: "picked", id: id, pin: pin, keep: keep });
    });
  }

  function onKey(e) {
    if (picking && e.key === "Escape") {
      swallow(e);
      setPicking(false);
      send({ type: "picking", on: false });
    }
  }

  function typingIn(el) {
    return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
  }

  // With the focus inside the app, Trellai's "s" (Señalar) arrives here: pass it on, unless the
  // app used it or Pedro is typing.
  window.addEventListener("keydown", function (e) {
    if (e.key !== "s" || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (typingIn(document.activeElement)) return;
    e.preventDefault();
    setPicking(!picking);
    send({ type: "picking", on: picking });
  });

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("mousemove", onMove, true);
  ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu", "auxclick", "touchstart", "touchend"].forEach(function (t) {
    window.addEventListener(t, swallow, { capture: true, passive: false });
  });
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);

  // ---------------------------------------------------------------- pins

  function pagePath() {
    return location.pathname + location.search + location.hash;
  }

  function elementOf(p) {
    var el = picked[p.id];
    if (el && el.isConnected) return el;
    try {
      return p.selector ? document.querySelector(p.selector) : null;
    } catch (e) {
      return null;
    }
  }

  var drawing = false;
  function drawPins() {
    ensureOverlay();
    pinLayer.textContent = "";
    var here = pins.filter(function (p) {
      return !p.page || p.page.split("#")[0] === pagePath().split("#")[0];
    });
    here.forEach(function (p) {
      var el = elementOf(p);
      if (!el) return;
      var box = document.createElement("div");
      box.className = "pin";
      box.dataset.id = p.id;
      var badge = document.createElement("b");
      badge.textContent = p.n;
      box.appendChild(badge);
      pinLayer.appendChild(box);
      box.__el = el;
      place(el, box);
    });
    if (!drawing && here.length) {
      drawing = true;
      requestAnimationFrame(follow);
    }
  }

  // Keep the pins on their elements while the page scrolls, resizes or re-renders.
  function follow() {
    if (!pinLayer || !pinLayer.children.length) {
      drawing = false;
      return;
    }
    for (var i = 0; i < pinLayer.children.length; i++) {
      var box = pinLayer.children[i];
      var el = box.__el;
      if (!el || !el.isConnected) {
        var p = pins.filter(function (x) { return x.id === box.dataset.id; })[0];
        el = box.__el = p ? elementOf(p) : null;
      }
      if (el) {
        box.style.display = "block";
        place(el, box);
      } else box.style.display = "none";
    }
    requestAnimationFrame(follow);
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.source !== SOURCE) return;
    if (m.type === "pick") setPicking(m.on);
    else if (m.type === "pins") {
      pins = Array.isArray(m.pins) ? m.pins : [];
      drawPins();
    } else if (m.type === "focus") {
      var p = pins.filter(function (x) { return x.id === m.id; })[0];
      var el = p && elementOf(p);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      var box = pinLayer && pinLayer.querySelector('[data-id="' + m.id + '"]');
      if (box) {
        box.classList.remove("flash");
        void box.offsetWidth;
        box.classList.add("flash");
      }
    } else if (m.type === "reload") location.reload();
  });

  // ---------------------------------------------------------------- describing an element

  function clip(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  function textOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return clip(el.value || el.getAttribute("placeholder") || "", 120);
    if (tag === "img") return clip(el.getAttribute("alt") || "", 120);
    var t = clip(el.innerText || el.textContent || "", 120);
    return t || clip(el.getAttribute("aria-label") || el.getAttribute("title") || "", 120);
  }

  function openTag(el) {
    var out = "<" + el.tagName.toLowerCase();
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (/^(data-reactid|data-v-|data-svelte)/.test(a.name)) continue;
      out += a.value === "" ? " " + a.name : " " + a.name + '="' + clip(a.value, a.name === "class" ? 160 : 80) + '"';
    }
    return clip(out, 300) + ">";
  }

  function stableClasses(el) {
    var list = typeof el.className === "string" ? el.className.split(/\s+/) : [];
    return list.filter(function (c) {
      return c && c.length < 32 && !/[:[\]/()!.@%]/.test(c) && !/^\d/.test(c) && !/^(css|sc|jsx|svelte|emotion)-/.test(c) && !/[a-z0-9]{5,}_[a-z0-9]{4,}/i.test(c);
    });
  }

  function cssString(v) {
    return String(v).replace(/["\\]/g, "\\$&");
  }

  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  function selectorOf(el) {
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 8; depth++) {
      var id = cur.id;
      if (id && /^[A-Za-z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && unique("#" + id)) {
        parts.unshift("#" + id);
        break;
      }
      var part = cur.tagName.toLowerCase();
      var attr = ["data-testid", "data-test", "data-kb", "name", "aria-label", "role"].filter(function (a) {
        return cur.getAttribute(a);
      })[0];
      if (attr) part += "[" + attr + '="' + cssString(clip(cur.getAttribute(attr), 60)) + '"]';
      else {
        var cls = stableClasses(cur).slice(0, 2);
        if (cls.length) part += "." + cls.map(function (c) { return window.CSS && CSS.escape ? CSS.escape(c) : c; }).join(".");
      }
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === cur.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      if (unique(parts.join(" > "))) break;
      cur = parent;
    }
    return parts.join(" > ");
  }

  function shortName(el) {
    var cls = stableClasses(el).slice(0, 2);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
  }

  function fiberOf(el) {
    for (var k in el) if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) return el[k];
    return null;
  }

  function nameOfType(t) {
    if (!t || typeof t === "string") return "";
    if (typeof t === "function") return t.displayName || t.name || "";
    return t.displayName || nameOfType(t.render) || nameOfType(t.type) || "";
  }

  var SKIP = /^(Anonymous|ForwardRef|Memo|Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Context|_c\d*|[a-z])$/;

  function componentsOf(el) {
    var names = [];
    function add(n) {
      if (n && !SKIP.test(n) && names.indexOf(n) < 0 && names.length < 5) names.push(n);
    }
    var f = fiberOf(el);
    // The component whose JSX wrote this element first, then the ones it sits in.
    if (f && f._debugOwner) add(nameOfType(f._debugOwner.type));
    for (var x = f; x && names.length < 5; x = x.return) add(nameOfType(x.type));
    for (var v = el.__vueParentComponent; v && names.length < 5; v = v.parent) add(v.type && (v.type.name || v.type.__name));
    return names;
  }

  /**
   * "/src/App.tsx:~45:12@<module url>" from a stack frame of the app's own code (React 19 keeps one
   * per element). That line is in the code the browser ran; `exactSource` maps it back to the file.
   */
  function frameSource(stack) {
    var lines = String(stack || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)\)?\s*$/);
      if (!m || /node_modules|react-dom|jsx-dev-runtime|react\.development|\/@vite\/|\/@react-refresh|chunk-|\.vite\/deps/.test(m[1])) continue;
      try {
        var u = new URL(m[1]);
        if (u.origin !== location.origin) continue;
        return decodeURIComponent(u.pathname) + ":~" + m[2] + ":" + m[3] + "@" + u.pathname + u.search;
      } catch (e) {
        /* not a URL */
      }
    }
    return "";
  }

  // ---- source maps: the line in the code the browser ran → the line in the file

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function vlq(seg) {
    var out = [];
    var shift = 0;
    var value = 0;
    for (var i = 0; i < seg.length; i++) {
      var d = B64.indexOf(seg.charAt(i));
      if (d < 0) return out;
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        out.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
    }
    return out;
  }

  /** Original line (1-based) for a generated line and column (1-based), or null. */
  function originalLine(map, line, col) {
    var rows = String(map.mappings || "").split(";");
    var oLine = 0;
    var best = null;
    var first = null;
    for (var i = 0; i < rows.length && i < line; i++) {
      var gCol = 0;
      var segs = rows[i] ? rows[i].split(",") : [];
      for (var j = 0; j < segs.length; j++) {
        var v = vlq(segs[j]);
        if (!v.length) continue;
        gCol += v[0];
        if (v.length >= 4) oLine += v[2];
        if (i === line - 1 && v.length >= 4) {
          if (first === null) first = oLine + 1;
          if (gCol <= col - 1) best = oLine + 1;
        }
      }
    }
    return best || first;
  }

  var maps = {};
  function sourceMap(url) {
    if (!maps[url]) {
      maps[url] = fetch(url)
        .then(function (r) { return r.text(); })
        .then(function (code) {
          var inline = code.match(/\/\/# sourceMappingURL=data:application\/json;(?:charset=[^;,]+;)?base64,([A-Za-z0-9+/=]+)\s*$/);
          if (inline) return JSON.parse(decodeURIComponent(escape(atob(inline[1]))));
          var file = code.match(/\/\/# sourceMappingURL=(\S+)\s*$/);
          return file ? fetch(new URL(file[1], location.origin + url).href).then(function (r) { return r.json(); }) : null;
        })
        .catch(function () { return null; });
    }
    return maps[url];
  }

  /** "/src/App.tsx:~45:12@url" → "/src/App.tsx:412" when the module has a source map, else "/src/App.tsx:~45". */
  function exactSource(source) {
    var m = String(source).match(/^(.*):~(\d+):(\d+)@(.*)$/);
    if (!m) return Promise.resolve(source);
    var rough = m[1] + ":~" + m[2];
    var timeout = new Promise(function (done) {
      setTimeout(function () { done(null); }, 1500);
    });
    return Promise.race([sourceMap(m[4]), timeout]).then(
      function (map) {
        var line = map ? originalLine(map, Number(m[2]), Number(m[3])) : null;
        return line ? m[1] + ":" + line : rough;
      },
      function () { return rough; },
    );
  }

  function sourceOf(el) {
    var attr = el.closest && el.closest("[data-insp-path],[data-inspector-relative-path],[data-source]");
    if (attr) {
      var p = attr.getAttribute("data-insp-path") || attr.getAttribute("data-source");
      if (p) return p;
      var rel = attr.getAttribute("data-inspector-relative-path");
      if (rel) return rel + (attr.getAttribute("data-inspector-line") ? ":" + attr.getAttribute("data-inspector-line") : "");
    }
    if (el.__svelte_meta && el.__svelte_meta.loc) {
      var loc = el.__svelte_meta.loc;
      return loc.file + (loc.line != null ? ":" + (loc.line + 1) : "");
    }
    // Where this element (or the nearest element around it) was written in JSX — not past its component.
    for (var f = fiberOf(el); f && typeof f.type === "string"; f = f.return) {
      if (f._debugSource && f._debugSource.fileName) return f._debugSource.fileName + ":" + f._debugSource.lineNumber;
      if (f._debugStack) {
        var s = frameSource(f._debugStack.stack);
        if (s) return s;
      }
    }
    var vue = el.__vueParentComponent;
    if (vue && vue.type && vue.type.__file) return vue.type.__file;
    return "";
  }

  function hex(color) {
    var m = String(color).match(/rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:[,/]\s*([\d.]+%?))?\)/);
    if (!m) return color;
    var a = m[4] == null ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (a === 0) return "transparente";
    var h = "#" + [m[1], m[2], m[3]].map(function (n) {
      return ("0" + Math.round(+n).toString(16)).slice(-2);
    }).join("");
    return a < 1 ? h + " (" + Math.round(a * 100) + "%)" : h;
  }

  function box4(cs, prop) {
    var v = ["Top", "Right", "Bottom", "Left"].map(function (s) {
      return cs[prop + s];
    });
    if (v.every(function (x) { return x === "0px"; })) return "";
    if (v[0] === v[2] && v[1] === v[3]) return v[0] === v[1] ? v[0] : v[0] + " " + v[1];
    return v.join(" ");
  }

  function stylesOf(el) {
    var cs = getComputedStyle(el);
    var out = [];
    if (/flex|grid/.test(cs.display)) {
      var flex = /flex/.test(cs.display);
      out.push(
        (flex ? "flex " + (/column/.test(cs.flexDirection) ? "columna" : "fila") : "grid") +
          (cs.justifyContent && cs.justifyContent !== "normal" ? ", justify " + cs.justifyContent : "") +
          (cs.alignItems && cs.alignItems !== "normal" ? ", align " + cs.alignItems : "") +
          (cs.gap && cs.gap !== "normal" && cs.gap !== "0px" ? ", gap " + cs.gap : ""),
      );
    } else if (cs.display === "none" || cs.display === "inline-block") out.push(cs.display);
    var pad = box4(cs, "padding");
    if (pad) out.push("padding " + pad);
    var mar = box4(cs, "margin");
    if (mar) out.push("margin " + mar);
    out.push("texto " + cs.fontSize + "/" + cs.fontWeight + " " + hex(cs.color));
    var bg = hex(cs.backgroundColor);
    if (bg !== "transparente") out.push("fondo " + bg);
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") out.push("borde " + cs.borderTopWidth + " " + hex(cs.borderTopColor));
    if (cs.borderTopLeftRadius && cs.borderTopLeftRadius !== "0px") out.push("radio " + cs.borderTopLeftRadius);
    if (parseFloat(cs.opacity) < 1) out.push("opacidad " + cs.opacity);
    if (cs.position !== "static") out.push(cs.position);
    return out.join(" · ").replace(/(\d+\.\d+)px/g, function (_, n) {
      return Math.round(parseFloat(n)) + "px";
    });
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function siblingsOf(el) {
    var parent = el.parentElement;
    if (!parent) return "";
    var kids = Array.prototype.filter.call(parent.children, function (k) {
      return k === el || (visible(k) && !isOurs(k));
    });
    if (kids.length < 2) return "";
    var i = kids.indexOf(el);
    var from = Math.max(0, i - 3);
    var to = Math.min(kids.length, i + 4);
    var label = function (k) {
      var t = clip(textOf(k), 24);
      return t || "<" + k.tagName.toLowerCase() + ">";
    };
    var items = kids.slice(from, to).map(function (k) {
      return k === el ? "»" + label(k) + "«" : label(k);
    });
    var cs = getComputedStyle(parent);
    var layout = /flex/.test(cs.display) ? (/column/.test(cs.flexDirection) ? "en columna: " : "en fila: ") : /grid/.test(cs.display) ? "en rejilla: " : "";
    return layout + (from > 0 ? "… · " : "") + items.join(" · ") + (to < kids.length ? " · …" : "");
  }

  function describe(el) {
    var r = el.getBoundingClientRect();
    return {
      page: pagePath(),
      tag: openTag(el),
      text: textOf(el),
      selector: selectorOf(el),
      size: Math.round(r.width) + "×" + Math.round(r.height),
      components: componentsOf(el),
      source: sourceOf(el),
      siblings: siblingsOf(el),
      styles: stylesOf(el),
    };
  }

  // ---------------------------------------------------------------- navigation

  function hello() {
    send({ type: "hello", url: pagePath(), title: document.title });
    if (pins.length) setTimeout(drawPins, 50);
  }
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(hello, 0);
      return r;
    };
  });
  window.addEventListener("popstate", hello);
  window.addEventListener("hashchange", hello);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello);
  else hello();
})();
