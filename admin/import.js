/* Course Importer: converts a Canvas .imscc export into a course-site project
 * folder (data/structure.json + media/). Runs entirely in the browser using
 * the File System Access API. Chrome/Edge only. */
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var logEl = document.getElementById("log");
  var progressEl = document.getElementById("progress");
  var reportEl = document.getElementById("report");
  var logLines = [];

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = "status" + (cls ? " " + cls : "");
  }
  function log(line) {
    logLines.push(line);
    logEl.hidden = false;
    logEl.textContent = logLines.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ================================================================
  // Minimal ZIP reader (uses DecompressionStream, no libraries)
  // ================================================================

  async function inflateRaw(u8, expectedSize) {
    var ds = new DecompressionStream("deflate-raw");
    var writer = ds.writable.getWriter();
    // Feed the input in small chunks so all decompressed output is flushed to
    // the readable side before any "junk after end of stream" error (some zip
    // writers pad the compressed data) can terminate the stream.
    (async function () {
      var STEP = 65536;
      try {
        for (var i = 0; i < u8.length; i += STEP) {
          await writer.write(u8.slice(i, Math.min(i + STEP, u8.length)));
        }
        await writer.close();
      } catch (e) { /* the readable side reports real failures */ }
    })();
    var reader = ds.readable.getReader();
    var chunks = [], total = 0;
    for (;;) {
      var r;
      try {
        r = await reader.read();
      } catch (e) {
        if (expectedSize != null && total === expectedSize) break; // got everything
        throw e;
      }
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.length;
      if (expectedSize != null && total >= expectedSize) {
        reader.cancel().catch(function () {});
        break;
      }
    }
    if (expectedSize != null && total !== expectedSize) {
      throw new Error("Decompressed size mismatch (" + total + " != " + expectedSize + ")");
    }
    var out = new Uint8Array(total);
    var off = 0;
    chunks.forEach(function (c) { out.set(c, off); off += c.length; });
    return out;
  }

  function readZipDirectory(buffer) {
    var view = new DataView(buffer);
    var u8 = new Uint8Array(buffer);
    var td = new TextDecoder("utf-8");

    // find End Of Central Directory record (scan back through the comment area)
    var eocd = -1;
    var min = Math.max(0, buffer.byteLength - 65558);
    for (var i = buffer.byteLength - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record found).");
    var count = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || cdOffset === 0xffffffff) {
      // ZIP64: find the zip64 end-of-central-directory record via its locator
      var loc = eocd - 20;
      if (loc >= 0 && view.getUint32(loc, true) === 0x07064b50) {
        var z64 = Number(view.getBigUint64(loc + 8, true));
        if (view.getUint32(z64, true) === 0x06064b50) {
          count = Number(view.getBigUint64(z64 + 32, true));
          cdOffset = Number(view.getBigUint64(z64 + 48, true));
        }
      }
    }

    var entries = new Map();
    var p = cdOffset;
    for (var n = 0; n < count; n++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var uncompSize = view.getUint32(p + 24, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
      // ZIP64 extended info: the real 64-bit values live in extra field 0x0001,
      // in fixed order, present only for the fields marked 0xffffffff
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        var ep = p + 46 + nameLen, eend = ep + extraLen;
        while (ep + 4 <= eend) {
          var hid = view.getUint16(ep, true), hsz = view.getUint16(ep + 2, true);
          if (hid === 0x0001) {
            var q = ep + 4;
            if (uncompSize === 0xffffffff) { uncompSize = Number(view.getBigUint64(q, true)); q += 8; }
            if (compSize === 0xffffffff) { compSize = Number(view.getBigUint64(q, true)); q += 8; }
            if (localOffset === 0xffffffff) { localOffset = Number(view.getBigUint64(q, true)); q += 8; }
            break;
          }
          ep += 4 + hsz;
        }
      }
      if (!name.endsWith("/")) {
        entries.set(name, { method: method, compSize: compSize, uncompSize: uncompSize, localOffset: localOffset });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }

    async function get(name) {
      var e = entries.get(name);
      if (!e) return null;
      var lo = e.localOffset;
      if (view.getUint32(lo, true) !== 0x04034b50) throw new Error("Corrupt zip local header for " + name);
      var nameLen2 = view.getUint16(lo + 26, true);
      var extraLen2 = view.getUint16(lo + 28, true);
      var start = lo + 30 + nameLen2 + extraLen2;
      var data = u8.subarray(start, start + e.compSize);
      if (e.method === 0) return data;
      if (e.method === 8) return inflateRaw(data, e.uncompSize);
      throw new Error("Unsupported zip compression method " + e.method + " for " + name);
    }
    async function text(name) {
      var data = await get(name);
      return data == null ? null : new TextDecoder("utf-8").decode(data);
    }
    return { names: Array.from(entries.keys()), get: get, text: text, has: function (n) { return entries.has(n); } };
  }

  // ================================================================
  // XML / naming helpers
  // ================================================================

  function parseXml(text) {
    return new DOMParser().parseFromString(text, "text/xml");
  }
  function tagText(parent, tag) {
    var el = parent.getElementsByTagName(tag)[0];
    return el ? el.textContent : "";
  }
  function directChildren(el, tag) {
    var out = [];
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === tag) out.push(c);
    }
    return out;
  }

  function sanitizeSegment(seg) {
    return seg.replace(/[^A-Za-z0-9._]+/g, "-");
  }
  function sanitizePath(rel) {
    return rel.split("/").map(sanitizeSegment).join("/");
  }
  function slugify(s) {
    return String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function isActive(state) {
    return state === "active" || state === "published" || state === "front_page";
  }

  // ================================================================
  // HTML content rewriting ($IMS-CC-FILEBASE$ media, wiki/object refs)
  // ================================================================

  function rewriteHtml(html, ctx) {
    if (!html) return "";
    var doc = new DOMParser().parseFromString(html, "text/html");
    // strip Canvas rich-editor artifacts: upload "loading placeholders" that
    // Canvas sometimes saves into content — their absolutely-positioned,
    // src-less <img> blankets the whole item overlay and blocks all clicks
    doc.body.querySelectorAll("[data-placeholder-for], img:not([src]), img[src='']").forEach(function (el) {
      el.remove();
    });
    doc.body.querySelectorAll("[src], [href]").forEach(function (el) {
      ["src", "href"].forEach(function (attr) {
        var v = el.getAttribute(attr);
        if (!v) return;
        rewriteRef(el, attr, v, ctx);
      });
    });
    return doc.body.innerHTML;
  }

  function rewriteRef(el, attr, v, ctx) {
    var m;
    // media file references — the token can also be embedded inside an
    // absolute Canvas URL (https://canvas…/file_contents/$IMS-CC-FILEBASE$/…)
    m = v.match(/(?:\$IMS-CC-FILEBASE\$|%24IMS-CC-FILEBASE%24)\/?([^?#]*)/);
    if (m) {
      var rest = m[1];
      try { rest = decodeURIComponent(rest); } catch (e) {}
      var mediaPath = "media/web_resources/" + sanitizePath(rest);
      el.setAttribute(attr, mediaPath);
      ctx.mediaRefs.add(mediaPath.slice("media/web_resources/".length));
      return;
    }
    // links to wiki pages by slug (or by page identifier)
    m = v.match(/(?:\$WIKI_REFERENCE\$|%24WIKI_REFERENCE%24)\/pages\/([^?#]+)/);
    if (m) {
      var slug = m[1];
      try { slug = decodeURIComponent(slug); } catch (e) {}
      var pageId = ctx.slugToId[slug] || (ctx.knownIds[slug] ? slug : null);
      if (pageId) {
        el.setAttribute("data-item-ref", pageId);
        el.setAttribute(attr, "#item:" + pageId);
      } else {
        el.setAttribute(attr, "#unresolved-" + slug);
        ctx.unresolved.push("wiki page: " + slug);
      }
      return;
    }
    // links to other course objects by id
    m = v.match(/(?:\$CANVAS_OBJECT_REFERENCE\$|%24CANVAS_OBJECT_REFERENCE%24)\/[a-z_]+\/([^?#\/]+)/);
    if (m) {
      var refId = m[1];
      if (ctx.knownIds[refId]) {
        el.setAttribute("data-item-ref", refId);
        el.setAttribute(attr, "#item:" + refId);
      } else {
        el.setAttribute(attr, "#unresolved-" + refId);
        ctx.unresolved.push("course object: " + refId);
      }
      return;
    }
    // course-level references we can't represent — leave a marker
    if (v.indexOf("$CANVAS_COURSE_REFERENCE$") === 0 || v.indexOf("%24CANVAS_COURSE_REFERENCE%24") === 0) {
      el.setAttribute(attr, "#unresolved-course-reference");
      ctx.unresolved.push("course reference: " + v);
    }
  }

  // ================================================================
  // QTI quiz parsing (classic export + New Quizzes fallback)
  // ================================================================

  function qtiFieldEntry(scope, label) {
    var fields = scope.getElementsByTagName("qtimetadatafield");
    for (var i = 0; i < fields.length; i++) {
      if (tagText(fields[i], "fieldlabel") === label) return tagText(fields[i], "fieldentry");
    }
    return "";
  }

  function collectAnswers(item) {
    // gather correct-answer info from respconditions that award SCORE = 100
    var correctIds = [];   // response_label idents (choice questions)
    var exactValues = [];  // varequal string values (fib / numerical), with respident
    var ranges = [];       // {low, high} from vargte/varlte pairs (numerical)
    var conditions = item.getElementsByTagName("respcondition");
    for (var i = 0; i < conditions.length; i++) {
      var cond = conditions[i];
      var awards = false;
      var setvars = cond.getElementsByTagName("setvar");
      for (var s = 0; s < setvars.length; s++) {
        if (parseFloat(setvars[s].textContent) === 100) { awards = true; break; }
      }
      if (!awards) continue;
      var cv = cond.getElementsByTagName("conditionvar")[0];
      if (!cv) continue;
      var eqs = cv.getElementsByTagName("varequal");
      for (var e = 0; e < eqs.length; e++) {
        var inNot = false;
        for (var a = eqs[e].parentElement; a && a !== cv; a = a.parentElement) {
          if (a.localName === "not") { inNot = true; break; }
        }
        if (!inNot) {
          correctIds.push(eqs[e].textContent);
          exactValues.push({ respident: eqs[e].getAttribute("respident") || "", value: eqs[e].textContent });
        }
      }
      var lows = cv.getElementsByTagName("vargte");
      var lows2 = cv.getElementsByTagName("vargt");
      var highs = cv.getElementsByTagName("varlte");
      var highs2 = cv.getElementsByTagName("varlt");
      var low = lows[0] || lows2[0], high = highs[0] || highs2[0];
      if (low && high && low.textContent !== high.textContent) {
        ranges.push({ low: low.textContent, high: high.textContent });
      }
    }
    return { correctIds: correctIds, exactValues: exactValues, ranges: ranges };
  }

  function renderAcceptedAnswers(values, ranges) {
    var parts = [];
    var seen = {};
    values.forEach(function (v) {
      var t = v.value.trim();
      if (t !== "" && !seen[t]) { seen[t] = 1; parts.push("<code>" + escapeHtml(t) + "</code>"); }
    });
    (ranges || []).forEach(function (r) {
      var t = "between " + r.low + " and " + r.high;
      if (!seen[t]) { seen[t] = 1; parts.push("<code>" + escapeHtml(t) + "</code>"); }
    });
    if (!parts.length) return '<p class="qz-fib"><em>(No accepted answer recorded)</em></p>';
    return '<p class="qz-fib"><strong>Accepted answer(s):</strong> ' + parts.join(", ") + "</p>";
  }

  function convertQtiItem(item, ctx, stats) {
    var title = item.getAttribute("title") || "Question";
    var profile = qtiFieldEntry(item, "cc_profile") || qtiFieldEntry(item, "question_type") || "";
    stats.questionTypes[profile || "unknown"] = (stats.questionTypes[profile || "unknown"] || 0) + 1;

    var qtextEl = null;
    var pres = item.getElementsByTagName("presentation")[0];
    if (pres) {
      var mats = directChildren(pres, "material");
      if (mats.length) {
        var mt = mats[0].getElementsByTagName("mattext")[0];
        if (mt) qtextEl = mt;
      }
    }
    var qtext = qtextEl ? rewriteHtml(qtextEl.textContent, ctx) : "";

    var answers = collectAnswers(item);
    var answerHtml = "";

    var isChoice = /multiple_choice|true_false|multiple_response|multiple_answers/.test(profile);
    var isFib = /cc\.fib|short_answer|fill_in_multiple_blanks/.test(profile);
    var isNumeric = /numerical/.test(profile);
    var isEssay = /essay/.test(profile);
    var isUpload = /file_upload/.test(profile);
    var isTextOnly = /text_only/.test(profile);

    if (isChoice || (!profile && item.getElementsByTagName("render_choice").length)) {
      var correctSet = {};
      answers.correctIds.forEach(function (id) { correctSet[id] = 1; });
      var lis = [];
      var labels = item.getElementsByTagName("response_label");
      for (var i = 0; i < labels.length; i++) {
        var ident = labels[i].getAttribute("ident");
        var mt2 = labels[i].getElementsByTagName("mattext")[0];
        var choiceHtml = "";
        if (mt2) {
          choiceHtml = (mt2.getAttribute("texttype") === "text/html")
            ? rewriteHtml(mt2.textContent, ctx)
            : escapeHtml(mt2.textContent);
        }
        var correct = !!correctSet[ident];
        lis.push('<li class="qz-choice' + (correct ? " qz-correct" : "") + '"><span class="qz-mark">' +
          (correct ? "&#10003;" : "") + "</span> " + choiceHtml + "</li>");
      }
      answerHtml = '<ul class="qz-choices">\n' + lis.join("\n") + "\n</ul>";
    } else if (isFib || isNumeric || (!profile && item.getElementsByTagName("render_fib").length)) {
      answerHtml = renderAcceptedAnswers(answers.exactValues, answers.ranges);
    } else if (isEssay) {
      answerHtml = '<p class="qz-fib"><em>(No accepted answer recorded)</em></p>';
    } else if (isUpload) {
      answerHtml = '<p class="qz-fib"><em>(File upload submission)</em></p>';
    } else if (isTextOnly) {
      answerHtml = "";
    } else {
      answerHtml = answers.correctIds.length
        ? renderAcceptedAnswers(answers.exactValues, answers.ranges)
        : "";
    }

    return '<div class="qz-question"><h3 class="qz-qtitle">' + escapeHtml(title) + "</h3>\n" +
      '<div class="qz-qtext">' + qtext + "</div>\n" +
      (answerHtml ? answerHtml + "\n" : "") + "</div>";
  }

  async function convertQuiz(zip, id, ctx, stats) {
    var metaText = await zip.text(id + "/assessment_meta.xml");
    var meta = metaText ? parseXml(metaText) : null;
    var title = meta ? tagText(meta, "title") : "";
    var points = meta ? tagText(meta, "points_possible") : "";
    var description = meta ? tagText(meta, "description") : "";
    var available = meta ? tagText(meta, "available") : "";

    var timeLimit = meta ? tagText(meta, "time_limit") : "";
    var quizState = meta ? tagText(meta, "workflow_state") : "";

    var qtiText = await zip.text(id + "/assessment_qti.xml");
    var doc = qtiText ? parseXml(qtiText) : null;
    var items = doc ? doc.getElementsByTagName("item") : [];
    var source = "classic";
    if (!items.length) {
      var altText = await zip.text("non_cc_assessments/" + id + ".xml.qti");
      if (altText) {
        var altDoc = parseXml(altText);
        var altItems = altDoc.getElementsByTagName("item");
        if (altItems.length) {
          items = altItems;
          source = "new-quizzes";
          if (!title) title = (altDoc.getElementsByTagName("assessment")[0] || {}).getAttribute
            ? (altDoc.getElementsByTagName("assessment")[0].getAttribute("title") || "") : "";
          stats.recoveredQuizzes.push(title || id);
        }
      }
    }

    var questionHtml = [];
    for (var i = 0; i < items.length; i++) {
      questionHtml.push(convertQtiItem(items[i], ctx, stats));
    }
    stats.questions += items.length;

    var metaParts = [];
    if (points) metaParts.push('<span class="meta-points"><strong>Points:</strong> ' + escapeHtml(points) + "</span>");
    if (timeLimit && parseFloat(timeLimit) > 0) {
      metaParts.push('<span class="meta-time"><strong>Time limit:</strong> ' + escapeHtml(timeLimit) + " minutes</span>");
    }
    var parts = [];
    if (metaParts.length) parts.push('<div class="item-meta">' + metaParts.join(" &middot; ") + "</div>");
    if (description) parts.push(rewriteHtml(description, ctx));
    if (!items.length) {
      parts.push('<p class="qz-note"><em>No machine-readable questions found in this quiz export.</em></p>');
    } else {
      parts.push('<div class="qz-questions">\n' + questionHtml.join("\n") + "\n</div>");
    }

    return {
      title: title,
      published: quizState ? isActive(quizState) : (available === "" ? true : available === "true"),
      content_html: parts.join(""),
      source: source,
    };
  }

  // ================================================================
  // Other content converters
  // ================================================================

  function parseWikiPage(htmlText) {
    var doc = new DOMParser().parseFromString(htmlText, "text/html");
    var metas = {};
    doc.querySelectorAll("meta[name]").forEach(function (m) {
      metas[m.getAttribute("name")] = m.getAttribute("content");
    });
    return {
      id: metas.identifier || "",
      workflow_state: metas.workflow_state || "active",
      title: doc.title || "",
      bodyHtml: doc.body ? doc.body.innerHTML : "",
    };
  }

  async function convertAssignment(zip, id, ctx) {
    var settingsText = await zip.text(id + "/assignment_settings.xml");
    var settings = settingsText ? parseXml(settingsText) : null;
    var title = settings ? tagText(settings, "title") : "";
    var points = settings ? tagText(settings, "points_possible") : "";
    var submission = settings ? tagText(settings, "submission_types") : "";
    var ext = settings ? tagText(settings, "allowed_extensions") : "";
    var state = settings ? tagText(settings, "workflow_state") : "active";

    // the assignment body is the .html file that sits next to assignment_settings.xml
    var htmlName = null;
    for (var i = 0; i < zip.names.length; i++) {
      var n = zip.names[i];
      if (n.indexOf(id + "/") === 0 && n.slice(-5) === ".html") { htmlName = n; break; }
    }
    var bodyHtml = "";
    if (htmlName) {
      var doc = new DOMParser().parseFromString(await zip.text(htmlName), "text/html");
      bodyHtml = doc.body ? doc.body.innerHTML : "";
    }

    var metaParts = [];
    if (points) metaParts.push('<span class="meta-points"><strong>Points:</strong> ' + escapeHtml(points) + "</span>");
    if (submission) {
      metaParts.push('<span class="meta-submission"><strong>Submission type:</strong> ' +
        escapeHtml(submission.replace(/_/g, " ")) + "</span>");
    }
    if (ext) metaParts.push('<span class="meta-ext"><strong>Allowed file types:</strong> ' + escapeHtml(ext) + "</span>");
    var metaDiv = metaParts.length ? '<div class="item-meta">' + metaParts.join(" &middot; ") + "</div>" : "";

    return {
      title: title,
      published: isActive(state),
      content_html: metaDiv + rewriteHtml(bodyHtml, ctx),
    };
  }

  async function convertDiscussion(zip, resource, ctx) {
    var fileName = resource.href || (resource.files[0] || "");
    var text = fileName ? await zip.text(fileName) : null;
    if (!text) return null;
    var doc = parseXml(text);
    return {
      title: tagText(doc, "title"),
      published: true,
      content_html: '<div class="item-meta">Discussion Topic</div>' + rewriteHtml(tagText(doc, "text"), ctx),
    };
  }

  // ================================================================
  // The main conversion
  // ================================================================

  async function convertCartridge(buffer, writer, onProgress) {
    var stats = {
      modules: 0, items: 0, kinds: {}, questions: 0, questionTypes: {},
      recoveredQuizzes: [], unresolved: [], mediaFiles: 0, mediaBytes: 0,
      warnings: [],
    };
    var zip = readZipDirectory(buffer);

    // --- manifest: course title, resources, org item -> resource map
    var manifestText = await zip.text("imsmanifest.xml");
    if (!manifestText) throw new Error("imsmanifest.xml not found — is this a Canvas .imscc export?");
    var manifest = parseXml(manifestText);
    var titleEls = manifest.getElementsByTagNameNS("*", "string");
    var siteTitle = titleEls.length ? titleEls[0].textContent.trim() : "Imported Course";

    var resources = {};
    var resEls = manifest.getElementsByTagName("resource");
    for (var i = 0; i < resEls.length; i++) {
      var r = resEls[i];
      var files = [];
      var fileEls = directChildren(r, "file");
      for (var f = 0; f < fileEls.length; f++) files.push(fileEls[f].getAttribute("href"));
      resources[r.getAttribute("identifier")] = {
        type: r.getAttribute("type") || "",
        href: r.getAttribute("href") || "",
        files: files,
      };
    }
    var orgMap = {}; // module-item identifier -> resource id
    var orgItems = manifest.getElementsByTagName("item");
    for (var o = 0; o < orgItems.length; o++) {
      var ref = orgItems[o].getAttribute("identifierref");
      if (ref) orgMap[orgItems[o].getAttribute("identifier")] = ref;
    }

    // --- pre-scan wiki pages (slug map + orphan detection needs ids)
    var wikiBySlug = {}, wikiByResource = {};
    for (var w = 0; w < zip.names.length; w++) {
      var name = zip.names[w];
      if (name.indexOf("wiki_content/") === 0 && name.slice(-5) === ".html") {
        var page = parseWikiPage(await zip.text(name));
        var slug = name.slice("wiki_content/".length, -5);
        page.slug = slug;
        page.zipName = name;
        wikiBySlug[slug] = page;
      }
    }
    // resource id -> wiki page (via manifest href)
    Object.keys(resources).forEach(function (rid) {
      var href = resources[rid].href || (resources[rid].files[0] || "");
      if (href.indexOf("wiki_content/") === 0) {
        var slug = href.slice("wiki_content/".length).replace(/\.html$/, "");
        if (wikiBySlug[slug]) wikiByResource[rid] = wikiBySlug[slug];
      }
    });

    // --- module structure from course_settings/module_meta.xml
    var moduleMetaText = await zip.text("course_settings/module_meta.xml");
    if (!moduleMetaText) throw new Error("course_settings/module_meta.xml not found in the export.");
    var moduleMeta = parseXml(moduleMetaText);

    // slug -> item id map for $WIKI_REFERENCE$ links (id = resource id used in structure)
    var slugToId = {};
    Object.keys(wikiBySlug).forEach(function (slug) {
      // wiki page meta identifier is the id Canvas uses for object references
      slugToId[slug] = wikiBySlug[slug].id;
    });
    Object.keys(wikiByResource).forEach(function (rid) {
      slugToId[wikiByResource[rid].slug] = rid; // prefer the resource id (matches item ids)
    });

    // known ids for $CANVAS_OBJECT_REFERENCE$ (any resource or wiki identifier)
    var knownIds = {};
    Object.keys(resources).forEach(function (rid) { knownIds[rid] = 1; });
    Object.keys(wikiBySlug).forEach(function (slug) { knownIds[wikiBySlug[slug].id] = 1; });

    var ctx = { slugToId: slugToId, knownIds: knownIds, mediaRefs: new Set(), unresolved: stats.unresolved };

    var usedResources = {};
    var structure = { site_title: siteTitle, generated_note: "Source of truth for the admin tool. Edit via the admin tool, not by hand.", modules: [], unfiled: [] };

    // document order in module_meta.xml is the order Canvas displays;
    // the <position> values can be stale, so don't sort by them
    var moduleEls = moduleMeta.getElementsByTagName("module");
    var moduleList = [];
    for (var mi = 0; mi < moduleEls.length; mi++) moduleList.push(moduleEls[mi]);

    for (var mIdx = 0; mIdx < moduleList.length; mIdx++) {
      var modEl = moduleList[mIdx];
      var modTitle = directChildren(modEl, "title")[0] ? directChildren(modEl, "title")[0].textContent : "Module";
      var modState = directChildren(modEl, "workflow_state")[0] ? directChildren(modEl, "workflow_state")[0].textContent : "active";
      var order = mIdx + 1;
      var modSlug = pad2(order) + "-" + slugify(modTitle);
      var mod = {
        id: modEl.getAttribute("identifier"),
        slug: modSlug,
        title: modTitle,
        order: order,
        published: isActive(modState),
        items: [],
      };

      var itemEls = modEl.getElementsByTagName("item");
      var itemList = [];
      for (var ii = 0; ii < itemEls.length; ii++) itemList.push(itemEls[ii]);

      for (var it = 0; it < itemList.length; it++) {
        var itemEl = itemList[it];
        var ctype = tagText(itemEl, "content_type");
        var itemId = itemEl.getAttribute("identifier");
        var itemTitle = tagText(itemEl, "title");
        var itemState = tagText(itemEl, "workflow_state");
        var position = it + 1;
        var resourceId = orgMap[itemId] || tagText(itemEl, "identifierref") || itemId;
        var itemActive = isActive(itemState);
        var out = null;

        if (ctype === "ContextModuleSubHeader") {
          out = { id: "divider-" + modSlug + "-" + position, kind: "divider", title: itemTitle, nav_title: itemTitle, position: position, published: itemActive };
        } else if (ctype === "WikiPage") {
          var pg = wikiByResource[resourceId] || null;
          if (!pg) {
            // fall back: match by wiki meta identifier
            Object.keys(wikiBySlug).some(function (slug) {
              if (wikiBySlug[slug].id === resourceId) { pg = wikiBySlug[slug]; return true; }
              return false;
            });
          }
          out = {
            id: resourceId, kind: "page",
            title: pg ? pg.title : itemTitle, nav_title: itemTitle, position: position,
            published: itemActive && (!pg || isActive(pg.workflow_state)),
            content_html: pg ? rewriteHtml(pg.bodyHtml, ctx) : "",
          };
          if (!pg) stats.warnings.push("Page source not found for: " + itemTitle);
        } else if (ctype === "Assignment") {
          var asn = await convertAssignment(zip, resourceId, ctx);
          out = {
            id: resourceId, kind: "assignment",
            title: asn.title || itemTitle, nav_title: itemTitle, position: position,
            published: itemActive && asn.published,
            content_html: asn.content_html,
          };
        } else if (ctype === "Quizzes::Quiz") {
          var qz = await convertQuiz(zip, resourceId, ctx, stats);
          out = {
            id: resourceId, kind: "quiz",
            title: qz.title || itemTitle, nav_title: itemTitle, position: position,
            published: itemActive && qz.published,
            content_html: qz.content_html,
          };
        } else if (ctype === "DiscussionTopic") {
          var disc = resources[resourceId] ? await convertDiscussion(zip, resources[resourceId], ctx) : null;
          out = {
            id: resourceId, kind: "discussion",
            title: (disc && disc.title) || itemTitle, nav_title: itemTitle, position: position,
            published: itemActive,
            content_html: disc ? disc.content_html : "",
          };
        } else if (ctype === "Attachment") {
          var res = resources[resourceId];
          var srcPath = res ? (res.href || res.files[0] || "") : "";
          var mediaPath = "";
          if (srcPath.indexOf("web_resources/") === 0) {
            mediaPath = "media/web_resources/" + sanitizePath(srcPath.slice("web_resources/".length));
          }
          var fileName = srcPath ? srcPath.split("/").pop() : itemTitle;
          out = { id: resourceId, kind: "file", title: fileName, nav_title: itemTitle, position: position, published: itemActive, media_path: mediaPath };
          if (!mediaPath) stats.warnings.push("File source not found for: " + itemTitle);
        } else if (ctype === "ExternalUrl") {
          var url = tagText(itemEl, "url");
          if (!url && resources[resourceId]) {
            var wlText = await zip.text(resources[resourceId].href || resources[resourceId].files[0]);
            if (wlText) {
              var wl = parseXml(wlText).getElementsByTagName("url")[0];
              if (wl) url = wl.getAttribute("href") || "";
            }
          }
          out = { id: resourceId, kind: "weblink", title: itemTitle, nav_title: itemTitle, position: position, published: itemActive, external_url: url };
        } else if (ctype === "ContextExternalTool") {
          var ltiUrl = tagText(itemEl, "url");
          out = { id: resourceId, kind: "lti", title: itemTitle, nav_title: itemTitle, position: position, published: itemActive, external_url: ltiUrl };
        } else {
          stats.warnings.push("Unsupported module item type '" + ctype + "': " + itemTitle + " (skipped)");
        }

        if (out) {
          usedResources[resourceId] = 1;
          mod.items.push(out);
          stats.items++;
          stats.kinds[out.kind] = (stats.kinds[out.kind] || 0) + 1;
        }
      }
      structure.modules.push(mod);
      stats.modules++;
    }

    // --- orphans (content in the export that isn't in any module)
    var orphans = [];
    // pages
    Object.keys(wikiBySlug).sort().forEach(function (slug) {
      var pg = wikiBySlug[slug];
      var rid = null;
      Object.keys(wikiByResource).some(function (r) {
        if (wikiByResource[r] === pg) { rid = r; return true; }
        return false;
      });
      var id = rid || pg.id;
      if (usedResources[id] || (rid && usedResources[rid]) || usedResources[pg.id]) return;
      orphans.push({
        id: id, kind: "page", title: pg.title, nav_title: pg.title, position: orphans.length + 1,
        published: isActive(pg.workflow_state),
        content_html: rewriteHtml(pg.bodyHtml, ctx), is_orphan: true,
        _sort: "1" + pg.title.toLowerCase(),
      });
    });
    // assignments
    var seenFolders = {};
    for (var zn = 0; zn < zip.names.length; zn++) {
      var nm = zip.names[zn];
      var am = nm.match(/^(g[0-9a-f]{32})\/assignment_settings\.xml$/);
      if (am && !usedResources[am[1]] && !seenFolders[am[1]]) {
        seenFolders[am[1]] = 1;
        var oa = await convertAssignment(zip, am[1], ctx);
        orphans.push({
          id: am[1], kind: "assignment", title: oa.title, nav_title: oa.title, position: 0,
          published: oa.published, content_html: oa.content_html, is_orphan: true,
          _sort: "2" + (oa.title || "").toLowerCase(),
        });
      }
      var qm = nm.match(/^(g[0-9a-f]{32})\/assessment_meta\.xml$/);
      if (qm && !usedResources[qm[1]] && !seenFolders[qm[1]]) {
        seenFolders[qm[1]] = 1;
        var oq = await convertQuiz(zip, qm[1], ctx, stats);
        orphans.push({
          id: qm[1], kind: "quiz", title: oq.title, nav_title: oq.title, position: 0,
          published: oq.published, content_html: oq.content_html, is_orphan: true,
          _sort: "4" + (oq.title || "").toLowerCase(),
        });
      }
    }
    // discussions (and any unused weblinks)
    for (var rid2 in resources) {
      if (usedResources[rid2]) continue;
      if (resources[rid2].type.indexOf("imsdt") === 0) {
        var od = await convertDiscussion(zip, resources[rid2], ctx);
        if (od) {
          orphans.push({
            id: rid2, kind: "discussion", title: od.title, nav_title: od.title, position: 0,
            published: od.published, content_html: od.content_html, is_orphan: true,
            _sort: "3" + (od.title || "").toLowerCase(),
          });
        }
      }
    }
    orphans.sort(function (a, b) { return a._sort < b._sort ? -1 : 1; });
    orphans.forEach(function (o, idx) { o.position = idx + 1; delete o._sort; });
    structure.unfiled = orphans;
    stats.items += orphans.length;
    orphans.forEach(function (o) { stats.kinds[o.kind] = (stats.kinds[o.kind] || 0) + 1; });

    // --- write structure.json
    await writer.writeText("data/structure.json", JSON.stringify(structure, null, 1));

    // --- extract all media (full library, including unused files)
    var mediaNames = zip.names.filter(function (n) { return n.indexOf("web_resources/") === 0; });
    var writtenPaths = {};
    for (var mf = 0; mf < mediaNames.length; mf++) {
      var src = mediaNames[mf];
      var dst = "media/web_resources/" + sanitizePath(src.slice("web_resources/".length));
      var dstKey = dst.toLowerCase(); // Windows/macOS file systems are case-insensitive
      if (writtenPaths[dstKey]) {
        stats.warnings.push("Media name collision: '" + src + "' and '" + writtenPaths[dstKey] + "' both map to " + dst + " on a case-insensitive file system (the later one wins)");
      }
      writtenPaths[dstKey] = src;
      var bytes = await zip.get(src);
      await writer.writeBinary(dst, bytes);
      stats.mediaFiles++;
      stats.mediaBytes += bytes.length;
      if (onProgress) onProgress(mf + 1, mediaNames.length);
    }

    // referenced media that doesn't exist in the export (broken in Canvas too)
    var mediaSet = {};
    mediaNames.forEach(function (n) { mediaSet[sanitizePath(n.slice("web_resources/".length))] = 1; });
    var missing = [];
    ctx.mediaRefs.forEach(function (ref) { if (!mediaSet[ref]) missing.push(ref); });
    stats.missingMedia = missing.sort();
    stats.unresolved = Array.from(new Set(stats.unresolved));

    return { structure: structure, stats: stats };
  }

  // expose for testing / reuse
  window.CourseImporter = { convertCartridge: convertCartridge, readZipDirectory: readZipDirectory };

  // ================================================================
  // Page UI
  // ================================================================

  var btnFile = document.getElementById("btn-file");
  var btnDest = document.getElementById("btn-dest");
  var btnAdmin = document.getElementById("btn-admin");
  var btnConvert = document.getElementById("btn-convert");
  var fileInfo = document.getElementById("file-info");
  var destInfo = document.getElementById("dest-info");
  var adminInfo = document.getElementById("admin-info");

  var imsccHandle = null;
  var destDir = null;

  if (!window.showDirectoryPicker) {
    setStatus("Unsupported browser", "err");
    [btnFile, btnDest, btnAdmin].forEach(function (b) { b.disabled = true; });
    log("This browser doesn't support the File System Access API. Use Chrome or Edge on desktop.");
  }

  function updateReady() {
    btnConvert.disabled = !(imsccHandle && destDir);
  }

  btnFile.addEventListener("click", async function () {
    try {
      var picks = await window.showOpenFilePicker({
        types: [{ description: "Canvas course export", accept: { "application/zip": [".imscc", ".zip"] } }],
      });
      imsccHandle = picks[0];
      var f = await imsccHandle.getFile();
      fileInfo.textContent = f.name + " (" + (f.size / 1048576).toFixed(1) + " MB)";
      document.getElementById("step-file").classList.add("done");
      updateReady();
    } catch (e) { if (e.name !== "AbortError") log("Error: " + e.message); }
  });

  btnDest.addEventListener("click", async function () {
    try {
      destDir = await window.showDirectoryPicker({ mode: "readwrite" });
      destInfo.textContent = "Selected: " + destDir.name;
      document.getElementById("step-dest").classList.add("done");
      updateReady();
    } catch (e) { if (e.name !== "AbortError") log("Error: " + e.message); }
  });

  async function getDirByPath(root, path, create) {
    var parts = path.split("/").filter(Boolean);
    var dir = root;
    for (var i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    return dir;
  }
  async function writeFileTo(root, path, data) {
    var parts = path.split("/").filter(Boolean);
    var fileName = parts.pop();
    var dir = await getDirByPath(root, parts.join("/"), true);
    var fh = await dir.getFileHandle(fileName, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  btnAdmin.addEventListener("click", async function () {
    if (!destDir) { adminInfo.textContent = "Pick the destination folder (step 2) first."; return; }
    try {
      var srcProject = await window.showDirectoryPicker();
      var srcAdmin = await srcProject.getDirectoryHandle("admin");
      var copied = 0;
      async function copyDir(srcHandle, relPath) {
        for await (var entry of srcHandle.values()) {
          if (entry.kind === "directory") {
            await copyDir(entry, relPath + entry.name + "/");
          } else {
            var file = await entry.getFile();
            await writeFileTo(destDir, relPath + entry.name, await file.arrayBuffer());
            copied++;
          }
        }
      }
      await copyDir(srcAdmin, "admin/");
      adminInfo.textContent = "Copied " + copied + " admin tool file(s) from “" + srcProject.name + "”.";
      document.getElementById("step-admin").classList.add("done");
    } catch (e) {
      if (e.name !== "AbortError") adminInfo.textContent = "Couldn't copy: " + e.message + " (does that folder contain an 'admin' folder?)";
    }
  });

  btnConvert.addEventListener("click", async function () {
    if (!imsccHandle || !destDir) return;
    btnConvert.disabled = true;
    progressEl.hidden = false;
    progressEl.value = 0;
    try {
      setStatus("Reading export…");
      var file = await imsccHandle.getFile();
      var buffer = await file.arrayBuffer();

      setStatus("Converting…");
      var writer = {
        writeText: function (path, text) { return writeFileTo(destDir, path, text); },
        writeBinary: function (path, bytes) { return writeFileTo(destDir, path, bytes); },
      };
      var result = await convertCartridge(buffer, writer, function (done, total) {
        progressEl.value = Math.round(100 * done / total);
        setStatus("Extracting media… " + done + "/" + total);
      });
      var s = result.stats;

      var kindList = Object.keys(s.kinds).sort().map(function (k) { return s.kinds[k] + " " + k + (s.kinds[k] === 1 ? "" : "s"); }).join(", ");
      var html = "<h3>Import complete</h3><ul>" +
        "<li><strong>" + s.modules + "</strong> modules, <strong>" + s.items + "</strong> items (" + kindList + ")</li>" +
        "<li><strong>" + s.questions + "</strong> quiz questions converted</li>" +
        (s.recoveredQuizzes.length ? "<li><strong>" + s.recoveredQuizzes.length + "</strong> quizzes recovered from New Quizzes data: " + s.recoveredQuizzes.map(escapeHtml).join("; ") + "</li>" : "") +
        "<li><strong>" + s.mediaFiles + "</strong> media files (" + (s.mediaBytes / 1048576).toFixed(1) + " MB) extracted</li>" +
        (s.missingMedia.length ? "<li>" + s.missingMedia.length + " referenced file(s) missing from the export (broken in Canvas too): " + s.missingMedia.map(escapeHtml).join(", ") + "</li>" : "") +
        (s.unresolved.length ? "<li>" + s.unresolved.length + " link(s) point at content not in the export (left as #unresolved): " + s.unresolved.map(escapeHtml).join("; ") + "</li>" : "") +
        (s.warnings.length ? "<li>Warnings: " + s.warnings.map(escapeHtml).join("; ") + "</li>" : "") +
        "</ul><p>Next: open <code>admin/index.html</code> in the new folder (or use the admin tool and pick the new folder), " +
        "review the content, then click <strong>Rebuild published site</strong> to generate <code>publish/</code>.</p>";
      reportEl.innerHTML = html;
      reportEl.hidden = false;
      setStatus("Done", "ok");
    } catch (e) {
      setStatus("Import failed", "err");
      log("Error: " + (e && e.message ? e.message : e));
      console.error(e);
    } finally {
      btnConvert.disabled = false;
    }
  });
})();
