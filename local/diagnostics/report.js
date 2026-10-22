(() => {
  "use strict";
  const dialog = document.querySelector("#dialog-filter");
  const search = document.querySelector("#message-filter");
  const count = document.querySelector("#visible-count");
  const empty = document.querySelector("#empty-state");
  const packetRows = [...document.querySelectorAll("#packets tbody tr")];
  const eventRows = [...document.querySelectorAll("#events tbody tr")];

  function filter() {
    const selected = dialog.value;
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    for (const row of packetRows) {
      row.hidden = (selected !== "" && row.dataset.dialog !== selected) ||
        !row.dataset.message.toLowerCase().includes(query);
      if (!row.hidden) visible += 1;
    }
    for (const row of eventRows) {
      row.hidden = selected !== "" && row.dataset.dialog !== selected;
    }
    count.textContent = `${visible} of ${packetRows.length} packets shown`;
    empty.hidden = visible !== 0;
  }

  dialog.addEventListener("change", filter);
  search.addEventListener("input", filter);
  document.querySelector("#reset-filters").addEventListener("click", () => {
    dialog.value = "";
    search.value = "";
    filter();
  });
  filter();
})();
