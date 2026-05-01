// Thin re-export so `import brand from '@/themes'` resolves to the generated barrel.
// brandPlugin regenerates index.generated.ts at each build start.
export { default } from './index.generated';
