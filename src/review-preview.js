// @ts-check

const allowed = new Set([
  "article", "section", "div", "span", "main", "header", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
  "strong", "b", "em", "i", "small", "code", "pre", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd", "table", "caption",
  "thead", "tbody", "tfoot", "tr", "th", "td", "details", "summary",
]);
const discarded = new Set([
  "script", "style", "template", "noscript", "iframe", "frame", "frameset",
  "object", "embed", "svg", "math", "img", "picture", "source", "video", "audio",
  "link", "meta", "base", "input", "button", "select", "textarea",
]);

/**
 * Parse only into inert template content, then rebuild with fresh HTML nodes.
 * No source node or general-purpose source attribute enters the output document.
 * @param {string} html
 */
export function createReviewPreview(html) {
  if (new TextEncoder().encode(html).length > 2 * 1024 * 1024) throw new Error("Report exceeds preview size limit");
  const template = document.createElement("template");
  template.innerHTML = html;
  const output = document.createElement("div");
  let removed = 0;
  let visited = 0;
  /** @param {Node} source @param {Node} target @param {number} depth */
  function copy(source, target, depth) {
    if (++visited > 100000 || depth > 128) throw new Error("Report structure exceeds preview limits; inspect source separately");
    if (source.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(source.textContent ?? ""));
      return;
    }
    if (!(source instanceof HTMLElement)) {
      if (source.nodeType === Node.ELEMENT_NODE) removed++;
      return;
    }
    const tag = source.localName;
    if (discarded.has(tag)) { removed++; return; }
    let destination = target;
    if (allowed.has(tag)) {
      const clean = document.createElement(tag);
      if (tag === "table") {
        clean.setAttribute("border", "1");
        clean.setAttribute("cellpadding", "6");
      }
      if (tag === "details") clean.setAttribute("open", "");
      if (tag === "td" || tag === "th") {
        for (const attribute of ["colspan", "rowspan"]) {
          const value = source.getAttribute(attribute);
          if (value && /^[1-9][0-9]?$/.test(value)) clean.setAttribute(attribute, value);
        }
      }
      target.appendChild(clean);
      destination = clean;
    } else {
      // Links, forms and unknown wrappers retain ordinary text, never behaviour.
      removed++;
    }
    for (const child of Array.from(source.childNodes)) copy(child, destination, depth + 1);
  }
  for (const child of Array.from(template.content.childNodes)) copy(child, output, 0);
  const frame = document.createElement("iframe");
  frame.title = "Rendered report preview";
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>Unapproved report preview</title></head><body>${output.innerHTML}</body></html>`;
  return { frame, removed };
}
