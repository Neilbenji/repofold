// Restores the interactive behaviors of the wiki chrome in the static site:
// code-copy buttons, sidebar section collapse, toc scroll-spy and reading
// progress, and local mermaid rendering. No network requests, ever.
(function () {
  "use strict";

  // Code copy buttons
  document.querySelectorAll(".codeblock > .copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var pre = btn.parentElement.querySelector("pre");
      if (!pre || !navigator.clipboard) return;
      navigator.clipboard.writeText(pre.innerText).then(function () {
        btn.textContent = "Copied ✓";
        setTimeout(function () {
          btn.textContent = "Copy";
        }, 1600);
      });
    });
  });

  // Sidebar section collapse
  document.querySelectorAll(".wiki-nav-group").forEach(function (group) {
    group.addEventListener("click", function () {
      var wrap = group.parentElement.querySelector(".wiki-nav-children-wrap");
      var caret = group.querySelector(".wiki-nav-caret");
      if (!wrap) return;
      var collapsed = wrap.classList.toggle("collapsed");
      wrap.setAttribute("aria-hidden", String(collapsed));
      group.setAttribute("aria-expanded", String(!collapsed));
      if (caret) caret.classList.toggle("open", !collapsed);
    });
  });

  // Toc scroll-spy + reading progress
  var toc = document.querySelector(".wiki-toc");
  if (toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll("ul a"));
    var headings = links
      .map(function (a) {
        return document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
      })
      .filter(Boolean);
    if (headings.length > 0 && "IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) {
              var id = entries[i].target.id;
              links.forEach(function (a) {
                a.classList.toggle("active", decodeURIComponent(a.getAttribute("href").slice(1)) === id);
              });
              break;
            }
          }
        },
        { rootMargin: "-90px 0px -70% 0px" },
      );
      headings.forEach(function (h) {
        observer.observe(h);
      });
    }
    var bar = toc.querySelector(".wiki-toc-progress .bar > div");
    var label = toc.querySelector(".wiki-toc-progress > span");
    var onScroll = function () {
      var article = document.querySelector(".wiki-article");
      if (!article || !bar) return;
      var rect = article.getBoundingClientRect();
      var total = rect.height - window.innerHeight;
      var scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
      var pct = total > 0 ? Math.round((scrolled / total) * 100) : 100;
      bar.style.width = pct + "%";
      if (label) label.textContent = pct + "%";
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Mermaid diagrams (local bundle; only shipped when a page has a diagram)
  if (window.mermaid) {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral" });
    window.mermaid.run({ querySelector: ".mermaid" });
  }
})();
