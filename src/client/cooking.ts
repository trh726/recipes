import { scaleLine } from '../lib/scaling.js';

function setupCooking() {
  const recipe = document.querySelector<HTMLElement>('.recipe');
  if (!recipe || recipe.dataset.enhanced) return;
  recipe.dataset.enhanced = 'true';
  document.querySelectorAll<HTMLElement>('[data-print], [data-servings-change], [data-factor], .cooking-progress').forEach(el => { el.hidden = false; });
  document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  const base = Number(recipe.dataset.baseServings);
  let servings = base;
  function apply(factor: number) {
    recipe!.querySelectorAll<HTMLElement>('[data-ingredient]').forEach(span => {
      span.textContent = scaleLine(span.dataset.ingredient!, factor);
    });
  }
  recipe.querySelectorAll<HTMLButtonElement>('[data-servings-change]').forEach(button => {
    button.addEventListener('click', () => {
      servings = Math.max(1, servings + Number(button.dataset.servingsChange));
      const count = recipe.querySelector<HTMLElement>('.servings-count')!;
      count.textContent = String(servings);
      count.classList.toggle('scaled', servings !== base);
      count.title = servings === base ? '' : `Originally serves ${recipe.dataset.originalServings}`;
      apply(servings / base);
    });
  });
  recipe.querySelectorAll<HTMLButtonElement>('[data-factor]').forEach(button => {
    button.addEventListener('click', () => {
      recipe.querySelectorAll('[data-factor]').forEach(other => {
        other.classList.toggle('active', other === button);
        other.setAttribute('aria-pressed', String(other === button));
      });
      apply(Number(button.dataset.factor));
    });
  });
  const steps = [...recipe.querySelectorAll<HTMLInputElement>('.steps input')];
  const progress = recipe.querySelector<HTMLElement>('.cooking-progress')!;
  const updateProgress = () => {
    const completed = steps.filter(step => step.checked).length;
    progress.textContent = completed === steps.length ? 'All done. Time to enjoy.' : `${completed} of ${steps.length} steps complete`;
  };
  steps.forEach(step => step.addEventListener('change', updateProgress));
  updateProgress();
}
document.addEventListener('astro:page-load', setupCooking);
