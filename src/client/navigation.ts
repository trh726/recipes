import { navigate } from 'astro:transitions/client';

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let restoreSearchFocus = false;
let collectionUrl = "/recipes";

function legacyRedirect() {
  const match = location.hash.match(/^#\/recipe\/([A-Za-z0-9_-]+)$/);
  if (match) { location.replace(`/recipes/${match[1]}`); return true; }
  if (location.hash === '#/') { location.replace('/recipes'); return true; }
  return false;
}
legacyRedirect();
window.addEventListener('hashchange', legacyRedirect);
document.addEventListener('astro:before-preparation', () => {
  clearTimeout(searchTimer);
  if (document.querySelector('#recipe-search')) collectionUrl = location.pathname + location.search;
});
document.addEventListener('astro:page-load', () => {
  const back = document.querySelector<HTMLAnchorElement>('.back-link');
  if (back) back.href = collectionUrl;
  const form = document.querySelector<HTMLFormElement>('#recipe-search');
  const input = form?.querySelector<HTMLInputElement>('input[name="q"]');
  if (restoreSearchFocus && input) { input.focus({ preventScroll: true }); restoreSearchFocus = false; }
  if (form && input) {
    const sort = form.querySelector('select') as unknown as HTMLSelectElement;
    const search = () => {
      restoreSearchFocus = document.activeElement === input;
      const params = new URLSearchParams([...new FormData(form)].map(([key, value]) => [key, String(value)]));
      if (!params.get('q')?.trim()) params.delete('q');
      if (params.get('sort') === 'recent') params.delete('sort');
      void navigate(`/recipes${params.size ? `?${params}` : ''}`, { history: 'replace' });
    };
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      sort.value = 'recent';
      searchTimer = setTimeout(search, 450);
    });
    sort.addEventListener('change', search);
  }
  document.querySelectorAll<HTMLImageElement>('.card-img').forEach(img => {
    img.addEventListener('error', () => img.remove(), { once: true });
    if (img.complete && !img.naturalWidth) img.remove();
  });
});
