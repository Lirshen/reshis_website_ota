(() => {
  "use strict";
  const key = "reshis-avia-theme";
  const root = document.documentElement;
  const button = document.getElementById("theme-toggle");
  if (!button) return;

  function apply(theme) {
    const dark = theme === "dark";
    root.dataset.theme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
    const label = dark ? "Включить светлую тему" : "Включить тёмную тему";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-pressed", String(dark));
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", dark ? "#172631" : "#293f4e");
    window.dispatchEvent(new Event("themechange"));
  }

  button.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(key, next); } catch (error) {}
    apply(next);
  });
  apply(root.dataset.theme === "dark" ? "dark" : "light");
})();
