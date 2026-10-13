import type { CustomModel } from '../proxy';
import { catalogModelSlug, localModelSlug } from './modelCatalog';

/** Resolve saved names first; ambiguous aliases and disabled entries never select another model. */
export function resolveConfiguredSubagentModel(models: CustomModel[], selector: string): CustomModel | undefined {
  const exact = models.find((model) => model.name === selector);
  if (exact) return exact.enabled !== false ? exact : undefined;
  const alias = selector.replace(/^models\//, '');
  const matches = models.filter(
    (model) => catalogModelSlug(model, models) === alias || localModelSlug(model) === alias,
  );
  return matches.length === 1 && matches[0].enabled !== false ? matches[0] : undefined;
}
