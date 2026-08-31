(function () {
  "use strict";

  var board = document.getElementById("board");
  var courseBar = document.getElementById("course-bar");
  var courseTitle = document.getElementById("course-title");
  var logEl = document.getElementById("log");
  var statusEl = document.getElementById("status");
  var btnOpen = document.getElementById("btn-open");
  var btnSave = document.getElementById("btn-save");
  var btnRebuild = document.getElementById("btn-rebuild");

  var projectDir = null;   // FileSystemDirectoryHandle
  var structure = null;    // parsed data/structure.json
  var dragEl = null;
  var dirty = false;       // unsaved changes on the board
  var mediaListCache = null; // list of image paths under media/, relative to media/

  var CONTENT_KINDS = { page: 1, assignment: 1, quiz: 1, discussion: 1 };
  var IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }
  function log(lines) {
    logEl.hidden = false;
    logEl.textContent = (Array.isArray(lines) ? lines.join("\n") : String(lines));
    logEl.scrollTop = logEl.scrollHeight;
  }
  function markDirty() {
    dirty = true;
    setStatus("Unsaved changes", "");
  }
  window.addEventListener("beforeunload", function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  document.getElementById("course-title").addEventListener("input", function () {
    if (!structure) return;
    structure.site_title = this.value;
    markDirty();
  });

  function newId() {
    if (window.crypto && crypto.randomUUID) return "g" + crypto.randomUUID().replace(/-/g, "");
    var s = "g";
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escAttr(s) { return escapeHtml(s); }

  if (!window.showDirectoryPicker) {
    setStatus("Unsupported browser", "err");
    btnOpen.disabled = true;
    log(["This browser doesn't support the File System Access API.",
         "Please use Chrome or Edge on desktop."]);
  }

  // ---------------- File System Access helpers ----------------

  async function getDirByPath(root, path, create) {
    var parts = path.split("/").filter(Boolean);
    var dir = root;
    for (var i = 0; i < parts.length; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    }
    return dir;
  }

  async function getFileHandleByPath(root, path, create) {
    var parts = path.split("/").filter(Boolean);
    var fileName = parts.pop();
    var dir = await getDirByPath(root, parts.join("/"), create);
    return dir.getFileHandle(fileName, { create: !!create });
  }

  async function readTextFile(root, path) {
    var fh = await getFileHandleByPath(root, path, false);
    var file = await fh.getFile();
    return await file.text();
  }

  async function writeTextFile(root, path, text) {
    var fh = await getFileHandleByPath(root, path, true);
    var w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  async function copyBinaryFile(srcRoot, srcPath, dstRoot, dstPath) {
    var srcFh = await getFileHandleByPath(srcRoot, srcPath, false);
    var file = await srcFh.getFile();
    var buf = await file.arrayBuffer();
    var dstFh = await getFileHandleByPath(dstRoot, dstPath, true);
    var w = await dstFh.createWritable();
    await w.write(buf);
    await w.close();
  }

  async function clearDirectory(dirHandle) {
    var names = [];
    for await (var [name] of dirHandle.entries()) names.push(name);
    for (var i = 0; i < names.length; i++) {
      await dirHandle.removeEntry(names[i], { recursive: true });
    }
  }

  // Resolve a "media/..." reference (possibly URL-encoded) to a File.
  async function getMediaFile(mediaPath) {
    var fh = await getFileHandleByPath(projectDir, decodeURIComponent(mediaPath), false);
    return fh.getFile();
  }

  // ---------------- open project ----------------

  btnOpen.addEventListener("click", async function () {
    try {
      var handle = await window.showDirectoryPicker();
      setStatus("Loading…");
      var text;
      try {
        text = await readTextFile(handle, "data/structure.json");
      } catch (e) {
        setStatus("Not a valid project folder", "err");
        log(["Couldn't find data/structure.json in the folder you picked.",
             "Make sure you selected the project root (the folder that contains 'data', 'media', 'admin', 'publish')."]);
        return;
      }
      projectDir = handle;
      structure = JSON.parse(text);
      mediaListCache = null;
      dirty = false;
      courseTitle.value = structure.site_title || "";
      courseBar.hidden = false;
      renderBoard();
      btnSave.disabled = false;
      btnRebuild.disabled = false;
      setStatus("Loaded: " + (structure.site_title || ""), "ok");
    } catch (e) {
      if (e.name !== "AbortError") {
        setStatus("Failed to open folder", "err");
        log(["Error: " + e.message]);
      }
    }
  });

  // ---------------- render board ----------------

  function iconBtn(label, title, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn" + (cls ? " " + cls : "");
    b.innerHTML = label;
    b.title = title;
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }

  function makeItemRow(item) {
    var li = document.createElement("li");
    li.className = "item-row" + (item.kind === "divider" ? " is-divider" : "");
    li.draggable = true;
    li._item = item; // keep live reference

    var handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "☰";
    li.appendChild(handle);

    var titleInput = document.createElement("input");
    titleInput.className = "item-title-input";
    titleInput.value = item.nav_title || item.title || "";
    titleInput.addEventListener("input", function () { item.nav_title = titleInput.value; markDirty(); });
    li.appendChild(titleInput);

    if (item.kind !== "divider") {
      var kind = document.createElement("span");
      kind.className = "item-kind";
      kind.textContent = item.kind;
      if (item.kind === "page" || item.kind === "assignment") {
        kind.classList.add("item-kind--toggle");
        kind.title = "Click to switch between page and assignment";
        kind.addEventListener("click", function (e) {
          e.stopPropagation();
          item.kind = item.kind === "page" ? "assignment" : "page";
          kind.textContent = item.kind;
          markDirty();
        });
      }
      li.appendChild(kind);
    }

    var actions = document.createElement("span");
    actions.className = "row-actions";

    // private note (saved in the data, stripped from the published site)
    var noteWrap = document.createElement("div");
    noteWrap.className = "item-note";
    noteWrap.hidden = true;
    var noteArea = document.createElement("textarea");
    noteArea.placeholder = "Private note — visible only here in the admin tool, never on the published site.";
    noteArea.value = item.note || "";
    var noteBtn = iconBtn("&#128221;", "Private note (admin only)",
      item.note ? "has-note" : "icon-btn--hover",
      function () {
        noteWrap.hidden = !noteWrap.hidden;
        if (!noteWrap.hidden) noteArea.focus();
      });
    noteArea.addEventListener("input", function () {
      if (noteArea.value.trim()) item.note = noteArea.value;
      else delete item.note;
      noteBtn.classList.toggle("has-note", !!item.note);
      noteBtn.classList.toggle("icon-btn--hover", !item.note);
      markDirty();
    });
    noteWrap.appendChild(noteArea);
    actions.appendChild(noteBtn);
    if (CONTENT_KINDS[item.kind]) {
      actions.appendChild(iconBtn("&#9998;", "Edit content", "", function () { openEditor(item, li); }));
    } else if (item.kind === "weblink") {
      actions.appendChild(iconBtn("&#9998;", "Edit link URL", "", function () {
        var url = window.prompt("Link URL:", item.external_url || "https://");
        if (url) { item.external_url = url; markDirty(); }
      }));
    }
    actions.appendChild(iconBtn("&#10697;", "Duplicate", "icon-btn--hover", function () { duplicateItem(item, li); }));
    actions.appendChild(iconBtn("&#128465;", "Delete", "icon-btn--hover icon-btn--danger", function () { deleteItem(item, li); }));
    li.appendChild(actions);

    if (item.kind !== "divider") {
      var label = document.createElement("label");
      label.className = "switch";
      label.title = "Published";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.published !== false;
      cb.addEventListener("change", function () { item.published = cb.checked; markDirty(); });
      var slider = document.createElement("span");
      slider.className = "slider";
      label.appendChild(cb);
      label.appendChild(slider);
      li.appendChild(label);
    }

    li.appendChild(noteWrap);

    li.addEventListener("dragstart", onDragStart);
    li.addEventListener("dragend", onDragEnd);
    return li;
  }

  function duplicateItem(item, row) {
    var copy = JSON.parse(JSON.stringify(item));
    copy.id = newId();
    var t = (item.nav_title || item.title || "Untitled") + " (copy)";
    copy.nav_title = t;
    copy.title = t;
    row.parentNode.insertBefore(makeItemRow(copy), row.nextSibling);
    markDirty();
  }

  function deleteItem(item, row) {
    var t = item.nav_title || item.title || "this item";
    if (!confirm('Delete "' + t + '"?\n\nIt disappears from the board now and is gone for good once you click Save.')) return;
    row.remove();
    markDirty();
  }

  function makeModuleBox(mod, isUnfiled) {
    var box = document.createElement("section");
    box.className = "module-box" + (isUnfiled ? " unfiled-box" : "");
    box._mod = mod;

    var head = document.createElement("div");
    head.className = "module-box__head";
    if (!isUnfiled) {
      var order = document.createElement("span");
      order.className = "module-box__order";
      order.textContent = "Mod " + mod.order;
      head.appendChild(order);

      var modHandle = document.createElement("span");
      modHandle.className = "drag-handle module-drag-handle";
      modHandle.textContent = "☰";
      modHandle.title = "Drag to reorder modules";
      head.appendChild(modHandle);
    }
    var titleInput = document.createElement("input");
    titleInput.className = "module-title-input";
    titleInput.value = mod.title;
    titleInput.disabled = !!isUnfiled;
    if (!isUnfiled) titleInput.addEventListener("input", function () { mod.title = titleInput.value; markDirty(); });
    head.appendChild(titleInput);

    if (!isUnfiled) {
      var actions = document.createElement("span");
      actions.className = "row-actions";
      actions.appendChild(iconBtn("&#10697;", "Duplicate module", "icon-btn--hover", function () { duplicateModule(box); }));
      actions.appendChild(iconBtn("&#128465;", "Delete module", "icon-btn--hover icon-btn--danger", function () { deleteModule(box); }));
      head.appendChild(actions);

      var label = document.createElement("label");
      label.className = "switch";
      label.title = "Module published";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = mod.published !== false;
      cb.addEventListener("change", function () { mod.published = cb.checked; markDirty(); });
      var slider = document.createElement("span");
      slider.className = "slider";
      label.appendChild(cb);
      label.appendChild(slider);
      head.appendChild(label);
    }
    box.appendChild(head);

    var list = document.createElement("ul");
    list.className = "item-list";
    list.addEventListener("dragover", onListDragOver);
    list.addEventListener("dragleave", onListDragLeave);
    list.addEventListener("drop", function (e) { e.preventDefault(); list.classList.remove("drag-over"); });
    (mod.items || []).forEach(function (it) { list.appendChild(makeItemRow(it)); });
    box.appendChild(list);

    var foot = document.createElement("div");
    foot.className = "module-box__foot";
    var addPage = document.createElement("button");
    addPage.type = "button";
    addPage.className = "add-btn";
    addPage.textContent = "+ Page";
    addPage.addEventListener("click", function () {
      var item = { id: newId(), kind: "page", title: "New Page", nav_title: "New Page", published: false, content_html: "<p></p>" };
      var row = makeItemRow(item);
      list.appendChild(row);
      markDirty();
      openEditor(item, row);
    });
    var addDivider = document.createElement("button");
    addDivider.type = "button";
    addDivider.className = "add-btn";
    addDivider.textContent = "+ Divider";
    addDivider.addEventListener("click", function () {
      var item = { id: newId(), kind: "divider", title: "New Section", nav_title: "New Section", published: true };
      list.appendChild(makeItemRow(item));
      markDirty();
    });
    foot.appendChild(addPage);
    foot.appendChild(addDivider);
    box.appendChild(foot);

    if (!isUnfiled) {
      box.draggable = true;
      box.addEventListener("dragstart", onModuleDragStart);
      box.addEventListener("dragend", onModuleDragEnd);
    }
    return box;
  }

  function duplicateModule(box) {
    collectStructure();
    var mod = box._mod;
    var idx = structure.modules.indexOf(mod);
    if (idx < 0) return;
    var copy = JSON.parse(JSON.stringify(mod));
    copy.id = newId();
    copy.title = mod.title + " (copy)";
    copy.slug = (mod.slug || "module") + "-copy";
    (copy.items || []).forEach(function (it) { it.id = newId(); });
    structure.modules.splice(idx + 1, 0, copy);
    renderBoard();
    markDirty();
  }

  function deleteModule(box) {
    collectStructure();
    var mod = box._mod;
    var idx = structure.modules.indexOf(mod);
    if (idx < 0) return;
    var n = (mod.items || []).length;
    if (!confirm('Delete module "' + mod.title + '" and the ' + n + " item(s) inside it?\n\n" +
      "If you want to keep any of its items, drag them to another module (or Unfiled) first.\n" +
      "This becomes permanent once you click Save.")) return;
    structure.modules.splice(idx, 1);
    renderBoard();
    markDirty();
  }

  function renderBoard() {
    board.innerHTML = "";
    (structure.modules || []).slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (mod) {
      board.appendChild(makeModuleBox(mod, false));
    });
    if (!structure.unfiled) structure.unfiled = [];
    board.appendChild(makeModuleBox({ title: "Unfiled items", items: structure.unfiled }, true));
  }

  // ---------------- drag and drop ----------------

  function onDragStart(e) {
    dragEl = e.currentTarget;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "x"); } catch (err) {}
    setTimeout(function () { dragEl.classList.add("dragging"); }, 0);
  }
  function onDragEnd() {
    if (dragEl) { dragEl.classList.remove("dragging"); markDirty(); }
    dragEl = null;
    document.querySelectorAll(".item-list").forEach(function (l) { l.classList.remove("drag-over"); });
  }
  function onListDragOver(e) {
    e.preventDefault();
    if (!dragEl) return;
    var list = e.currentTarget;
    list.classList.add("drag-over");
    var after = getDragAfterElement(list, e.clientY);
    if (after == null) list.appendChild(dragEl);
    else list.insertBefore(dragEl, after);
  }
  function onListDragLeave(e) { e.currentTarget.classList.remove("drag-over"); }
  function getDragAfterElement(container, y) {
    var rows = Array.prototype.slice.call(container.querySelectorAll(".item-row:not(.dragging)"));
    var closest = { offset: -Infinity, element: null };
    rows.forEach(function (row) {
      var box = row.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset: offset, element: row };
    });
    return closest.element;
  }

  // ---------------- module (card) reordering ----------------

  var dragModuleEl = null;

  function onModuleDragStart(e) {
    // don't hijack drags that started on an item row or its inputs
    if (e.target.closest(".item-row") || e.target.tagName === "INPUT") { e.stopPropagation(); return; }
    dragModuleEl = e.currentTarget;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "m"); } catch (err) {}
    setTimeout(function () { dragModuleEl.classList.add("dragging"); }, 0);
  }
  function onModuleDragEnd() {
    if (dragModuleEl) { dragModuleEl.classList.remove("dragging"); markDirty(); }
    dragModuleEl = null;
  }
  board.addEventListener("dragover", function (e) {
    if (!dragModuleEl) return;
    e.preventDefault();
    var after = getModuleDragAfterElement(board, e.clientY, e.clientX);
    var unfiledBox = board.querySelector(".unfiled-box");
    if (after == null) {
      board.insertBefore(dragModuleEl, unfiledBox || null);
    } else {
      board.insertBefore(dragModuleEl, after);
    }
  });
  function getModuleDragAfterElement(container, y, x) {
    var boxes = Array.prototype.slice.call(container.querySelectorAll(".module-box:not(.unfiled-box):not(.dragging)"));
    var closest = { offset: -Infinity, element: null };
    boxes.forEach(function (box) {
      var rect = box.getBoundingClientRect();
      var offset = y - rect.top - rect.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset: offset, element: box };
    });
    return closest.element;
  }

  // ---------------- collect DOM back into structure ----------------

  function collectStructure() {
    var modules = [];
    var unfiled = [];
    board.querySelectorAll(".module-box").forEach(function (box) {
      var rows = Array.prototype.slice.call(box.querySelectorAll(".item-row"));
      var items = rows.map(function (row) { return row._item; });
      if (box.classList.contains("unfiled-box")) {
        unfiled = items;
      } else {
        var mod = box._mod;
        mod.items = items;
        mod.order = modules.length + 1;
        modules.push(mod);
      }
    });
    structure.modules = modules;
    structure.unfiled = unfiled;
    return structure;
  }

  // ---------------- save ----------------

  btnSave.addEventListener("click", async function () {
    if (!projectDir) return;
    collectStructure();
    setStatus("Saving…");
    try {
      await writeTextFile(projectDir, "data/structure.json", JSON.stringify(structure, null, 1));
      dirty = false;
      setStatus("Saved", "ok");
      log(["Saved data/structure.json."]);
    } catch (e) {
      setStatus("Save failed", "err");
      log(["Error saving: " + e.message]);
    }
  });

  // ---------------- rebuild publish/ ----------------

  var MEDIA_REF_RE = /(?:src|href)="media\/([^"]+)"/g;

  function collectPublished(items, referencedMedia) {
    var out = [];
    (items || []).forEach(function (it) {
      if (it.published === false) return;
      var copy = Object.assign({}, it);
      delete copy.is_orphan;
      delete copy.note; // private admin notes never reach the published site
      if (it.kind === "file" && it.media_path && it.media_path.indexOf("media/") === 0) {
        referencedMedia.add(decodeURIComponent(it.media_path.slice("media/".length)));
      }
      if (it.content_html) {
        var m;
        MEDIA_REF_RE.lastIndex = 0;
        while ((m = MEDIA_REF_RE.exec(it.content_html))) {
          referencedMedia.add(decodeURIComponent(m[1]));
        }
      }
      out.push(copy);
    });
    return out;
  }

  btnRebuild.addEventListener("click", async function () {
    if (!projectDir) return;
    collectStructure();
    var lines = [];
    try {
      setStatus("Saving…");
      await writeTextFile(projectDir, "data/structure.json", JSON.stringify(structure, null, 1));
      lines.push("Saved data/structure.json.");

      setStatus("Rebuilding published site…");
      var referencedMedia = new Set();
      var outModules = [];
      (structure.modules || []).forEach(function (mod) {
        if (mod.published === false) return;
        outModules.push({
          id: mod.id, slug: mod.slug, title: mod.title, order: mod.order,
          items: collectPublished(mod.items, referencedMedia),
        });
      });
      var outUnfiled = collectPublished(structure.unfiled, referencedMedia);
      var outData = { site_title: structure.site_title, modules: outModules, unfiled: outUnfiled };

      var publishDir = await getDirByPath(projectDir, "publish", true);
      await clearDirectory(publishDir);

      var stylesCss = await readTextFile(projectDir, "admin/templates/styles.css");
      var appJs = await readTextFile(projectDir, "admin/templates/app.js");
      var indexTpl = await readTextFile(projectDir, "admin/templates/index.html");

      var dataJsonText = JSON.stringify(outData).replace(/<\/script>/g, "<\\/script>");
      var indexHtml = indexTpl
        .split("__SITE_TITLE__").join(structure.site_title || "")
        .split("__DATA_JSON__").join(dataJsonText);

      await writeTextFile(projectDir, "publish/styles.css", stylesCss);
      await writeTextFile(projectDir, "publish/app.js", appJs);
      await writeTextFile(projectDir, "publish/index.html", indexHtml);
      await writeTextFile(projectDir, "publish/robots.txt",
        "User-agent: *\nDisallow: /\n\n" +
        "User-agent: GPTBot\nDisallow: /\nUser-agent: ChatGPT-User\nDisallow: /\n" +
        "User-agent: CCBot\nDisallow: /\nUser-agent: anthropic-ai\nDisallow: /\n" +
        "User-agent: ClaudeBot\nDisallow: /\nUser-agent: Claude-Web\nDisallow: /\n" +
        "User-agent: Google-Extended\nDisallow: /\nUser-agent: PerplexityBot\nDisallow: /\n" +
        "User-agent: Bytespider\nDisallow: /\nUser-agent: Amazonbot\nDisallow: /\n"
      );

      var copied = 0, missing = [];
      var mediaList = Array.from(referencedMedia).sort();
      for (var i = 0; i < mediaList.length; i++) {
        var relpath = mediaList[i];
        try {
          await copyBinaryFile(projectDir, "media/" + relpath, projectDir, "publish/media/" + relpath);
          copied++;
        } catch (e) {
          missing.push(relpath);
        }
      }

      lines.push("Rebuilt publish/: " + outModules.length + " module(s), " +
        (outModules.reduce(function (n, m) { return n + m.items.length; }, 0) + outUnfiled.length) + " item(s), " +
        copied + " media file(s) copied.");
      if (missing.length) {
        lines.push("Missing media (referenced but not found):");
        missing.forEach(function (m) { lines.push("  - " + m); });
      }
      log(lines);
      dirty = false;
      setStatus("Published site rebuilt", "ok");
    } catch (e) {
      setStatus("Rebuild failed", "err");
      lines.push("Error: " + e.message);
      log(lines);
    }
  });

  // ================================================================
  // Content editor (WYSIWYG with raw-HTML toggle)
  // ================================================================

  var edOverlay = document.getElementById("ed-overlay");
  var edDialog = edOverlay.querySelector(".ed-dialog");
  var edTitle = document.getElementById("ed-title");
  var edKind = document.getElementById("ed-kind");
  var edHtmlToggle = document.getElementById("ed-html-toggle");
  var edToolbar = document.getElementById("ed-toolbar");
  var edBlock = document.getElementById("ed-block");
  var edVisual = document.getElementById("ed-visual");
  var edHtmlArea = document.getElementById("ed-html");
  var edCancel = document.getElementById("ed-cancel");
  var edApply = document.getElementById("ed-apply");

  var editingItem = null, editingRow = null;
  var htmlMode = false;
  var edDirty = false;
  var edObjectUrls = [];
  var savedRange = null;   // last selection range inside the visual editor

  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}
  try { document.execCommand("styleWithCSS", false, false); } catch (e) {}

  document.addEventListener("selectionchange", function () {
    var sel = document.getSelection();
    if (sel.rangeCount && edVisual.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  function restoreSel(range) {
    edVisual.focus();
    var r = range || savedRange;
    if (r) {
      var sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  // Swap "media/..." srcs for blob URLs so images display inside the editor.
  // The original path is kept in data-media-src and restored on serialize.
  async function hydrateMedia(rootEl) {
    var els = rootEl.querySelectorAll("img[src], video[src], audio[src], source[src]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var src = el.getAttribute("src");
      if (!src || src.indexOf("media/") !== 0) continue;
      el.setAttribute("data-media-src", src);
      try {
        var file = await getMediaFile(src);
        var url = URL.createObjectURL(file);
        edObjectUrls.push(url);
        el.setAttribute("src", url);
      } catch (e) { /* file missing: leave the broken src visible */ }
    }
  }

  function serializeEditor() {
    var clone = edVisual.cloneNode(true);
    clone.querySelectorAll("[data-media-src]").forEach(function (el) {
      el.setAttribute("src", el.getAttribute("data-media-src"));
      el.removeAttribute("data-media-src");
    });
    // strip editor-only selection highlights
    clone.querySelectorAll(".ed-target").forEach(function (el) {
      el.classList.remove("ed-target");
      if (!el.getAttribute("class")) el.removeAttribute("class");
    });
    return clone.innerHTML;
  }

  async function openEditor(item, row) {
    editingItem = item;
    editingRow = row;
    edTitle.value = item.nav_title || item.title || "";
    edKind.textContent = item.kind;
    var kindToggleable = item.kind === "page" || item.kind === "assignment";
    edKind.classList.toggle("item-kind--toggle", kindToggleable);
    edKind.title = kindToggleable ? "Click to switch between page and assignment" : "";
    setHtmlMode(false);
    edVisual.innerHTML = item.content_html || "<p></p>";
    edOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    edDirty = false;
    await hydrateMedia(edVisual);
    edVisual.focus();
  }

  function closeEditor() {
    clearEdSelection();
    edOverlay.hidden = true;
    document.body.style.overflow = "";
    edVisual.innerHTML = "";
    edHtmlArea.value = "";
    edObjectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    edObjectUrls = [];
    editingItem = null;
    editingRow = null;
    savedRange = null;
    edDirty = false;
  }

  function requestCloseEditor() {
    if (edDirty && !confirm("Discard unsaved edits to this item?")) return;
    closeEditor();
  }

  function applyEditor() {
    if (!editingItem) return;
    if (htmlMode) edVisual.innerHTML = edHtmlArea.value;
    editingItem.content_html = serializeEditor();
    var t = edTitle.value.trim() || editingItem.title || "Untitled";
    editingItem.nav_title = t;
    if (editingRow) {
      var inp = editingRow.querySelector(".item-title-input");
      if (inp) inp.value = t;
    }
    closeEditor();
    markDirty();
  }

  function setHtmlMode(on) {
    clearEdSelection();
    htmlMode = on;
    if (on) {
      edHtmlArea.value = serializeEditor();
      edVisual.hidden = true;
      edHtmlArea.hidden = false;
      edHtmlArea.focus();
    } else {
      if (!edHtmlArea.hidden) edVisual.innerHTML = edHtmlArea.value;
      edHtmlArea.hidden = true;
      edVisual.hidden = false;
      hydrateMedia(edVisual);
    }
    edToolbar.classList.toggle("disabled", on);
    edHtmlToggle.textContent = on ? "Visual editor" : "</> HTML";
  }

  edKind.addEventListener("click", function () {
    if (!editingItem || (editingItem.kind !== "page" && editingItem.kind !== "assignment")) return;
    editingItem.kind = editingItem.kind === "page" ? "assignment" : "page";
    edKind.textContent = editingItem.kind;
    if (editingRow) {
      var chip = editingRow.querySelector(".item-kind");
      if (chip) chip.textContent = editingItem.kind;
    }
    markDirty();
  });

  edHtmlToggle.addEventListener("click", function () { setHtmlMode(!htmlMode); });
  edCancel.addEventListener("click", requestCloseEditor);
  edApply.addEventListener("click", applyEditor);
  edOverlay.querySelector(".ed-backdrop").addEventListener("click", requestCloseEditor);
  edVisual.addEventListener("input", function () { edDirty = true; });
  edHtmlArea.addEventListener("input", function () { edDirty = true; });
  edTitle.addEventListener("input", function () { edDirty = true; });

  // Keep the editor selection alive when toolbar buttons are clicked.
  edToolbar.addEventListener("mousedown", function (e) {
    if (e.target.closest("button")) e.preventDefault();
  });
  edToolbar.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-cmd]");
    if (!btn || htmlMode) return;
    var cmd = btn.getAttribute("data-cmd");
    if (cmd === "link") return doLink();
    if (cmd === "image") return openMediaPicker();
    if (cmd === "table") return doTable();
    if (cmd === "inlinecode") return doInlineCode();
    edVisual.focus();
    document.execCommand(cmd, false, null);
  });

  edBlock.addEventListener("change", function () {
    var v = edBlock.value;
    edBlock.value = "";
    if (!v || htmlMode) return;
    restoreSel();
    document.execCommand("formatBlock", false, v);
  });

  var edFont = document.getElementById("ed-font");
  var edSize = document.getElementById("ed-size");

  edFont.addEventListener("change", function () {
    var v = edFont.value;
    edFont.value = "";
    if (!v || htmlMode) return;
    restoreSel();
    // styleWithCSS makes this a <span style="font-family:..."> instead of a <font> tag
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("fontName", false, v);
    document.execCommand("styleWithCSS", false, false);
    edDirty = true;
  });

  edSize.addEventListener("change", function () {
    var v = edSize.value;
    edSize.value = "";
    if (!v || htmlMode) return;
    restoreSel();
    // execCommand only knows sizes 1-7, so apply 7 as a marker
    // and swap the resulting <font size="7"> tags for spans with the real size
    document.execCommand("fontSize", false, "7");
    edVisual.querySelectorAll('font[size="7"]').forEach(function (f) {
      var span = document.createElement("span");
      span.style.fontSize = v;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.parentNode.replaceChild(span, f);
    });
    edDirty = true;
  });

  function doLink() {
    var hasText = savedRange && !savedRange.collapsed;
    var url = window.prompt("Link URL:", "https://");
    if (!url) return;
    restoreSel();
    if (hasText) {
      document.execCommand("createLink", false, url);
    } else {
      document.execCommand("insertHTML", false,
        '<a href="' + escAttr(url) + '">' + escapeHtml(url) + "</a>");
    }
    edDirty = true;
  }

  function doTable() {
    var spec = window.prompt("Table size (rows x columns):", "3x3");
    if (!spec) return;
    var m = spec.toLowerCase().match(/(\d+)\s*[x×,\s]\s*(\d+)/);
    if (!m) { alert('Please enter a size like "3x4".'); return; }
    var rows = Math.max(1, Math.min(50, parseInt(m[1], 10)));
    var cols = Math.max(1, Math.min(20, parseInt(m[2], 10)));
    var html = "<table><thead><tr>";
    for (var c = 0; c < cols; c++) html += "<th>Header</th>";
    html += "</tr></thead><tbody>";
    for (var r = 0; r < rows; r++) {
      html += "<tr>";
      for (var c2 = 0; c2 < cols; c2++) html += "<td>&nbsp;</td>";
      html += "</tr>";
    }
    html += "</tbody></table><p></p>";
    restoreSel();
    document.execCommand("insertHTML", false, html);
    edDirty = true;
  }

  function doInlineCode() {
    if (!savedRange || savedRange.collapsed) return; // needs a selection to wrap
    restoreSel();
    var text = document.getSelection().toString();
    document.execCommand("insertHTML", false, "<code>" + escapeHtml(text) + "</code>");
    edDirty = true;
  }

  // ---- image & table size tools ----

  var imgTool = document.getElementById("ed-imgtool");
  var imgToolW = document.getElementById("imgtool-w");
  var tblTool = document.getElementById("ed-tbltool");
  var tblToolW = document.getElementById("tbltool-w");
  var selectedImg = null, selectedTable = null;

  function clearEdSelection() {
    if (selectedImg) selectedImg.classList.remove("ed-target");
    if (selectedTable) selectedTable.classList.remove("ed-target");
    selectedImg = null;
    selectedTable = null;
    imgTool.hidden = true;
    tblTool.hidden = true;
  }

  function positionFloat(panel, target) {
    var dlgRect = edDialog.getBoundingClientRect();
    var rect = target.getBoundingClientRect();
    panel.hidden = false;
    var top = rect.top - dlgRect.top - panel.offsetHeight - 8;
    if (top < 46) top = Math.max(46, rect.top - dlgRect.top + 8); // keep clear of the header
    var left = rect.left - dlgRect.left;
    left = Math.max(8, Math.min(left, dlgRect.width - panel.offsetWidth - 8));
    panel.style.top = top + "px";
    panel.style.left = left + "px";
  }

  edVisual.addEventListener("click", function (e) {
    if (htmlMode) return;
    var img = e.target.closest("img");
    var tbl = e.target.closest("table");
    clearEdSelection();
    if (img) {
      selectedImg = img;
      img.classList.add("ed-target");
      imgToolW.value = Math.round(img.getBoundingClientRect().width);
      positionFloat(imgTool, img);
    } else if (tbl && edVisual.contains(tbl)) {
      selectedTable = tbl;
      tbl.classList.add("ed-target");
      tblToolW.value = tbl.style.width || "";
      positionFloat(tblTool, tbl);
    }
  });
  edVisual.addEventListener("scroll", clearEdSelection);

  // keep clicks on the panels from stealing the editor selection
  [imgTool, tblTool].forEach(function (panel) {
    panel.addEventListener("mousedown", function (e) {
      if (e.target.tagName !== "INPUT") e.preventDefault();
    });
  });

  function setImgWidthPx(px) {
    if (!selectedImg || !(px > 0)) return;
    selectedImg.style.width = "";
    selectedImg.style.height = "";
    selectedImg.setAttribute("width", Math.round(px));
    selectedImg.removeAttribute("height"); // keep the aspect ratio
    edDirty = true;
    positionFloat(imgTool, selectedImg);
  }
  imgToolW.addEventListener("change", function () { setImgWidthPx(parseInt(imgToolW.value, 10)); });
  imgTool.addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn || !selectedImg) return;
    var pct = btn.getAttribute("data-imgpct");
    if (pct) {
      selectedImg.removeAttribute("width");
      selectedImg.removeAttribute("height");
      selectedImg.style.width = pct + "%";
      selectedImg.style.height = "auto";
    } else { // reset
      selectedImg.removeAttribute("width");
      selectedImg.removeAttribute("height");
      selectedImg.style.width = "";
      selectedImg.style.height = "";
    }
    edDirty = true;
    imgToolW.value = Math.round(selectedImg.getBoundingClientRect().width);
    positionFloat(imgTool, selectedImg);
  });

  function setTableWidth(v) {
    if (!selectedTable) return;
    v = (v || "").trim();
    if (/^\d+$/.test(v)) v += "px";
    if (v && !/^\d+(\.\d+)?(px|%)$/.test(v)) return; // ignore junk
    selectedTable.style.width = v;
    edDirty = true;
    positionFloat(tblTool, selectedTable);
  }
  tblToolW.addEventListener("change", function () { setTableWidth(tblToolW.value); });
  document.getElementById("tbltool-100").addEventListener("click", function () { tblToolW.value = "100%"; setTableWidth("100%"); });
  document.getElementById("tbltool-auto").addEventListener("click", function () { tblToolW.value = ""; setTableWidth(""); });
  document.getElementById("tbltool-clear").addEventListener("click", function () {
    if (!selectedTable) return;
    selectedTable.style.width = "";
    selectedTable.removeAttribute("width");
    selectedTable.querySelectorAll("td, th, col").forEach(function (c) {
      c.style.width = "";
      c.removeAttribute("width");
    });
    tblToolW.value = "";
    edDirty = true;
    positionFloat(tblTool, selectedTable);
  });

  // drag a cell's right border to resize that column
  var COL_EDGE = 6;
  var colDrag = null;

  edVisual.addEventListener("mousemove", function (e) {
    if (htmlMode || colDrag) return;
    var cell = e.target.closest("td, th");
    var near = false;
    if (cell && edVisual.contains(cell)) {
      var r = cell.getBoundingClientRect();
      near = Math.abs(r.right - e.clientX) <= COL_EDGE;
    }
    edVisual.classList.toggle("col-resize", near);
  });
  edVisual.addEventListener("mousedown", function (e) {
    if (htmlMode) return;
    var cell = e.target.closest("td, th");
    if (!cell || !edVisual.contains(cell)) return;
    var r = cell.getBoundingClientRect();
    if (Math.abs(r.right - e.clientX) > COL_EDGE) return;
    e.preventDefault();
    colDrag = { table: cell.closest("table"), idx: cell.cellIndex, startX: e.clientX, startW: r.width };
    document.body.classList.add("col-dragging");
  });
  document.addEventListener("mousemove", function (e) {
    if (!colDrag) return;
    var w = Math.max(30, Math.round(colDrag.startW + (e.clientX - colDrag.startX)));
    var rows = colDrag.table.rows;
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].cells[colDrag.idx];
      if (c) c.style.width = w + "px";
    }
  });
  document.addEventListener("mouseup", function () {
    if (!colDrag) return;
    colDrag = null;
    document.body.classList.remove("col-dragging");
    edDirty = true;
    if (selectedTable) positionFloat(tblTool, selectedTable);
  });

  // ---- inserting images ----

  function encodeMediaPath(rel) {
    return "media/" + rel.split("/").map(encodeURIComponent).join("/");
  }

  async function insertMediaImage(rel, range) {
    var enc = encodeMediaPath(rel);
    var src = enc;
    try {
      var file = await getMediaFile("media/" + rel);
      var url = URL.createObjectURL(file);
      edObjectUrls.push(url);
      src = url;
    } catch (e) { /* fall back to the raw path */ }
    restoreSel(range);
    document.execCommand("insertHTML", false,
      '<img src="' + escAttr(src) + '" data-media-src="' + escAttr(enc) + '" alt="' + escAttr(rel.split("/").pop()) + '">');
    edDirty = true;
  }

  function tsName() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function sanitizeName(name) {
    return name.replace(/[^\w.\-() ]+/g, "-").replace(/\s+/g, " ").trim() || ("file-" + tsName());
  }

  async function uniqueUploadName(dir, name) {
    var dot = name.lastIndexOf(".");
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : "";
    var candidate = name, n = 1;
    while (true) {
      try {
        await dir.getFileHandle(candidate, { create: false });
        candidate = base + "-" + (n++) + ext; // exists; try next
      } catch (e) {
        return candidate; // free
      }
    }
  }

  var UPLOAD_DIR = "media/web_resources/Uploaded-Media";

  async function saveToUploads(fileOrBlob, desiredName) {
    var dir = await getDirByPath(projectDir, UPLOAD_DIR, true);
    var name = await uniqueUploadName(dir, sanitizeName(desiredName));
    var fh = await dir.getFileHandle(name, { create: true });
    var w = await fh.createWritable();
    await w.write(await fileOrBlob.arrayBuffer());
    await w.close();
    var rel = UPLOAD_DIR.slice("media/".length) + "/" + name;
    if (mediaListCache && mediaListCache.indexOf(rel) < 0) {
      mediaListCache.push(rel);
      mediaListCache.sort();
    }
    return rel;
  }

  async function insertImageFromFile(file, range) {
    var ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    var name = (file.name && !/^image\.\w+$/i.test(file.name)) ? file.name : ("pasted-" + tsName() + "." + ext);
    var rel = await saveToUploads(file, name);
    await insertMediaImage(rel, range);
  }

  // Paste an image (e.g. a screenshot) straight into the editor:
  // it is saved into media/ and inserted as a normal media reference.
  edVisual.addEventListener("paste", function (e) {
    var files = Array.prototype.slice.call(e.clipboardData && e.clipboardData.files || [])
      .filter(function (f) { return f.type.indexOf("image/") === 0; });
    if (!files.length) return;
    e.preventDefault();
    (async function () {
      for (var i = 0; i < files.length; i++) await insertImageFromFile(files[i], null);
    })().catch(function (err) { log(["Couldn't save pasted image: " + err.message]); });
  });

  edVisual.addEventListener("dragover", function (e) {
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") >= 0) e.preventDefault();
  });
  edVisual.addEventListener("drop", function (e) {
    var files = Array.prototype.slice.call(e.dataTransfer && e.dataTransfer.files || [])
      .filter(function (f) { return f.type.indexOf("image/") === 0; });
    if (!files.length) return;
    e.preventDefault();
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(e.clientX, e.clientY);
    (async function () {
      for (var i = 0; i < files.length; i++) {
        await insertImageFromFile(files[i], i === 0 ? range : null);
      }
    })().catch(function (err) { log(["Couldn't save dropped image: " + err.message]); });
  });

  // ================================================================
  // Media picker
  // ================================================================

  var mpOverlay = document.getElementById("mp-overlay");
  var mpGrid = document.getElementById("mp-grid");
  var mpFilter = document.getElementById("mp-filter");
  var mpUpload = document.getElementById("mp-upload");
  var mpClose = document.getElementById("mp-close");
  var pickerRange = null;
  var pickerUrls = [];
  var thumbObserver = null;

  async function scanMedia() {
    var out = [];
    var mediaDir = await getDirByPath(projectDir, "media", false);
    async function walk(dir, prefix) {
      for await (var [name, handle] of dir.entries()) {
        if (handle.kind === "directory") await walk(handle, prefix + name + "/");
        else if (IMAGE_RE.test(name)) out.push(prefix + name);
      }
    }
    await walk(mediaDir, "");
    out.sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    return out;
  }

  async function openMediaPicker() {
    pickerRange = savedRange ? savedRange.cloneRange() : null;
    mpOverlay.hidden = false;
    mpFilter.value = "";
    if (!mediaListCache) {
      mpGrid.innerHTML = '<p class="mp-note">Scanning media folder…</p>';
      try {
        mediaListCache = await scanMedia();
      } catch (e) {
        mpGrid.innerHTML = '<p class="mp-note">Couldn\'t scan the media folder: ' + escapeHtml(e.message) + "</p>";
        return;
      }
    }
    renderPicker("");
    mpFilter.focus();
  }

  function closeMediaPicker() {
    mpOverlay.hidden = true;
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    pickerUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    pickerUrls = [];
    mpGrid.innerHTML = "";
  }

  var MP_MAX_TILES = 500;

  function renderPicker(filter) {
    if (thumbObserver) thumbObserver.disconnect();
    thumbObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        thumbObserver.unobserve(en.target);
        var img = en.target;
        getMediaFile("media/" + img.dataset.rel).then(function (file) {
          var url = URL.createObjectURL(file);
          pickerUrls.push(url);
          img.src = url;
        }).catch(function () { img.alt = "?"; });
      });
    }, { root: mpGrid, rootMargin: "300px" });

    var f = (filter || "").toLowerCase();
    var matches = (mediaListCache || []).filter(function (rel) { return rel.toLowerCase().indexOf(f) >= 0; });
    mpGrid.innerHTML = "";
    if (!matches.length) {
      mpGrid.innerHTML = '<p class="mp-note">No images match.</p>';
      return;
    }
    matches.slice(0, MP_MAX_TILES).forEach(function (rel) {
      var tile = document.createElement("button");
      tile.type = "button";
      tile.className = "mp-tile";
      tile.title = rel;
      var img = document.createElement("img");
      img.dataset.rel = rel;
      img.alt = "";
      var name = document.createElement("span");
      name.textContent = rel.split("/").pop();
      tile.appendChild(img);
      tile.appendChild(name);
      tile.addEventListener("click", function () {
        closeMediaPicker();
        insertMediaImage(rel, pickerRange);
      });
      mpGrid.appendChild(tile);
      thumbObserver.observe(img);
    });
    if (matches.length > MP_MAX_TILES) {
      var note = document.createElement("p");
      note.className = "mp-note";
      note.textContent = "Showing " + MP_MAX_TILES + " of " + matches.length + " — type in the filter box to narrow down.";
      mpGrid.appendChild(note);
    }
  }

  mpFilter.addEventListener("input", function () { renderPicker(mpFilter.value); });
  mpClose.addEventListener("click", closeMediaPicker);
  mpOverlay.querySelector(".mp-backdrop").addEventListener("click", closeMediaPicker);

  mpUpload.addEventListener("click", async function () {
    try {
      var picks = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"] } }],
      });
      var file = await picks[0].getFile();
      var rel = await saveToUploads(file, file.name);
      closeMediaPicker();
      await insertMediaImage(rel, pickerRange);
    } catch (e) {
      if (e.name !== "AbortError") log(["Upload failed: " + e.message]);
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!mpOverlay.hidden) { closeMediaPicker(); return; }
    if (!edOverlay.hidden) requestCloseEditor();
  });
})();
