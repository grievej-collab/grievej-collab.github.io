(function () {
  "use strict";

  var dataEl = document.getElementById("site-data");
  var data = JSON.parse(dataEl.textContent);

  var appEl = document.getElementById("app");
  var itemsById = {};

  function collectIndex(items) {
    items.forEach(function (it) { itemsById[it.id] = it; });
  }
  (data.modules || []).forEach(function (m) { collectIndex(m.items || []); });
  collectIndex(data.unfiled || []);

  function kindBadge(kind) {
    var map = { quiz: "Quiz", discussion: "Discussion" };
    return map[kind] || "";
  }

  function itemRowHtml(it) {
    if (it.kind === "divider") {
      return '<li class="divider-row">' + escapeHtml(it.nav_title || it.title) + "</li>";
    }
    if (it.kind === "file") {
      return '<li><a class="item-link" href="' + attr(it.media_path) + '" download>' +
        escapeHtml(it.nav_title || it.title) + '</a><span class="item-icon" title="Downloadable file">&#8681;</span></li>';
    }
    if (it.kind === "weblink" || it.kind === "lti") {
      return '<li><a class="item-link" href="' + attr(it.external_url) + '" target="_blank" rel="noopener">' +
        escapeHtml(it.nav_title || it.title) + '</a><span class="item-icon" title="External link">&#8599;</span></li>';
    }
    // page / assignment / quiz / discussion
    var badge = kindBadge(it.kind);
    return '<li><button type="button" class="item-link kind-' + it.kind + '" data-open-item="' + attr(it.id) + '">' +
      escapeHtml(it.nav_title || it.title) + '</button>' +
      (it.kind === "assignment" ? '<span class="item-icon item-icon--assignment" title="Assignment">&#9998;</span>' : "") +
      (badge ? '<span class="item-badge">' + badge + '</span>' : "") + '</li>';
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function attr(s) { return escapeHtml(s); }

  function moduleCardHtml(m) {
    var collapsed = localStorage.getItem("cs-collapsed-" + m.id) === "1";
    var itemsHtml = (m.items || []).map(itemRowHtml).join("");
    var body = itemsHtml || '<p class="empty-note">No items in this module.</p>';
    return (
      '<section class="module-card' + (collapsed ? " collapsed" : "") + '" data-module-id="' + attr(m.id) + '">' +
        '<div class="module-card__head" data-toggle-module="' + attr(m.id) + '">' +
          '<span class="module-card__chevron">&#9660;</span>' +
          '<span class="module-card__title"><span class="module-card__index">Module ' + m.order + "</span>" + escapeHtml(m.title) + "</span>" +
          '<span class="module-card__count">' + (m.items ? m.items.length : 0) + " item" + ((m.items && m.items.length === 1) ? "" : "s") + "</span>" +
        "</div>" +
        '<div class="module-card__body"><ul class="item-list">' + (m.items && m.items.length ? itemsHtml : '<p class="empty-note">No items in this module.</p>') + "</ul></div>" +
      "</section>"
    );
  }

  function render() {
    var html = "";
    (data.modules || []).forEach(function (m) { html += moduleCardHtml(m); });
    if (data.unfiled && data.unfiled.length) {
      html += moduleCardHtml({ id: "__unfiled__", title: "Unfiled items", order: "", items: data.unfiled });
    }
    appEl.innerHTML = html || '<p class="empty-note">No published content yet.</p>';
  }

  appEl.addEventListener("click", function (e) {
    var toggle = e.target.closest("[data-toggle-module]");
    if (toggle) {
      var card = toggle.closest(".module-card");
      var id = toggle.getAttribute("data-toggle-module");
      var nowCollapsed = !card.classList.contains("collapsed");
      card.classList.toggle("collapsed", nowCollapsed);
      localStorage.setItem("cs-collapsed-" + id, nowCollapsed ? "1" : "0");
      return;
    }
    var opener = e.target.closest("[data-open-item]");
    if (opener) {
      openOverlay(opener.getAttribute("data-open-item"));
    }
  });

  // ---- overlay ----
  var overlay = document.getElementById("item-overlay");
  var overlayTitle = overlay.querySelector(".overlay__title");
  var overlayBody = overlay.querySelector(".overlay__body");
  var lastFocused = null;

  function openOverlay(itemId) {
    var it = itemsById[itemId];
    if (!it) return;
    lastFocused = document.activeElement;
    overlayTitle.textContent = it.nav_title || it.title;
    overlayBody.innerHTML = it.content_html || "<p><em>No content.</em></p>";
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    overlay.querySelector(".overlay__dialog").scrollTop = 0;
    overlayBody.scrollTop = 0;
  }

  function closeOverlay() {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  overlay.addEventListener("click", function (e) {
    if (e.target.hasAttribute("data-close")) closeOverlay();
    var ref = e.target.closest("[data-item-ref]");
    if (ref) {
      e.preventDefault();
      openOverlay(ref.getAttribute("data-item-ref"));
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !overlay.hidden) closeOverlay();
  });

  render();
})();
